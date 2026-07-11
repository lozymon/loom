# Plan 03 — Marketing website + docs site (self-hosted on VPS)

**Status:** planning · **Effort:** ~2–3 days · **Rust:** none · **ADR:** not needed
**Decisions locked:**
- **Host on the user's own VPS** (not GitHub Pages), at **`loom.furevikstrand.cloud`**.
- **Stack: Astro + Starlight** (final pick — see below; VitePress rejected).
- **`site/` lives in *this* repo** (not a separate repo), self-contained with its own lockfile.
- **`docs/` is the single source of truth**; the docs site is *generated* from it at build time —
  there is no committed second copy to drift.
- **Downloads link GitHub Releases**; artifacts are not re-hosted on the VPS.
- **Shared box with Plan 02 (mobile relay):** one nginx + one Let's Encrypt cert. Site at the apex
  subdomain, relay at `relay.loom.furevikstrand.cloud` (reserved here, activated in Plan 02).
- **No analytics** for now (revisit self-hosted Plausible later).

## Goal

A public site with two faces, from **one Astro build** (Starlight is an Astro integration, not a
second site):
1. **Landing page** (`/`) — what Loom is (agent-first control room of real terminals), feature
   highlights, screenshots, download CTA. Hand-built in Astro.
2. **Docs site** (`/docs`) — the existing repo docs made browsable (getting started, decisions/ADRs,
   features, `loom` CLI + `loom mcp` reference), themed by Starlight with sidebar + search.

## Stack: Astro + Starlight (final — VitePress rejected)

- **One build, two faces.** Starlight is an Astro integration, so the bespoke landing and the docs
  are a single project emitting one static `dist/`. Landing at `/`, docs mounted at `/docs`.
- **Landing is the tie-breaker.** Astro's island/component model builds a real hand-crafted hero;
  VitePress's landing is a constrained frontmatter theme that fights anything bespoke. On the *docs*
  side the two are at parity (sidebar/search/themes from markdown out of the box).
- **No deploy-cost difference.** Both are Vite-based and emit static output → identical
  `rsync dist/` deploy. VitePress being "lighter" doesn't change the deploy or the drift story.
- **No Vue synergy to exploit.** Loom's frontend is SolidJS, so VitePress's Vue affinity buys
  nothing; Astro is framework-agnostic (and could embed a Solid island later if ever useful).
- **Content Collections earn their keep.** Starlight's zod-validated frontmatter is what lets the
  sync script fail the build on bad/missing titles or broken cross-links — drift becomes a red CI
  run, not a silent 404.

## `site/` in this repo (final — separate repo rejected)

- **Atomicity is the whole point.** The sync strategy's value is that an ADR edit and the site that
  publishes it move in **one commit / one PR**. A separate repo reintroduces exactly the drift this
  plan exists to kill (submodule bumps, cross-repo PRs, "did someone update the docs mirror?").
- **Isolation is cheap to contain:**
  - `site/package.json` + `site/package-lock.json` — its own dependency graph.
  - Root `package.json` must **not** declare a `workspaces` glob that captures `site/` (it doesn't
    today; keep it that way), so `npm ci` at the repo root never installs Astro/Starlight.
  - App CI path-filters exclude `site/**`; the deploy workflow path-filters *to* `site/**`+`docs/**`.
    The two never cross-trigger.
  - `.gitignore`: `site/node_modules/`, `site/dist/`, and the generated docs tree (below).

## Structure

```
site/
  package.json            own lockfile; NOT a root workspace member
  astro.config.mjs        Starlight integration, site: 'https://loom.furevikstrand.cloud'
  scripts/sync-docs.mjs   prebuild transform: docs/ → src/content/docs/ (generated, gitignored)
  src/
    pages/index.astro     landing (hero, feature grid, screenshots, download CTA → Releases)
    content/docs/
      index.mdx           docs home            ] authored natively (hand-written), committed
      getting-started/    install + first run  ]
      reference/cli.md    loom / loom mcp ref   ] (assembled from cli.rs/mcp.rs + loom-commands)
      decisions/**        ← GENERATED from ../../docs/adr/**   (gitignored)
      features.md         ← GENERATED from ../../docs/FEATURES.md (gitignored)
```

Generated paths (`decisions/**`, `features.md`, plus any other synced `docs/reference/*`) are
**gitignored**; hand-authored docs live at distinct, committed paths (`index.mdx`,
`getting-started/`, `reference/cli.md`). Generated and authored never collide in the same file.

## Docs → Starlight sync (drift-proof)

**Single source of truth: `docs/`. The published docs are a build artifact of it.** A prebuild Node
script transforms the repo markdown into Starlight content; nothing is hand-copied.

`site/scripts/sync-docs.mjs`, wired as `"prebuild": "node scripts/sync-docs.mjs"` so **every**
`npm run build` regenerates before `astro build`. Manifest-driven:

```js
const MAP = [
  { src: '../docs/FEATURES.md', dest: 'features.md',   title: 'Features' },
  { src: '../docs/adr',         dest: 'decisions',     titleFromH1: true, dir: true },
  { src: '../docs/reference',   dest: 'reference',     titleFromH1: true, dir: true }, // if publishable
];
```

Per file the script:
1. **Injects frontmatter.** Starlight requires a `title:`; the ADRs/FEATURES are bare `# H1`. Extract
   the first H1 → `title`, strip that H1 from the body (Starlight renders the title itself). Preserve
   any existing frontmatter.
2. **Rewrites intra-repo links.** `](adr/0011-x.md)`, `](../adr/0011-x.md)`, `](0011-x.md)` →
   `/docs/decisions/0011-x/`. Links that point *outside* the published set (`roadmap/…`, source
   files) are rewritten to the **GitHub blob URL** so they never 404.
3. **Writes** into the gitignored generated path.

**Why this cannot drift:**
- **No committed copy.** The published ADR *is* the repo ADR, transformed at build. There is no
  "site mirror" to forget to update.
- **Rebuilt from source on every deploy.** The GitHub Action runs the sync as prebuild, so the live
  site always reflects `docs/` at that commit.
- **`docs/**` is a deploy trigger** (below), so a docs-only edit (new ADR, FEATURES line) redeploys.
- **Broken links fail CI.** Content-Collection schema validation + Starlight's link checking turn a
  renamed/deleted ADR into a red build, not a silent 404. A dropped ADR that something still links to
  breaks the deploy loudly.
- **The FEATURES maintenance rule already exists** in-repo ("when a feature ships, update
  FEATURES.md"); the site inherits it for free by publishing that same file.
- Each generated page carries a Starlight `editLink` → its GitHub blob, so readers can see it's
  sourced from the repo and go fix it there.

Rejected alternative — **symlink `../docs`**: can't work. Starlight needs frontmatter titles the raw
ADRs don't have, and needs Starlight-route links, not repo-relative `.md` links. Transform, not copy.

## Content sources (reuse, don't rewrite)

- `README` / `CLAUDE.md` — elevator pitch + architecture framing → landing + `getting-started/`.
- `docs/FEATURES.md` — feature grid for both landing and docs (synced).
- `docs/adr/*` — published as the **Decisions** section, the *why* (synced).
- `loom` CLI + `loom mcp` — a reference page hand-assembled from `src-tauri/src/cli.rs`, `mcp.rs`,
  and the `loom-commands` skill (committed at `reference/cli.md`; not auto-synced since there's no
  single source doc — revisit a generator if it grows).
- Screenshots/gifs of the grid, wizard, Fleet panel, tear-off → committed under `site/src/assets/`.

## Deploy to the VPS (concrete)

Shared box with Plan 02. Plan 03 stands up nginx + TLS once; Plan 02 reuses both.

### DNS
- `loom.furevikstrand.cloud`        A/AAAA → VPS IP   (this site)
- `relay.loom.furevikstrand.cloud`  A/AAAA → VPS IP   (Plan 02 relay; reserve now, use later)

### Webroot
`/var/www/loom-site/` — the rsync target, owned by the deploy user.

### nginx — site server block
```nginx
server {
    listen 80;
    listen [::]:80;
    server_name loom.furevikstrand.cloud;

    root /var/www/loom-site;
    index index.html;

    # Astro emits clean-URL directories; match /docs/decisions/0011 and .../0011/
    location / {
        try_files $uri $uri/ $uri.html /404.html;
    }
}
# certbot --nginx injects the listen 443 + ssl_certificate lines and the 80→443 redirect.
```

### nginx — relay server block (specified here, activated in Plan 02)
Reserved so Plan 02 needs zero nginx/cert work — it just starts the relay service on the loopback
port and this block is already terminating TLS for it.
```nginx
server {
    listen 80;
    server_name relay.loom.furevikstrand.cloud;

    location / {
        proxy_pass http://127.0.0.1:8787;      # Plan 02 relay service
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade; # WSS upgrade for the dial-out bridge
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;               # long-lived dial-out WebSocket
    }
}
```

### TLS — certbot / Let's Encrypt (one cert, both names)
```bash
sudo certbot --nginx \
  -d loom.furevikstrand.cloud \
  -d relay.loom.furevikstrand.cloud \
  --agree-tos -m lozymon@gmail.com --redirect
```
- The certbot **systemd timer** handles auto-renew; verify with `sudo certbot renew --dry-run`.
- One cert covers both SANs → **Plan 02 does no cert work**.
- If `relay.` DNS isn't live when Plan 03 deploys: issue site-only first, then `certbot --expand`
  (or re-run with both `-d`) once the relay subdomain resolves.

### GitHub Action — `.github/workflows/deploy-site.yml`
```yaml
name: Deploy site
on:
  push:
    branches: [main]
    # docs/ feeds the site, so a docs-only edit must redeploy — NOT just site/**.
    paths: ['site/**', 'docs/**', '.github/workflows/deploy-site.yml']
  workflow_dispatch:
concurrency: { group: deploy-site, cancel-in-progress: true }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
          cache-dependency-path: site/package-lock.json
      - run: npm ci
        working-directory: site
      - run: npm run build          # prebuild sync (docs/→content) then astro build → site/dist
        working-directory: site
      - name: Deploy over SSH (rsync)
        run: |
          install -m 600 -D /dev/stdin ~/.ssh/id_ed25519 <<< "$SSH_KEY"
          ssh-keyscan -H "$SSH_HOST" >> ~/.ssh/known_hosts
          rsync -az --delete site/dist/ "$SSH_USER@$SSH_HOST:/var/www/loom-site/"
        env:
          SSH_KEY:  ${{ secrets.VPS_SSH_KEY }}
          SSH_HOST: ${{ secrets.VPS_HOST }}
          SSH_USER: ${{ secrets.VPS_USER }}
```
- **Secrets:** `VPS_SSH_KEY` (deploy private key), `VPS_HOST`, `VPS_USER`.
- **`--delete`** keeps the webroot byte-for-byte equal to `dist/` (stale pages removed).
- **Lock the deploy key down:** dedicated deploy user, and in its `authorized_keys` restrict the key
  with `command="rrsync -wo /var/www/loom-site",no-pty,no-port-forwarding …` so a leaked key can only
  rsync into the webroot — nothing else.

## Task checklist

- [x] **Stack:** Astro + Starlight (VitePress rejected — see rationale above).
- [x] **Location:** `site/` in this repo, self-contained lockfile, excluded from root `npm`/CI.
- [x] **Sync:** transform script (`sync-docs.mjs`) → gitignored generated tree; `docs/` single source.
- [x] **Domain/subdomains:** site at `loom.furevikstrand.cloud`, relay at
      `relay.loom.furevikstrand.cloud`; one nginx + one cert shared with Plan 02.
- [x] **Downloads:** link GitHub Releases (`/releases/latest`), no VPS-hosted artifacts.
- [x] **Analytics:** none for now.
- [ ] Scaffold `site/` (Astro + Starlight) — **not yet; deferred to build time.**
- [ ] Write `sync-docs.mjs` (H1→title, link rewrite, GitHub-blob fallback for external links).
- [ ] Author native docs: `index.mdx`, `getting-started/`, `reference/cli.md`.
- [ ] Build the landing page (`index.astro`) + capture screenshots/gifs.
- [ ] Stand up the VPS: webroot, nginx blocks, certbot; add repo secrets; land the deploy workflow.
- [ ] Confirm root `package.json` has no `workspaces` glob capturing `site/`; add `.gitignore` lines.

## Resolved (former open questions)

- **Domain / subdomains** → site `loom.furevikstrand.cloud`; relay `relay.loom.furevikstrand.cloud`;
  docs at the `/docs` **path** of the same build (no separate `docs.` subdomain needed since it's one
  Astro build). One nginx + one Let's Encrypt cert, shared with Plan 02.
- **Astro vs VitePress** → **Astro + Starlight** (bespoke landing is the tie-breaker; docs at parity;
  identical deploy).
- **`site/` in-repo vs separate repo** → **in this repo** (atomic docs↔site changes; drift-proof).
- **Analytics** → **none** for now; revisit self-hosted Plausible if traffic numbers are ever wanted.
- **Download hosting** → **link GitHub Releases**; do not re-host artifacts on the VPS.

## Out of scope

- App auto-update server (separate concern; revisit if desired).
- Self-hosted analytics (deferred; would add a `plausible.` service on the same box).
- The relay *service* itself and its auth/pairing — that's Plan 02; Plan 03 only reserves the
  subdomain and terminates its TLS.
```