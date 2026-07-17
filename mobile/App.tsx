// Loom mobile — local-first Android app (Plan 02 L2). Flow: on launch, load the stored pairing and
// connect the sealed bridge; unpaired → Pair screen; connected → Fleet, tap into Pane detail.
//
// State is intentionally simple (hooks, no nav lib) for a single-Host keeper. Multi-Host (rule 7)
// and the Clearance/attention inbox are the next slices; the transport + observe/drive core is here.

import { useEffect, useState } from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { StatusBar } from "expo-status-bar";
import { LanBridgeClient } from "./src/lib/lanClient";
import { loadPairing, forgetPairing, type Pairing } from "./src/state/pairing";
import PairScreen from "./src/screens/PairScreen";
import FleetScreen from "./src/screens/FleetScreen";
import PaneScreen from "./src/screens/PaneScreen";
import type { PaneInfo } from "./src/protocol";
import { C } from "./src/theme";

type Phase =
  | { kind: "loading" }
  | { kind: "unpaired" }
  | { kind: "connecting" }
  | { kind: "error"; message: string }
  | { kind: "ready"; client: LanBridgeClient };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [open, setOpen] = useState<PaneInfo | null>(null);

  async function connect(pairing: Pairing) {
    setPhase({ kind: "connecting" });
    const client = new LanBridgeClient(pairing.url, pairing.key);
    try {
      await client.connect();
      setPhase({ kind: "ready", client });
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  }

  useEffect(() => {
    (async () => {
      const pairing = await loadPairing();
      if (pairing) connect(pairing);
      else setPhase({ kind: "unpaired" });
    })();
  }, []);

  async function unpair() {
    await forgetPairing();
    setOpen(null);
    setPhase({ kind: "unpaired" });
  }

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {phase.kind === "loading" || phase.kind === "connecting" ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.accent} />
          <Text style={styles.dim}>{phase.kind === "connecting" ? "Connecting to Loom…" : ""}</Text>
        </View>
      ) : phase.kind === "unpaired" ? (
        <PairScreen onPaired={connect} />
      ) : phase.kind === "error" ? (
        <View style={styles.center}>
          <Text style={styles.err}>Couldn't reach Loom</Text>
          <Text style={styles.dim}>{phase.message}</Text>
          <Pressable style={styles.btn} onPress={() => loadPairing().then((p) => p && connect(p))}>
            <Text style={styles.btnText}>Retry</Text>
          </Pressable>
          <Pressable style={styles.btn} onPress={unpair}>
            <Text style={styles.btnText}>Forget this Loom</Text>
          </Pressable>
        </View>
      ) : open ? (
        <PaneScreen client={phase.client} pane={open} onBack={() => setOpen(null)} />
      ) : (
        <FleetScreen client={phase.client} onOpen={setOpen} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.canvas },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  dim: { color: C.textDim, fontSize: 14, textAlign: "center" },
  err: { color: C.textBright, fontSize: 18, fontWeight: "600" },
  btn: { borderColor: C.hairline, borderWidth: 1, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10, marginTop: 4 },
  btnText: { color: C.textMid, fontWeight: "600" },
});
