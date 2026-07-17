// Fleet screen — the home view. Polls `list` (the one allow op) and shows each pane with its P0c
// state (status label, attention, session state). Tap a pane to open it. This is the "observe" half;
// it never prompts.

import { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, Pressable, RefreshControl, StyleSheet } from "react-native";
import type { LanBridgeClient } from "../lib/lanClient";
import type { PaneInfo } from "../protocol";
import { C, stateColor } from "../theme";

export default function FleetScreen({
  client,
  onOpen,
}: {
  client: LanBridgeClient;
  onOpen: (pane: PaneInfo) => void;
}) {
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await client.call({ op: "list" });
      if (res.ok) {
        setPanes(res.data as PaneInfo[]);
        setError(null);
      } else {
        setError(res.error);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [client]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000); // the fleet dashboard; `list` is cheap + unprompted
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <View style={styles.wrap}>
      <Text style={styles.header}>Fleet</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={panes}
        keyExtractor={(p) => `${p.workspace}/${p.name}`}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.accent} />}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => onOpen(item)}>
            <View style={[styles.dot, { backgroundColor: stateColor(item) }]} />
            <View style={styles.main}>
              <Text style={styles.name}>
                {item.name}
                {item.role ? <Text style={styles.role}> {item.role}</Text> : null}
              </Text>
              <Text style={styles.sub} numberOfLines={1}>
                {item.status || (item.attention ? "needs you" : item.live ? item.sessionState ?? "idle" : "dead")}
              </Text>
            </View>
            <Text style={styles.ws}>{item.workspace}</Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No panes — is the bridge on?</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.canvas, paddingTop: 8 },
  header: { color: C.textBright, fontSize: 22, fontWeight: "600", paddingHorizontal: 16, paddingVertical: 12 },
  error: { color: C.dead, paddingHorizontal: 16, paddingBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderBottomColor: C.hairline, borderBottomWidth: 1 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  main: { flex: 1 },
  name: { color: C.textBright, fontSize: 15, fontFamily: "monospace" },
  role: { color: C.textDim, fontSize: 12 },
  sub: { color: C.textDim, fontSize: 13, marginTop: 2 },
  ws: { color: C.textFaint, fontSize: 12 },
  empty: { color: C.textFaint, textAlign: "center", padding: 32 },
});
