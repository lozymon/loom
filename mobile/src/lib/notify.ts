// Fleet notifications. A pane's enriched `list` payload (attention / sessionState / live) is mapped
// to a notifiable category; we edge-trigger — fire only when a pane *transitions into* a category, not
// every poll — so you get one buzz when an agent starts needing you, not a buzz every 4s while it does.
//
// The same diff runs in two places: the foreground poll (App) while the app is alive, and the
// background task (tasks/fleetTask) when it's backgrounded. They share one persisted "last category
// per pane" map so the two don't double-fire across the foreground↔background boundary.

import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import type { PaneInfo } from "../protocol";

/** Which of the three alert-worthy things happened. Priority order when several could apply. */
export type Alert = "needs" | "failed" | "done";

const KEY = (p: PaneInfo) => `${p.workspace}/${p.name}`;
const ALERT_STATE_KEY = "loom.alertState"; // persisted Record<paneKey, Alert | "none">

/** The notifiable category for a pane right now, or null. "needs you" (blocked / attention) wins,
 *  then a failure, then a clean finish. Everything else (running, idle, a normal dead shell) is null. */
export function paneAlert(p: PaneInfo): Alert | null {
  if (p.attention || p.sessionState === "blocked") return "needs";
  if (p.sessionState === "failed") return "failed";
  if (p.sessionState === "done") return "done";
  return null;
}

/** Diff a fresh snapshot against the last categories: return the new category map plus the panes that
 *  just entered an alert category (edge, so no repeat buzzing while a pane stays blocked). */
export function computeAlerts(
  prev: Record<string, Alert | "none">,
  panes: PaneInfo[],
): { next: Record<string, Alert | "none">; fire: { pane: PaneInfo; alert: Alert }[] } {
  const next: Record<string, Alert | "none"> = {};
  const fire: { pane: PaneInfo; alert: Alert }[] = [];
  for (const p of panes) {
    const a = paneAlert(p);
    const k = KEY(p);
    next[k] = a ?? "none";
    if (a && prev[k] !== a) fire.push({ pane: p, alert: a });
  }
  return { next, fire };
}

export async function loadAlertState(): Promise<Record<string, Alert | "none">> {
  try {
    const s = await SecureStore.getItemAsync(ALERT_STATE_KEY);
    return s ? (JSON.parse(s) as Record<string, Alert | "none">) : {};
  } catch {
    return {};
  }
}

export async function saveAlertState(m: Record<string, Alert | "none">): Promise<void> {
  try {
    await SecureStore.setItemAsync(ALERT_STATE_KEY, JSON.stringify(m));
  } catch {
    // Non-fatal: worst case is a repeated notification next run.
  }
}

const COPY: Record<Alert, { title: (p: PaneInfo) => string; body: string }> = {
  needs: { title: (p) => `${p.name} needs you`, body: "waiting for your input" },
  failed: { title: (p) => `${p.name} failed`, body: "the session errored out" },
  done: { title: (p) => `${p.name} finished`, body: "the session is done" },
};

/** Post one local notification for a pane event. Delivers immediately; on Android a channel-aware
 *  trigger routes it through our HIGH-importance "fleet" channel (heads-up + vibrate). */
export async function fireAlert(pane: PaneInfo, alert: Alert): Promise<void> {
  const c = COPY[alert];
  await Notifications.scheduleNotificationAsync({
    content: {
      title: c.title(pane),
      body: `${pane.workspace} · ${c.body}`,
      data: { workspace: pane.workspace, name: pane.name },
    },
    trigger: Platform.OS === "android" ? { channelId: "fleet" } : null,
  });
}

/** One-time setup: how to present a notification that arrives while the app is foregrounded, the
 *  Android channel (heads-up + vibrate), and the runtime permission prompt. Safe to call repeatedly. */
export async function initNotifications(): Promise<void> {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("fleet", {
      name: "Fleet alerts",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    });
  }
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") await Notifications.requestPermissionsAsync();
}
