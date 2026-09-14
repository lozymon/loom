import type { SessionSummary } from "@loom/protocol";

export interface ProjectGroup {
  root: string;
  name: string;
  sessions: SessionSummary[];
}

export function projectName(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

/** Sessions grouped by project, projects ordered by their most recent activity, newest sessions first. */
export function groupByProject(sessions: readonly SessionSummary[], includeArchived: boolean): ProjectGroup[] {
  const groups = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    if (s.archived && !includeArchived) continue;
    if (s.cockpit) continue;
    const list = groups.get(s.projectRoot) ?? [];
    list.push(s);
    groups.set(s.projectRoot, list);
  }
  return [...groups.entries()]
    .map(([root, list]) => ({ root, name: projectName(root), sessions: list.sort((a, b) => b.createdAt - a.createdAt) }))
    .sort((a, b) => Math.max(...b.sessions.map((s) => s.updatedAt)) - Math.max(...a.sessions.map((s) => s.updatedAt)));
}
