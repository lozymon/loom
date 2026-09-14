/** Recent folders, per hub: paths on the work machine mean nothing to the home hub. */
const key = (hubId: string | undefined) => (hubId ? `loom.recentDirs.${hubId}` : "loom.recentDirs");

export function recentDirs(hubId?: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key(hubId)) ?? localStorage.getItem(key(undefined)) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

export function rememberDir(dir: string, hubId?: string): void {
  localStorage.setItem(key(hubId), JSON.stringify([dir, ...recentDirs(hubId).filter((d) => d !== dir)].slice(0, 10)));
}
