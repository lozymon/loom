// Loom mobile — local-first Android app (Plan 02 L2). Flow: on launch, load the stored pairing and
// connect the sealed bridge; unpaired → Pair screen; connected → Fleet, tap into Pane detail.
//
// State is intentionally simple (hooks, no nav lib) for a single-Host keeper. Multi-Host (rule 7)
// and the Clearance/attention inbox are the next slices; the transport + observe/drive core is here.

import { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
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
  | { kind: "connecting"; url: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; client: LanBridgeClient };

// SafeAreaProvider must wrap the tree so useSafeAreaInsets works. Android 15 draws edge-to-edge,
// so without this the header sits under the status-bar clock (the overlap bug).
export default function App() {
  return (
    <SafeAreaProvider>
      <AppRoot />
    </SafeAreaProvider>
  );
}

function AppRoot() {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  // The open pane, plus its fleet list + index so PaneScreen can swipe to neighbours without a
  // round-trip back to the list.
  const [open, setOpen] = useState<{ list: PaneInfo[]; index: number } | null>(null);
  // The in-flight connection, so Cancel can abort it; `attempt` invalidates a superseded/cancelled
  // connect so its late resolve/reject can't clobber a newer phase.
  const connecting = useRef<LanBridgeClient | null>(null);
  const attempt = useRef(0);

  async function connect(pairing: Pairing) {
    const mine = ++attempt.current;
    setPhase({ kind: "connecting", url: pairing.url });
    try {
      // Inside the try so a constructor throw (e.g. crypto.getRandomValues missing) surfaces on the
      // error screen instead of leaving the app stuck on "Connecting…".
      const client = new LanBridgeClient(pairing.url, pairing.key);
      connecting.current = client;
      await client.connect();
      if (mine !== attempt.current) return client.close(); // cancelled/superseded
      connecting.current = null;
      setPhase({ kind: "ready", client });
    } catch (e) {
      if (mine !== attempt.current) return; // cancelled — leave the phase Cancel chose
      connecting.current = null;
      setPhase({ kind: "error", message: (e as Error).message });
    }
  }

  /** Bail out of a stuck "Connecting…" — abort the socket and drop to the error screen (Retry /
   *  Forget), so a wrong/stale address can never trap the user on the spinner. */
  function cancelConnect() {
    attempt.current++; // invalidate the in-flight attempt so its rejection is ignored
    connecting.current?.close();
    connecting.current = null;
    setPhase({ kind: "error", message: "Cancelled — Loom wasn't reachable at that address." });
  }

  useEffect(() => {
    (async () => {
      const pairing = await loadPairing();
      if (pairing) connect(pairing);
      else setPhase({ kind: "unpaired" });
    })();
  }, []);

  async function unpair() {
    attempt.current++;
    connecting.current?.close();
    connecting.current = null;
    await forgetPairing();
    setOpen(null);
    setPhase({ kind: "unpaired" });
  }

  return (
    <View
      style={[
        styles.root,
        // All four insets — landscape puts the notch/nav bar on the sides too.
        { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right },
      ]}
    >
      <StatusBar style="light" />
      {phase.kind === "loading" ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : phase.kind === "connecting" ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.accent} />
          <Text style={styles.dim}>Connecting to Loom…</Text>
          <Text style={styles.faint}>{phase.url}</Text>
          <Pressable style={styles.btn} onPress={cancelConnect}>
            <Text style={styles.btnText}>Cancel</Text>
          </Pressable>
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
        <PaneScreen
          client={phase.client}
          pane={open.list[open.index]}
          onBack={() => setOpen(null)}
          hasPrev={open.index > 0}
          hasNext={open.index < open.list.length - 1}
          onNavigate={(delta) =>
            setOpen((o) => {
              if (!o) return o;
              const next = o.index + delta;
              return next >= 0 && next < o.list.length ? { ...o, index: next } : o;
            })
          }
        />
      ) : (
        <FleetScreen client={phase.client} onOpen={(list, index) => setOpen({ list, index })} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.canvas },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  dim: { color: C.textDim, fontSize: 14, textAlign: "center" },
  faint: { color: C.textDim, fontSize: 12, opacity: 0.7, fontFamily: "monospace", textAlign: "center" },
  err: { color: C.textBright, fontSize: 18, fontWeight: "600" },
  btn: { borderColor: C.hairline, borderWidth: 1, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10, marginTop: 4 },
  btnText: { color: C.textMid, fontWeight: "600" },
});
