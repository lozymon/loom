// Pane detail — read the tail and send input. `read`/`send` are `approve` ops (ADR-0012 rule 3.2):
// the laptop gates them, EXCEPT when this device is trusted (stores/remoteTrust) — then they flow
// with no prompt, which is what makes the live view below usable away from the laptop.
//
// The terminal sticks to the newest output (scrollToEnd) instead of jumping to the top, and
// auto-refreshes every REFRESH_MS once a first read succeeds. Background refreshes are SILENT (no
// "waiting…" flash), and auto-refresh stops if a read is denied so an untrusted device doesn't spam
// the laptop with a Clearance every couple of seconds — the operator taps "Approve & always" once.
//
// Hold-to-talk: press-and-hold the 🎤 to dictate (on-device recognition, expo-speech-recognition) —
// the transcript lands in the compose box for you to review, then Send. Typing shell into a phone is
// the pain this removes; review-before-send is deliberate since a trusted device's send runs at once.

import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import * as ImagePicker from "expo-image-picker";
import type { LanBridgeClient } from "../lib/lanClient";
import type { PaneInfo } from "../protocol";
import { C } from "../theme";

const REFRESH_MS = 2000;

// The keys a TUI prompt needs but a text box can't produce — sent as raw sequences with no trailing
// Enter, so you can navigate arrow menus, toggle multi-selects (Space), and confirm/cancel from the
// phone. This is how you "answer" an interactive prompt remotely: keystrokes, not taps.
const KEYS: { label: string; seq: string }[] = [
  { label: "Esc", seq: "\x1b" },
  { label: "Tab", seq: "\t" },
  { label: "←", seq: "\x1b[D" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "→", seq: "\x1b[C" },
  { label: "␣", seq: " " },
  { label: "⏎", seq: "\r" },
  { label: "^C", seq: "\x03" },
];

export default function PaneScreen({
  client,
  pane,
  onBack,
}: {
  client: LanBridgeClient;
  pane: PaneInfo;
  onBack: () => void;
}) {
  const [tail, setTail] = useState("");
  const [input, setInput] = useState("");
  const [note, setNote] = useState<string | null>(null);
  // Auto-refresh runs only after a good read; a denial/error stops it (avoids Clearance spam).
  const [live, setLive] = useState(false);
  const [listening, setListening] = useState(false);
  // The TUI key row is off by default (most sends are plain text); toggle it from the compose bar.
  const [keysVisible, setKeysVisible] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  // Voice → text. Results (interim + final) stream into the compose box; end/error just drop the
  // listening state. The transcript is left for review, never auto-sent (a trusted send runs at once).
  useSpeechRecognitionEvent("result", (e) => {
    const t = e.results?.[0]?.transcript;
    if (t != null) setInput(t);
  });
  useSpeechRecognitionEvent("end", () => setListening(false));
  useSpeechRecognitionEvent("error", (e) => {
    setNote(`voice: ${e.message || e.error}`);
    setListening(false);
  });

  async function startDictation() {
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        setNote("mic permission denied");
        return;
      }
      setNote(null);
      setListening(true);
      ExpoSpeechRecognitionModule.start({ lang: "en-US", interimResults: true, continuous: false });
    } catch (err) {
      setNote(`voice: ${(err as Error).message}`);
      setListening(false);
    }
  }
  function stopDictation() {
    // Release = stop capturing; the last `result` event has already filled the box for review.
    ExpoSpeechRecognitionModule.stop();
    setListening(false);
  }
  // Make sure a held mic is released if the screen unmounts mid-utterance.
  useEffect(() => () => ExpoSpeechRecognitionModule.stop(), []);

  const read = useCallback(
    async (silent = false) => {
      if (!silent) setNote("waiting for approval on the laptop…");
      try {
        const res = await client.call({ op: "read", target: pane.name, lines: 200 });
        if (res.ok) {
          setTail(((res.data as { text?: string }).text ?? "").trimEnd());
          setNote(null);
          setLive(true);
        } else {
          setNote(res.error);
          setLive(false);
        }
      } catch (e) {
        setNote((e as Error).message);
        setLive(false);
      }
    },
    [client, pane.name],
  );

  useEffect(() => {
    read();
  }, [read]);

  // Live tail: poll silently once reads are flowing. Stops itself if a read stops succeeding.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => read(true), REFRESH_MS);
    return () => clearInterval(t);
  }, [live, read]);

  async function send() {
    const text = input;
    setInput("");
    setNote("sending…");
    try {
      const res = await client.call({ op: "send", target: pane.name, text });
      setNote(res.ok ? null : res.error);
      if (res.ok) setTimeout(() => read(true), 400);
    } catch (e) {
      setNote((e as Error).message);
    }
  }

  // Attach a photo (library or camera) → upload it to the laptop → drop the saved path into the box,
  // so you can add context ("what's this error?") and Send it to an agent that can read the file.
  async function pickImage(fromCamera: boolean) {
    try {
      const perm = fromCamera
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setNote(fromCamera ? "camera permission denied" : "photos permission denied");
        return;
      }
      const opts = { quality: 0.4, base64: true, mediaTypes: ["images"] as ImagePicker.MediaType[] };
      const res = fromCamera
        ? await ImagePicker.launchCameraAsync(opts)
        : await ImagePicker.launchImageLibraryAsync(opts);
      if (res.canceled) return;
      const asset = res.assets[0];
      if (!asset?.base64) {
        setNote("couldn't read that image");
        return;
      }
      setNote("uploading image…");
      const up = await client.call({
        op: "upload",
        target: pane.name,
        filename: asset.fileName ?? "photo.jpg",
        data: asset.base64,
      });
      if (up.ok) {
        setNote(null);
        const path = (up.data as { path?: string }).path ?? "";
        setInput((cur) => (cur.trim() ? cur.trimEnd() + " " : "") + path + " ");
      } else {
        setNote(up.error);
      }
    } catch (e) {
      setNote(`image: ${(e as Error).message}`);
    }
  }

  // Fire a raw key sequence (no trailing Enter) and pull a fresh tail so the menu's new state shows.
  async function sendKey(seq: string) {
    try {
      const res = await client.call({ op: "send", target: pane.name, text: seq, enter: false });
      if (res.ok) setTimeout(() => read(true), 200);
      else setNote(res.error);
    } catch (e) {
      setNote((e as Error).message);
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <Text style={styles.name} numberOfLines={1}>
          <Text style={styles.nameWs}>{pane.workspace} · </Text>
          {pane.name}
        </Text>
        <Pressable onPress={() => read()} hitSlop={12}>
          <Text style={styles.refresh}>↻</Text>
        </Pressable>
      </View>
      <ScrollView
        ref={scrollRef}
        style={styles.term}
        contentContainerStyle={{ padding: 12 }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        <Text style={styles.mono}>{tail || " "}</Text>
      </ScrollView>
      {note && <Text style={styles.note}>{note}</Text>}
      {keysVisible && (
        <View style={styles.keys}>
          {KEYS.map((k) => (
            <Pressable key={k.label} style={styles.key} onPress={() => sendKey(k.seq)} hitSlop={4}>
              <Text style={styles.keyText}>{k.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={styles.composer}>
        {/* Rounded pill: a keys-toggle on the left (show/hide the TUI key row), then the input. */}
        <View style={styles.pill}>
          <Pressable onPress={() => setKeysVisible((v) => !v)} hitSlop={8} style={styles.pillIconBtn}>
            <Text style={[styles.pillIcon, keysVisible && styles.pillIconOn]}>⌨</Text>
          </Pressable>
          <TextInput
            style={styles.pillInput}
            value={input}
            onChangeText={setInput}
            placeholder={listening ? "listening…" : "Message"}
            placeholderTextColor={C.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={send}
            multiline
          />
          {/* Attach + camera — send a photo to an agent (only when there's no text yet, like WhatsApp). */}
          {input.trim().length === 0 && (
            <>
              <Pressable onPress={() => pickImage(false)} hitSlop={8} style={styles.pillIconBtn}>
                <Text style={styles.pillIcon}>📎</Text>
              </Pressable>
              <Pressable onPress={() => pickImage(true)} hitSlop={8} style={styles.pillIconBtn}>
                <Text style={styles.pillIcon}>📷</Text>
              </Pressable>
            </>
          )}
        </View>
        {/* Round action button: mic (hold-to-talk) by default, Send once there's text — like WhatsApp. */}
        {input.trim().length > 0 ? (
          <Pressable style={styles.round} onPress={send}>
            <Text style={styles.roundIcon}>➤</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.round, listening && styles.roundOn]}
            onPressIn={startDictation}
            onPressOut={stopDictation}
          >
            <Text style={styles.roundIcon}>🎤</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.canvas },
  bar: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 14, borderBottomColor: C.hairline, borderBottomWidth: 1 },
  back: { color: C.textDim, fontSize: 30, lineHeight: 30 },
  name: { color: C.textBright, fontSize: 19, fontWeight: "600", flex: 1, fontFamily: "monospace" },
  nameWs: { color: C.textDim, fontWeight: "400" },
  refresh: { color: C.textDim, fontSize: 24 },
  term: { flex: 1, backgroundColor: C.surfaceDead },
  mono: { color: C.textMid, fontFamily: "monospace", fontSize: 13, lineHeight: 19 },
  note: { color: C.needs, fontSize: 13, paddingHorizontal: 14, paddingVertical: 8 },
  // Key row for driving TUIs — one compact strip; keys share the width evenly. The single divider
  // above the input area lives here (the composer no longer has its own top border, which used to
  // draw a stray line right under these keys).
  keys: { flexDirection: "row", gap: 6, paddingHorizontal: 12, paddingTop: 10, borderTopColor: C.hairline, borderTopWidth: 1 },
  key: { flex: 1, minHeight: 42, backgroundColor: C.surface, borderColor: C.hairline, borderWidth: 1, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  keyText: { color: C.textMid, fontSize: 16, fontWeight: "600" },
  // WhatsApp-style compose bar: a rounded pill (keys-toggle + input) and a round action button.
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 10, paddingVertical: 10 },
  pill: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6, minHeight: 52, backgroundColor: C.surface, borderColor: C.hairline, borderWidth: 1, borderRadius: 26, paddingLeft: 10, paddingRight: 14 },
  pillIconBtn: { width: 34, height: 34, alignItems: "center", justifyContent: "center" },
  pillIcon: { fontSize: 20, color: C.textDim },
  pillIconOn: { color: C.accentText },
  pillInput: { flex: 1, color: C.textBright, fontFamily: "monospace", fontSize: 16, paddingVertical: 12, maxHeight: 120 },
  round: { width: 52, height: 52, borderRadius: 26, backgroundColor: C.accent, alignItems: "center", justifyContent: "center" },
  roundOn: { backgroundColor: C.needs },
  roundIcon: { fontSize: 22, color: C.canvas },
});
