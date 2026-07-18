// Pane detail — read the tail and send input. `read`/`send` are `approve` ops (ADR-0012 rule 3.2):
// the laptop gates them, EXCEPT when this device is trusted (stores/remoteTrust) — then they flow
// with no prompt, which is what makes the live view below usable away from the laptop.
//
// The terminal sticks to the newest output (scrollToEnd) instead of jumping to the top, and
// auto-refreshes every REFRESH_MS once a first read succeeds. Background refreshes are SILENT (no
// "waiting…" flash), and auto-refresh stops if a read is denied so an untrusted device doesn't spam
// the laptop with a Clearance every couple of seconds — the operator taps "Approve & always" once.

import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import type { LanBridgeClient } from "../lib/lanClient";
import type { PaneInfo } from "../protocol";
import { C } from "../theme";

const REFRESH_MS = 2000;

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
  const scrollRef = useRef<ScrollView>(null);

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

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <Text style={styles.name}>{pane.name}</Text>
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
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="send to this pane…"
          placeholderTextColor={C.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={send}
        />
        <Pressable style={styles.sendBtn} onPress={send}>
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.canvas },
  bar: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderBottomColor: C.hairline, borderBottomWidth: 1 },
  back: { color: C.textDim, fontSize: 26, lineHeight: 26 },
  name: { color: C.textBright, fontSize: 17, fontWeight: "600", flex: 1, fontFamily: "monospace" },
  refresh: { color: C.textDim, fontSize: 20 },
  term: { flex: 1, backgroundColor: C.surfaceDead },
  mono: { color: C.textMid, fontFamily: "monospace", fontSize: 12, lineHeight: 17 },
  note: { color: C.needs, fontSize: 12, paddingHorizontal: 12, paddingVertical: 6 },
  composer: { flexDirection: "row", gap: 8, padding: 10, borderTopColor: C.hairline, borderTopWidth: 1 },
  input: { flex: 1, backgroundColor: C.surface, color: C.textBright, borderColor: C.hairline, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontFamily: "monospace", fontSize: 13 },
  sendBtn: { backgroundColor: C.surface, borderColor: C.accent, borderWidth: 1, borderRadius: 8, paddingHorizontal: 16, justifyContent: "center" },
  sendText: { color: C.accentText, fontWeight: "600" },
});
