import { escapeRegex } from "./command.ts";

/** Claude Code's WebFetch domain rule matching. */
export function domainMatches(pattern: string, url: unknown): boolean {
  if (typeof url !== "string") return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  const p = pattern.toLowerCase().replace(/\.$/, "");
  if (p === "*") return true;
  if (p.startsWith("*.")) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
  // Elsewhere a wildcard stays between two dots, so `example.*` cannot become `example.evil.com`.
  return new RegExp(`^${p.split("*").map(escapeRegex).join("[^.]*")}$`).test(host);
}
