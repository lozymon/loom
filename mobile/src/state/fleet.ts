// The fleet poll, lifted out of FleetScreen so it runs whenever the app is connected — including
// while you're inside a pane — and can drive notifications. Polls `list` every 4s, and on each fresh
// snapshot edge-triggers a local notification for any pane that just started needing you / finished /
// failed. Shares the persisted alert-state map with the background task so the two never double-fire.

import { useCallback, useEffect, useRef, useState } from "react";
import type { LanBridgeClient } from "../lib/lanClient";
import type { PaneInfo } from "../protocol";
import { type Alert, computeAlerts, fireAlert, loadAlertState, saveAlertState } from "../lib/notify";

const POLL_MS = 4000;

export function useFleet(client: LanBridgeClient | null) {
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const alertState = useRef<Record<string, Alert | "none">>({});
  // Suppress the very first snapshot after connect: it establishes the baseline, so we don't buzz for
  // everything already blocked/done when you open the app (those are on-screen anyway).
  const baselined = useRef(false);

  const refresh = useCallback(async () => {
    if (!client) return;
    setRefreshing(true);
    try {
      const res = await client.call({ op: "list" });
      if (res.ok) {
        const list = res.data as PaneInfo[];
        setPanes(list);
        setError(null);
        const { next, fire } = computeAlerts(alertState.current, list);
        alertState.current = next;
        if (baselined.current) for (const f of fire) await fireAlert(f.pane, f.alert);
        baselined.current = true;
        await saveAlertState(next); // keep the background task in sync with what we've seen
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
    if (!client) return;
    let active = true;
    baselined.current = false;
    // Seed from persisted state (so we continue where the background task left off) BEFORE the first
    // poll, then baseline on that first live snapshot.
    (async () => {
      alertState.current = await loadAlertState();
      if (active) await refresh();
    })();
    const t = setInterval(refresh, POLL_MS);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [client, refresh]);

  return { panes, error, refreshing, refresh };
}
