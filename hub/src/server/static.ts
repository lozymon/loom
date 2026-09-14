import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/**
 * Serves the built client from `root`, with index.html as the fallback for client routes.
 * Returns false when there is no build, so the caller can explain how to get one.
 */
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): boolean {
  const index = path.join(root, "index.html");
  if (!existsSync(index)) return false;

  const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://hub").pathname);
  const resolved = path.resolve(root, `.${urlPath}`);
  const inside = resolved === root || resolved.startsWith(root + path.sep);
  const file = inside && existsSync(resolved) && statSync(resolved).isFile() ? resolved : index;

  res.writeHead(200, {
    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "cache-control": file === index ? "no-cache" : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  createReadStream(file).pipe(res);
  return true;
}
