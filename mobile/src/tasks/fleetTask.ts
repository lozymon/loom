// Background fleet watch. When the app is backgrounded / the phone is locked (but still on the
// laptop's network), the OS periodically runs this task: open the sealed bridge, `list` the fleet,
// diff against the persisted alert state, and post a notification for anything that just started
// needing you / finished / failed. Because LanBridgeClient is pure JS (@noble, no native module), it
// runs fine in this headless context.
//
// NOTE: Android floors the interval (~15 min) and only runs the task when it decides to (battery /
// Doze aware), so background alerts are near-real-time-ish, not instant. Instant delivery when the app
// is fully closed / off-LAN would need FCM push from the laptop — a separate, larger feature.
//
// This module MUST be imported for its side effect (defineTask) at startup — see index.ts.

import * as BackgroundFetch from "expo-background-fetch";
import * as TaskManager from "expo-task-manager";
import { loadPairing } from "../state/pairing";
import { LanBridgeClient } from "../lib/lanClient";
import { computeAlerts, fireAlert, loadAlertState, saveAlertState } from "../lib/notify";
import type { PaneInfo } from "../protocol";

export const FLEET_TASK = "loom-fleet-watch";

TaskManager.defineTask(FLEET_TASK, async () => {
  try {
    const pairing = await loadPairing();
    if (!pairing) return BackgroundFetch.BackgroundFetchResult.NoData;

    const client = new LanBridgeClient(pairing.url, pairing.key);
    try {
      await client.connect();
      const res = await client.call({ op: "list" });
      if (!res.ok) return BackgroundFetch.BackgroundFetchResult.Failed;

      const list = res.data as PaneInfo[];
      const prev = await loadAlertState();
      const { next, fire } = computeAlerts(prev, list);
      for (const f of fire) await fireAlert(f.pane, f.alert);
      await saveAlertState(next);
      return fire.length
        ? BackgroundFetch.BackgroundFetchResult.NewData
        : BackgroundFetch.BackgroundFetchResult.NoData;
    } finally {
      client.close();
    }
  } catch {
    // Unreachable bridge (off-LAN, laptop asleep) is the common case here — just report no data.
    return BackgroundFetch.BackgroundFetchResult.NoData;
  }
});

/** Ask the OS to run FLEET_TASK periodically. Idempotent; safe to call on every launch. */
export async function registerFleetTask(): Promise<void> {
  try {
    await BackgroundFetch.registerTaskAsync(FLEET_TASK, {
      minimumInterval: 60 * 5, // 5 min requested; Android will floor it (~15 min)
      stopOnTerminate: false, // keep watching after the app is backgrounded
      startOnBoot: true, // and after a reboot
    });
  } catch {
    // Already registered, or the platform declined — non-fatal.
  }
}
