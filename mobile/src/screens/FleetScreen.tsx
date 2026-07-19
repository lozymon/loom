// Fleet screen — the home view. Shows each pane with its P0c state (status label, attention, session
// state); tap a pane to open it. The `list` poll lives in App now (state/fleet) so it keeps running —
// and keeps notifications flowing — even while you're inside a pane; this screen just renders it.

import { View, Text, FlatList, Pressable, RefreshControl, StyleSheet } from "react-native";
import type { PaneInfo } from "../protocol";
import { C, stateColor } from "../theme";

export default function FleetScreen({
  panes,
  error,
  refreshing,
  onRefresh,
  onOpen,
}: {
  panes: PaneInfo[];
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (list: PaneInfo[], index: number) => void;
}) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.header}>Fleet</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={panes}
        keyExtractor={(p) => `${p.workspace}/${p.name}`}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.accent} />}
        renderItem={({ item, index }) => (
          <Pressable style={styles.row} onPress={() => onOpen(panes, index)}>
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
