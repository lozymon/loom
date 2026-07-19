// Pane detail — read the tail and send input. `read`/`send` are `approve` ops (ADR-0012 rule 3.2):
// the laptop gates them, EXCEPT when this device is trusted (stores/remoteTrust) — then they flow
// with no prompt, which is what makes the live view below usable away from the laptop.
//
// The terminal sticks to the newest output (scrollToEnd) instead of jumping to the top, and
// auto-refreshes every REFRESH_MS once a first read succeeds. Background refreshes are SILENT (no
// "waiting…" flash), and auto-refresh stops if a read is denied so an untrusted device doesn't spam
// the laptop with a Clearance every couple of seconds — the operator taps "Approve & always" once.
//
// Swipe left/right to move between panes: the whole fleet is one horizontal strip and we translate
// to the active index. Each pane sits at a FIXED offset, so sliding onto it shows its (pre-fetched)
// content and it stays put — nothing swaps under the viewport, so there's no flash of the previous
// pane's text when a slide lands (the bug a re-centring 3-page pager had).
//
// Hold-to-talk: press-and-hold the 🎤 to dictate (on-device recognition, expo-speech-recognition) —
// the transcript lands in the compose box for you to review, then Send. Typing shell into a phone is
// the pain this removes; review-before-send is deliberate since a trusted device's send runs at once.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  PanResponder,
  Animated,
  useWindowDimensions,
} from "react-native";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import * as ImagePicker from "expo-image-picker";
import { Feather } from "@expo/vector-icons";
import type { LanBridgeClient } from "../lib/lanClient";
import type { PaneInfo, PaneApproval } from "../protocol";
import { C } from "../theme";

const REFRESH_MS = 2000;

// Last-seen terminal tail per pane, so swiping to a pane shows its content instantly instead of a
// blank page that only fills once its read returns. Neighbours are pre-fetched into this on open.
const tailCache = new Map<string, string>();

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
  { label: "^C", seq: "\x03" },
  { label: "⏎", seq: "\r" },
];

export default function PaneScreen({
  client,
  list,
  index,
  onBack,
  onIndexChange,
  approval,
}: {
  client: LanBridgeClient;
  /** The whole fleet (snapshot from when the pane was opened) — rendered as one swipeable strip. */
  list: PaneInfo[];
  /** Which pane is active (front-and-centre, live-polled). */
  index: number;
  onBack: () => void;
  /** Report a swipe-driven index change up so the parent's state stays in sync. */
  onIndexChange: (index: number) => void;
  /** The active pane's live blocked-approval, if any — its real prompt + choices to answer. */
  approval?: PaneApproval;
}) {
  const pane = list[index];
  const [input, setInput] = useState("");
  const [note, setNote] = useState<string | null>(null);
  // Auto-refresh runs only after a good read; a denial/error stops it (avoids Clearance spam).
  const [live, setLive] = useState(false);
  const [listening, setListening] = useState(false);
  // The TUI key row is off by default (most sends are plain text); toggle it from the compose bar.
  const [keysVisible, setKeysVisible] = useState(false);
  // One tail per pane name, so every page of the strip renders its own content and re-renders as
  // reads/pre-fetch fill it. Seeded from the module cache so a re-open is instant.
  const [tails, setTails] = useState<Record<string, string>>({});
  // Per-page scroll refs (keyed by pane name) so each terminal can pin itself to the newest output.
  const scrollRefs = useRef<Record<string, ScrollView | null>>({});

  // The strip is `list.length` pages wide; translate to `-index * width` to bring the active pane
  // under the viewport. Because each pane owns a fixed slot, a swipe just slides the strip — no page
  // ever changes identity mid-transition, so nothing flashes when a slide lands.
  const { width } = useWindowDimensions();
  const tx = useRef(new Animated.Value(-index * width)).current;
  // Keep the latest index/width/list-length in a ref so the once-created PanResponder never goes stale.
  const nav = useRef({ index, width, count: list.length, onIndexChange, activeName: pane.name });
  nav.current = { index, width, count: list.length, onIndexChange, activeName: pane.name };

  // Re-anchor the strip when the active index or width changes for a reason other than an in-flight
  // swipe (e.g. rotation, or a programmatic open). A swipe animates `tx` itself and then calls
  // onIndexChange, so by the time index updates `tx` is already at the right place — snapping here is
  // a no-op in that case and a correcting move otherwise.
  useEffect(() => {
    tx.setValue(-index * width);
  }, [index, width, tx]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) =>
        Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
      onPanResponderMove: (_e, g) => {
        const { index: i, width: w, count } = nav.current;
        // Follow the finger, resisting a drag past either end of the fleet.
        const atEnd = (g.dx < 0 && i >= count - 1) || (g.dx > 0 && i <= 0);
        const dx = atEnd ? g.dx * 0.25 : g.dx;
        tx.setValue(-i * w + dx);
      },
      onPanResponderRelease: (_e, g) => {
        const { index: i, width: w, count, onIndexChange: report } = nav.current;
        const goNext = g.dx <= -55 && i < count - 1;
        const goPrev = g.dx >= 55 && i > 0;
        const target = goNext ? i + 1 : goPrev ? i - 1 : i;
        Animated.timing(tx, {
          toValue: -target * w,
          duration: 160,
          useNativeDriver: true,
        }).start(() => {
          // The strip is already sitting on the target slot (which shows that pane), so reporting the
          // new index changes only which pane polls live — the visible content doesn't move.
          if (target !== i) report(target);
        });
      },
    }),
  ).current;

  // Tap-to-toggle dictation (hands-free, like a locked WhatsApp voice note): tap the mic to start,
  // tap again to stop and keep the transcript. `continuous` keeps it listening through pauses instead
  // of cutting off after the first phrase; results append after whatever was already typed. `cancel`
  // (trash) aborts and restores what was there before. Never auto-sent — you review, then Send.
  const dictationBase = useRef("");
  const cancelled = useRef(false);

  useSpeechRecognitionEvent("result", (e) => {
    const t = e.results?.[0]?.transcript;
    if (t != null && !cancelled.current) setInput(dictationBase.current + t);
  });
  useSpeechRecognitionEvent("end", () => setListening(false));
  useSpeechRecognitionEvent("error", (e) => {
    if (!cancelled.current) setNote(`voice: ${e.message || e.error}`);
    setListening(false);
  });

  async function startDictation() {
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        setNote("mic permission denied");
        return;
      }
      cancelled.current = false;
      dictationBase.current = input.trim() ? input.trimEnd() + " " : "";
      setNote(null);
      setListening(true);
      ExpoSpeechRecognitionModule.start({ lang: "en-US", interimResults: true, continuous: true });
    } catch (err) {
      setNote(`voice: ${(err as Error).message}`);
      setListening(false);
    }
  }
  function stopDictation() {
    ExpoSpeechRecognitionModule.stop(); // finalize; the transcript stays in the box for review
    setListening(false);
  }
  function cancelDictation() {
    cancelled.current = true;
    ExpoSpeechRecognitionModule.abort();
    setInput(dictationBase.current.trimEnd());
    setListening(false);
  }
  // Stop a live recording if the screen unmounts mid-utterance.
  useEffect(() => () => ExpoSpeechRecognitionModule.stop(), []);

  // Read a pane's tail into the cache + state. `silent` skips the "waiting…" note (used for the
  // active pane's first read only when it's a never-seen pane; swipes are always silent).
  const readPane = useCallback(
    async (name: string, silent: boolean) => {
      if (!silent) setNote("waiting for approval on the laptop…");
      try {
        const res = await client.call({ op: "read", target: name, lines: 200 });
        if (res.ok) {
          const text = ((res.data as { text?: string }).text ?? "").trimEnd();
          tailCache.set(name, text);
          setTails((cur) => (cur[name] === text ? cur : { ...cur, [name]: text }));
          if (name === nav.current.activeName) setNote(null); // clear the note only for the active pane
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [client],
  );

  // Active pane: read on open/swap (silent when cached), then poll silently. A failed read stops the
  // poll (avoids Clearance spam) and shows the error.
  useEffect(() => {
    let stop = false;
    (async () => {
      const ok = await readPane(pane.name, tailCache.has(pane.name));
      if (stop) return;
      if (ok) setLive(true);
      else {
        setLive(false);
        setNote("couldn't read that pane — approve it on the laptop, or Retry");
      }
    })();
    return () => {
      stop = true;
    };
  }, [pane.name, readPane]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      readPane(pane.name, true).then((ok) => !ok && setLive(false));
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [live, pane.name, readPane]);

  // Pre-fetch the immediate neighbours once reads are flowing, so a swipe lands on ready content
  // (never spams an untrusted laptop — gated on `live`).
  const prevName = list[index - 1]?.name;
  const nextName = list[index + 1]?.name;
  useEffect(() => {
    if (!live) return;
    for (const n of [prevName, nextName]) if (n) readPane(n, true);
  }, [live, prevName, nextName, readPane]);

  async function send() {
    const text = input;
    setInput("");
    setNote("sending…");
    try {
      const res = await client.call({ op: "send", target: pane.name, text });
      setNote(res.ok ? null : res.error);
      if (res.ok) setTimeout(() => readPane(pane.name, true), 400);
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
      if (res.ok) setTimeout(() => readPane(pane.name, true), 200);
      else setNote(res.error);
    } catch (e) {
      setNote((e as Error).message);
    }
  }

  return (
    <View style={styles.wrap} {...pan.panHandlers}>
      <View style={styles.viewport}>
        <Animated.View
          style={[styles.strip, { width: width * list.length, transform: [{ translateX: tx }] }]}
        >
          {list.map((p, i) => {
            const tailText = tails[p.name] ?? tailCache.get(p.name) ?? "";
            const active = i === index;
            return (
              <View style={[styles.pageCol, { width }]} key={`${p.workspace}/${p.name}`}>
                <View style={styles.bar}>
                  <Pressable onPress={onBack} hitSlop={12}>
                    <Feather name="chevron-left" size={26} color={C.textDim} />
                  </Pressable>
                  <Text style={styles.name} numberOfLines={1}>
                    <Text style={styles.nameWs}>{p.workspace} · </Text>
                    {p.name}
                  </Text>
                  <Pressable onPress={() => readPane(p.name, active)} hitSlop={12}>
                    <Feather name="rotate-cw" size={19} color={C.textDim} />
                  </Pressable>
                </View>
                <ScrollView
                  ref={(el) => {
                    scrollRefs.current[p.name] = el;
                  }}
                  style={styles.term}
                  contentContainerStyle={{ padding: 12 }}
                  onContentSizeChange={() =>
                    scrollRefs.current[p.name]?.scrollToEnd({ animated: false })
                  }
                >
                  <Text style={styles.mono}>{tailText || " "}</Text>
                </ScrollView>
              </View>
            );
          })}
        </Animated.View>
        {/* Floated over the terminal's bottom edge, so a transient message never resizes the view
            (which used to jolt the terminal on every swipe). */}
        {note && (
          <View style={styles.noteOverlay} pointerEvents="none">
            <Text style={styles.note}>{note}</Text>
          </View>
        )}
      </View>
      {/* When the active pane is blocked on a pushed multi-choice question, show the real options as a
          vertical select list — the recommended one (badged) is first, each row carries its
          description. Tapping sends that option's number to the menu. Beats hunting the key row. */}
      {approval?.options?.length ? (
        <View style={styles.optsWrap}>
          <Text style={styles.optsPrompt} numberOfLines={2}>
            {approval.prompt}
          </Text>
          <ScrollView style={styles.optsList} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            {approval.options.map((o, i) => {
              const rec = /\(\s*recommended\s*\)/i.test(o.label);
              const label = o.label.replace(/\s*\(\s*recommended\s*\)\s*/i, "").trim();
              return (
                <Pressable
                  key={i}
                  style={[styles.optRow, rec && styles.optRowRec]}
                  onPress={() => sendKey(`${i + 1}\r`)}
                >
                  <Text style={styles.optNum}>{i + 1}</Text>
                  <View style={styles.optBody}>
                    <View style={styles.optLabelRow}>
                      <Text style={styles.optLabel} numberOfLines={1}>
                        {label}
                      </Text>
                      {rec ? <Text style={styles.optBadge}>Recommended</Text> : null}
                    </View>
                    {o.description ? (
                      <Text style={styles.optDesc} numberOfLines={2}>
                        {o.description}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
      {keysVisible && (
        <View style={styles.keys}>
          {KEYS.map((k) => (
            <Pressable
              key={k.label}
              style={[styles.key, k.seq === "\r" && styles.keyWide]}
              onPress={() => sendKey(k.seq)}
              hitSlop={4}
            >
              <Text style={styles.keyText}>{k.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={styles.composer}>
        {/* Rounded pill: a keys-toggle on the left (show/hide the TUI key row), then the input. */}
        <View style={styles.pill}>
          <Pressable onPress={() => setKeysVisible((v) => !v)} hitSlop={8} style={styles.pillIconBtn}>
            <Feather name="terminal" size={19} color={keysVisible ? C.accentText : C.textDim} />
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
                <Feather name="paperclip" size={19} color={C.textDim} />
              </Pressable>
              <Pressable onPress={() => pickImage(true)} hitSlop={8} style={styles.pillIconBtn}>
                <Feather name="camera" size={19} color={C.textDim} />
              </Pressable>
            </>
          )}
        </View>
        {/* Recording: a trash (cancel) + a stop button. Otherwise Send when there's text, else the mic
            (tap to start hands-free dictation, tap Stop to finish) — WhatsApp-style. */}
        {listening ? (
          <>
            <Pressable style={styles.iconBtn} onPress={cancelDictation} hitSlop={8}>
              <Feather name="trash-2" size={20} color={C.textDim} />
            </Pressable>
            <Pressable style={[styles.round, styles.roundOn]} onPress={stopDictation}>
              <Feather name="square" size={18} color={C.canvas} />
            </Pressable>
          </>
        ) : input.trim().length > 0 ? (
          // Tap sends; hold to dictate MORE onto what's already typed (or an attached image path).
          <Pressable style={styles.round} onPress={send} onLongPress={startDictation} delayLongPress={350}>
            <Feather name="send" size={20} color={C.canvas} />
          </Pressable>
        ) : (
          <Pressable style={styles.round} onPress={startDictation}>
            <Feather name="mic" size={22} color={C.canvas} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.canvas },
  // The pager viewport clips the fleet-wide strip; the strip is a row of full-screen-width pages so a
  // swipe slides between them.
  viewport: { flex: 1, overflow: "hidden" },
  strip: { flexDirection: "row", height: "100%" },
  pageCol: { height: "100%" },
  bar: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 14, borderBottomColor: C.hairline, borderBottomWidth: 1 },
  name: { color: C.textBright, fontSize: 19, fontWeight: "600", flex: 1, fontFamily: "monospace" },
  nameWs: { color: C.textDim, fontWeight: "400" },
  term: { flex: 1, backgroundColor: C.surfaceDead },
  mono: { color: C.textMid, fontFamily: "monospace", fontSize: 13, lineHeight: 19 },
  // A floating toast, not an in-flow row — absolute so it never reflows the terminal above it.
  noteOverlay: { position: "absolute", left: 0, right: 0, bottom: 8, alignItems: "center" },
  note: { color: C.needs, fontSize: 12, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: C.surface, borderColor: C.hairline, borderWidth: 1, borderRadius: 14, overflow: "hidden" },
  // Pushed multi-choice answer bar — the real options as wrapping chips, above the key row.
  optsWrap: { paddingHorizontal: 12, paddingTop: 8, gap: 8, borderTopColor: C.hairline, borderTopWidth: 1 },
  optsPrompt: { color: C.textDim, fontSize: 13 },
  optsList: { maxHeight: 240 },
  optRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, backgroundColor: C.surface, borderColor: C.hairline, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8 },
  optRowRec: { borderColor: C.accent }, // the recommended row reads as the default
  optNum: { width: 22, height: 22, borderRadius: 6, backgroundColor: C.canvas, color: C.textMid, textAlign: "center", lineHeight: 22, fontSize: 12, fontWeight: "700", overflow: "hidden" },
  optBody: { flex: 1, gap: 3 },
  optLabelRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  optLabel: { color: C.textBright, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  optBadge: { fontSize: 10, color: C.accent, borderColor: C.accent, borderWidth: 1, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1, overflow: "hidden", fontWeight: "700" },
  optDesc: { color: C.textFaint, fontSize: 12 },
  // Key row for driving TUIs — one compact strip; keys share the width evenly. The single divider
  // above the input area lives here (the composer no longer has its own top border, which used to
  // draw a stray line right under these keys).
  keys: { flexDirection: "row", gap: 6, paddingHorizontal: 12, paddingTop: 10, borderTopColor: C.hairline, borderTopWidth: 1 },
  key: { flex: 1, minHeight: 42, backgroundColor: C.surface, borderColor: C.hairline, borderWidth: 1, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  // ⏎ Enter is the most-used key (confirming menus) — give it extra width so it's easy to hit.
  keyWide: { flex: 2.2 },
  keyText: { color: C.textMid, fontSize: 16, fontWeight: "600" },
  // WhatsApp-style compose bar: a rounded pill (keys-toggle + input) and a round action button.
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 10, paddingVertical: 10 },
  pill: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6, minHeight: 52, backgroundColor: C.surface, borderColor: C.hairline, borderWidth: 1, borderRadius: 26, paddingLeft: 10, paddingRight: 14 },
  pillIconBtn: { width: 34, height: 34, alignItems: "center", justifyContent: "center" },
  pillInput: { flex: 1, color: C.textBright, fontFamily: "monospace", fontSize: 16, paddingVertical: 12, maxHeight: 120 },
  round: { width: 52, height: 52, borderRadius: 26, backgroundColor: C.accent, alignItems: "center", justifyContent: "center" },
  roundOn: { backgroundColor: C.needs },
  iconBtn: { width: 44, height: 52, alignItems: "center", justifyContent: "center" },
});
