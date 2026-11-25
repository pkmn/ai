# Development

Local setup, scripts, environment variables, and architecture for **pkmn.ai**. See also
[TESTING.md](TESTING.md) (`.mock` scenarios, personas, `shots`), [`AGENTS.md`](../AGENTS.md) (code
style), and [`CONTRIBUTING.md`](../.github/CONTRIBUTING.md) (prose/BibTeX).

## 1. Prerequisites & Setup

- **Node.js 24+** (`node:sqlite` `DatabaseSync`, `--env-file-if-exists=.env`)
- **Git** (runtime Djot wiki in `server/wiki.tsx`, sparse team submodules)
- **Playwright Chromium** *(optional, for `npm run shots` and `test/e2e.test.ts`)*

```sh
git clone https://github.com/pkmn/ai.git && cd ai
npm run setup                           # installs deps, sparse team submodules (reused in worktrees), builds public/
npx playwright-core install chromium    # optional: for E2E & visual tests
```

## 2. Running Locally

No `.env` secrets are required locally.

### Seeded Arena Mode (Recommended)

```sh
npm run build
npm run mock -- seed
DEV_AUTH=1 MOCK=1 npm start
```

- `mock -- seed` writes `db/data/arena.sqlite` and `.mock/` overlays (`ladders.yml`,
  `static/projects.yml`, `static/avatars/`, `wiki/`, `vgc-teams.txt`), rebuilds
  `public/arena/viewer/index.html`, and syncs `#topbar` without touching tracked configs.
- `DEV_AUTH=1 MOCK=1 npm start` serves `http://localhost:1234` with persona switching at
  `http://localhost:1234/auth/dev` (see [TESTING.md](TESTING.md)).
- For background smoke-testing and live ticking matches, run in a second terminal:

```sh
ARENA_SECRET=dev-secret DEV_AUTH=1 MOCK=1 npm start
MOCK=1 npm run mock -- simulate --server http://localhost:1234 --secret dev-secret
```

Reset mock state with `npm run clean && npm run build`.

### Unseeded Mode

Run directly against `config/ladders.yml`, `static/projects.yml`, and an optional local `wiki/`:

```sh
npm run build && DEV_AUTH=1 npm start
```

## 3. NPM Scripts

| Script | Behavior |
| :--- | :--- |
| `npm run setup` | Install deps if needed, init/repair sparse submodules & worktree `private/`, build `public/`. |
| `npm run compile` | Compile TypeScript (`tsc -p .`) into `build/`. |
| `npm run build` | Compile TS and build static Djot, BibTeX/YAML pages, and `/arena/viewer/` into `public/`. |
| `npm start` | Start `build/server` on `:1234` (live static watcher outside `NODE_ENV=production`). |
| `npm run lint` | Run `eslint --cache`, `stylelint static/style/*.css tools/*.css`, `hyperlink public --check-anchors`. |
| `npm run fix` | Auto-fix lint and CSS ordering (`eslint --fix && stylelint --fix ...`). |
| `npm run clean` | Remove `public/`, `build/`, `.tsbuildinfo`, `.eslintcache`, `.mock/`, and `db/data/`. |
| `npm test` | `npm run build && npm run lint` + full Vitest suite (`vitest run --testTimeout=15000 test`). |
| `npm run shots` | Capture/verify light & dark screenshots across 4 viewports into `.shots/`. |
| `npm run mock -- ...` | Run `.mock` scenario engine and match simulator ([TESTING.md](TESTING.md)). |
| `npm run simulate -- ...` | Run matchmaking & rating parameter-sweep simulator ([TESTING.md](TESTING.md)). |
| `npm run pkmn -- ...` | Run operator CLI against SQLite ([ADMIN.md](ADMIN.md)). |

## 4. Environment Variables & Safety Guarantees

Scripts load root `.env` via `--env-file-if-exists=.env`. All secrets are optional with `DEV_AUTH=1`:

| Variable | Local Default | Purpose |
| :--- | :--- | :--- |
| `DEV_AUTH` | unset | `1` enables loopback-only `GET /auth/dev` persona picker and ephemeral `SESSION_SECRET`. |
| `MOCK` | unset (`1` seeded) | Reads `.mock/{ladders.yml,static/projects.yml,static/avatars/,wiki/}`. |
| `NODE_ENV` | unset | `'production'` enables `https://pkmn.ai` OAuth origin, `Secure` cookies, wiki `git push`, and 60s Discord sync. |
| `SESSION_SECRET` | random hex (`DEV_AUTH=1`) | HMAC-SHA256 key for `pkmn_session` cookies and HKDF key for encrypted pull tokens. |
| `ARENA_SECRET` | unset | Bearer token for `/api/arena/*` control-plane RPCs. |
| `GITHUB_CLIENT_ID` / `_SECRET` | unset | GitHub OAuth2 (`/auth/github`). |
| `GITHUB_TOKEN` | unset | Optional GitHub token for `/admin/` registration issue polling (unauthenticated `If-None-Match` works by default). |
| `DISCORD_CLIENT_ID` / `_SECRET` | unset | Discord OAuth2 (`/auth/discord`). |
| `DISCORD_BOT_TOKEN` | unset | Role sync, `/define` interactions, chat log archival, and DMs. |
| `VGC_BOT_TOKEN` | unset | Partner API bearer token for `vgc.bot` / `pkmn.bot` `#1` Discord roles. |
| `SMOGON_TOKEN` | unset | Optional XenForo API/session token for `server/smogon.ts`. |

- **SQLite & server binding:** Local SQLite (`arena.sqlite`, `-wal`, `-shm`) lives in gitignored
  `db/data/` (never `private/`, which `site.serve()` watches). Production opens
  `/var/lib/pkmn/arena.sqlite` automatically when `/var/lib/pkmn` exists or `NODE_ENV=production`.
  The server always listens on `:1234` (`127.0.0.1:1234` in prod; `site.serve()` otherwise).
- **Side-effect isolation:** Outside `NODE_ENV=production`, `server/discord.ts` disables live sync/DMs
  and `server/wiki.tsx` skips `git push` even if `.env` holds production tokens.

## 5. Architecture & Workflows

Hybrid static + dynamic SSR/SSE ([DESIGN.md](DESIGN.md)): Nginx serves static Djot/YAML/BibTeX
pages, `/arena/viewer/`, and `.7z`/`.tar`/`.log` archives from `public/`; Node (`server/`) renders
DB-backed Arena/Project HTML & `.json` via an ETag `304` + WAL-token cache, streams SSE
(`/api/battles/stream`, `/api/tournaments/:id/stream`), and serves OAuth, `/account`, `/wiki`,
`/api/battles.json`, Discord webhooks, and `/api/arena/*`.

```text
├── config/          # ladders.yml, discord.yml, nginx.conf, systemd service/timer units
├── db/              # db/index.ts (connection + migrations) + 1-to-1 per-table modules
│   ├── schema/      # SQLite DDL (*.sql) + ER diagram (db/schema/README.md)
│   └── migration/   # Sequential SQL migrations (NNNN-description.sql)
├── docs/            # Design, setup, development, testing, historical, and admin docs
├── server/          # Polka server, OAuth, account, wiki, Discord, Arena RPC, rating & team math
├── static/          # Djot essays (*.dj), YAML/BibTeX catalogs, TSX runtime/views, CSS
├── teams/           # 1-NN team distance (teams/index.ts) & reference blocklists
├── test/            # Vitest unit, integration, rating, protocol, and Playwright E2E tests
└── tools/           # pkmn.ts (CLI), mock.ts (scenarios), simulate.ts (sweeps), shots.tsx (visual)
```

- **Views & CSS:** Author essays in [Djot](https://djot.net/) (`static/*.dj`, `static/concepts/*.dj`)
  and catalogs in `static/{projects.yml,projects.bib,research.bib,glossary.yml}`. Render HTML with
  the React-free TSX runtime in `static/dom.ts` (`h`, `Fragment`, `raw`) and put CSS in
  `static/style/*.css` / `tools/*.css`. Run `npm run shots` after UI changes ([TESTING.md](TESTING.md)).
- **Database (`db/`):** 1-to-1 `db/<table>.ts` + `db/schema/<table>.sql` ([`db/schema/README.md`](../db/schema/README.md)).
  Fresh DBs load `schema/*.sql`; existing DBs run `VACUUM INTO` backup before applying
  `db/migration/NNNN-*.sql`. Translate SQL `NULL`/`snake_case` to `undefined`/`camelCase` at the `db/`
  boundary.
- **Routes & `.json`:** `/arena/`, `/arena/ladders/:name/`, `/arena/tournaments/:id/`,
  `/arena/battles/` (`GET /api/battles.json`), `/projects/:slug/`. Emit `.json` (`/<path>.json` ===
  `/<path>/index.json`) **only** for SQLite-backed pages (`/arena`, `/arena/ladders/*`,
  `/arena/tournaments/*`, `/arena/battles`, `/projects/:slug`, `/account`).
- **Agent protocol:** Documented in [`static/rules.dj`](../static/rules.dj), implemented in
  `server/protocol.ts`, tested in `test/protocol.test.ts`.
