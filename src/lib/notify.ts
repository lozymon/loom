// Desktop notifications for the "needs you" signal. When a pane raises attention (a command
// finished in an unfocused pane, or a process called `th attention`) and Termhaus itself isn't
// the focused window, optionally surface an OS notification so a finished/blocked agent pulls you
// back even when the app is in the background. Opt-in (settings.notifyOnAttention, default off)
// and best-effort — any failure (no permission, headless, plugin missing) is swallowed.
//
// Metadata only: the trigger is the same attention flag as the in-app border (foreground-pgrp
// fact or an inbound `th` command), never pane output (ADR-0001).

import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { settings } from "../stores/settings";

// Cached permission grant — null until first checked, so we ask the OS at most once per session.
let permission: boolean | null = null;

async function ensurePermission(): Promise<boolean> {
  if (permission !== null) return permission;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    permission = granted;
  } catch {
    permission = false;
  }
  return permission;
}

/**
 * Fire a desktop notification that a pane needs you — but only when the user opted in AND the
 * Termhaus window isn't focused (no point interrupting someone already looking at the app; the
 * amber border is enough there). Call only on a *fresh* attention raise (noteAttention returned
 * true), so a pane already flagged doesn't re-notify on every poll.
 */
export async function notifyAttention(paneName: string, workspaceName: string): Promise<void> {
  if (!settings.notifyOnAttention) return;
  try {
    // App is up front → the in-app border already tells you; don't pop an OS toast on top.
    if (await getCurrentWindow().isFocused()) return;
  } catch {
    /* can't tell (e.g. headless) → fall through and notify */
  }
  if (!(await ensurePermission())) return;
  try {
    sendNotification({
      title: `${paneName} needs you`,
      body: workspaceName ? `in ${workspaceName}` : "a command finished",
    });
  } catch {
    /* ignore — notifications are a nicety, never a hard dependency */
  }
}
