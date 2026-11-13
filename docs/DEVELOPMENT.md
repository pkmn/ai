# Development

This guide covers everything needed to set up, understand, modify, and run the **pkmn.ai** stack
locally.

For interactive persona testing, `.mock` scenarios, and screenshot verification, see
[TESTING.md](TESTING.md). For code style and naming rules, see [`AGENTS.md`](../AGENTS.md); for
prose/BibTeX content guidelines, see [`CONTRIBUTING.md`](../.github/CONTRIBUTING.md).

---

## 1. Prerequisites & First-Time Setup

- **Node.js 24+** (uses Node's built-in `node:sqlite` `DatabaseSync` and `--env-file-if-exists=.env`)
- **Git** (used at runtime by the Djot wiki in `server/wiki.ts` and sparse-checkout team submodules)
- **Playwright Chromium** *(optional, required for `npm run shots` and `test/e2e.test.ts`)*

Clone the repository, install dependencies, and initialize the sparse-checked-out reference team
submodules (used for `pools` ladder $1\text{-NN}$ uniqueness validation) and static build:

```sh
git clone https://github.com/pkmn/ai.git
cd ai

# Install Node dependencies, initialize sparse team submodules, and build static pages
# (In git worktrees, `npm run setup` reuses the main checkout's submodule cache and `private/`.)
npm run setup

# Optional: install headless Chromium for E2E and visual regression tests
npx playwright-core install chromium
```

---

## 2. Running the Stack Locally

Zero `.env` secrets are required to run the stack locally.

### Seeded Arena Mode (Recommended)

To explore populated leaderboards, Elo charts, battle history, Championship Tournaments, developer
account onboarding stages, and a Git-backed wiki on `http://localhost:1234`:

```sh
npm run build
npm run mock -- seed
MOCK=1 npm run dev
```

- `npm run mock -- seed` writes `db/data/arena.sqlite` and `.mock/` overlays (`.mock/ladders.yml`,
  `.mock/static/projects.yml`, `.mock/static/avatars/`, `.mock/wiki/`, `.mock/vgc-teams.txt`) and
  pre-renders all static Arena HTML and `.json` views into `public/` without touching tracked
  `config/ladders.yml` or `static/projects.yml`.
- `MOCK=1 npm run dev` starts the unified Polka + static file-watcher server on
  `http://localhost:1234` with `DEV_AUTH=1` enabled (visit `http://localhost:1234/auth/dev` to
  switch developer personas; see [TESTING.md](TESTING.md)).
- To simulate live background Arena activity (automatic smoke-testing of `/account/` submissions and
  multi-turn ticking clocks on `/arena/battles/`), run in a second terminal:

```sh
ARENA_SECRET=dev-secret MOCK=1 npm run dev
# Second terminal:
MOCK=1 npm run mock -- simulate --server http://localhost:1234 --secret dev-secret
```

To wipe all mock overlays and return to clean unseeded configs:

```sh
rm -rf .mock db/data/arena.sqlite* && npm run build
```

### Unseeded Mode

To run directly against the base `config/ladders.yml`, `static/projects.yml`, and optional local
`wiki/` checkout:

```sh
npm run build
npm run dev
```

---

## 3. NPM Scripts

| Script | Command / Behavior |
| :--- | :--- |
| `npm run setup` | Install dependencies if needed, initialize/repair sparse submodules & worktree `private/`, and build `public/`. |
| `npm run compile` | Compile TypeScript (`tsc -p .`) into `build/`. |
| `npm run build` | Compile TypeScript and build all static Djot, BibTeX/YAML, and Arena pages into `public/`. |
| `npm run dev` | Start the local server on `http://localhost:1234` with `DEV_AUTH=1` and static file watching. |
| `npm start` | Start `build/server` without `DEV_AUTH=1` (production entrypoint). |
| `npm run lint` | Run `eslint --cache`, `stylelint static/*.css`, and `hyperlink public --check-anchors`. |
| `npm run fix` | Auto-fix lint and CSS ordering issues (`eslint --fix && stylelint --fix static/*.css`). |
| `npm run clean` | Remove `public/`, `build/`, `.tsbuildinfo`, and `.eslintcache`. |
| `npm run test` | Run `npm run build && npm run lint`. |
| `npm run test:integration` | Run `npm run test` followed by the full Vitest suite (`vitest test`). |
| `npm run shots` | Capture & verify responsive light/dark screenshots across 4 viewports into `.shots/`. |
| `npm run mock -- ...` | Run the `.mock` scenario engine and match simulator (see [TESTING.md](TESTING.md)). |
| `npm run pkmn -- ...` | Run the operator CLI against SQLite (see [ADMIN.md](ADMIN.md)). |

---

## 4. Environment Variables & Side-Effect Isolation

All scripts load `.env` automatically via `--env-file-if-exists=.env` (no multi-file config
fallbacks). Every secret is optional in local `DEV_AUTH=1` development:

| Variable | Local Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `1234` | HTTP port bound by `server/index.ts`. |
| `PUBLIC_URL` | `http://localhost:1234` (`dev`) | Canonical origin used when constructing OAuth redirect URIs. |
| `DEV_AUTH` | `1` in `npm run dev` | Enables loopback-only `GET /auth/dev` persona switcher and ephemeral fallback `SESSION_SECRET`. |
| `MOCK` | unset (`1` when seeded) | Reads `.mock/ladders.yml`, `.mock/static/projects.yml`, `.mock/static/avatars/`, and `.mock/wiki/`. |
| `ARENA_DB_PATH` | `db/data/arena.sqlite` | Overrides SQLite path (defaults to `/var/lib/pkmn/arena.sqlite` when `/var/lib/pkmn` exists or `NODE_ENV=production`). |
| `NODE_ENV` | unset (`development`) | Enables `Secure` cookies and automatic 60-second Discord sync when `'production'`. |
| `DISCORD_SYNC` | unset | Set to `1` only to opt in to live Discord role/pin/DM mutations outside production. |
| `SESSION_SECRET` | ephemeral random hex (`DEV_AUTH=1`) | HMAC-SHA256 signing secret for `pkmn_session` cookies and HKDF key for encrypted submission pull tokens. |
| `ARENA_SECRET` | unset | Bearer token authenticating `/api/arena/*` worker control-plane requests. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | unset | GitHub OAuth2 credentials for `/auth/github`. |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | unset | Discord OAuth2 credentials for `/auth/discord`. |
| `DISCORD_BOT_TOKEN` | unset | Discord API token for role sync, `/define` interactions, chat log archival, and DMs. |
| `VGC_BOT_TOKEN` | unset | Partner API bearer token for syncing `vgc.bot` / `pkmn.bot` `#1` Discord roles. |
| `SMOGON_TOKEN` | unset | Optional XenForo API/session token for `server/smogon.ts` member lookups. |

**Local safety guarantees:**
1. **SQLite isolation:** Local SQLite files (`arena.sqlite`, `-wal`, `-shm`) live in gitignored
   `db/data/` — never inside `private/`, which is watched by `site.serve()` and would trigger
   infinite rebuild loops.
2. **Discord isolation:** Even if `.env` contains production `DISCORD_BOT_TOKEN` synced via
   `./private/sync`, `server/discord.ts` disables live role/pin/DM/log sync whenever
   `NODE_ENV !== 'production'` unless `DISCORD_SYNC=1` is explicitly passed.

---

## 5. Architecture & Codebase Map

**pkmn.ai** uses a static-first architecture ([DESIGN.md](DESIGN.md)): public pages and database-backed
`.json` mirrors are atomically pre-rendered into `public/` so Nginx + Cloudflare serve spectator
traffic directly from disk, while Node.js (`server/`) handles OAuth, authenticated SSR (`/account`,
`/wiki`), paginated battle queries (`/api/battles.json`), Discord webhooks, and the `/api/arena/*`
worker control plane.

```text
├── config/          # ladders.yml, discord.yml, nginx.conf, and systemd service/timer units
├── db/              # Database connection/migrations (db/index.ts) + 1-to-1 per-table modules
│   ├── schema/      # Declarative SQLite table DDL (*.sql) + ER diagram (db/schema/README.md)
│   └── migration/   # Sequential versioned SQL migrations (NNNN-description.sql)
├── docs/            # Project design, setup, development, testing, and admin documentation
├── server/          # Polka server, OAuth, account, wiki, Discord, Arena RPC, rating & team math
├── static/          # Djot essays (*.dj), projects/research/glossary catalogs, HTML templates, CSS
├── teams/           # 1-NN team distance workspace (teams/index.ts) & reference blocklist pools
├── test/            # Vitest unit, integration, rating solver, protocol, and Playwright E2E suites
└── tools/           # Operator CLI (pkmn.ts), scenario simulator (mock.ts), visual verifier (shots.ts)
```

### Key Workflows When Making Changes

- **Static content, templates & CSS (`static/`):**
  - Essays and concept pages are authored in [Djot](https://djot.net/) (`static/*.dj`,
    `static/concepts/*.dj`), with catalogs in `static/projects.yml`, `static/projects.bib`,
    `static/research.bib`, and `static/glossary.yml`.
  - Keep page HTML templates in `static/*.html` (rendered via `renderTemplate` from
    `static/util.ts`) and stylesheets in `static/*.css` (never inline large HTML/CSS/JS blocks in
    `server/*.ts`).
  - After changing templates, CSS, or client scripts, run `npm run shots` to verify zero console
    errors and zero horizontal overflow across viewports and themes (see [TESTING.md](TESTING.md)).
- **Database tables & migrations (`db/`):**
  - Each SQLite table owns a 1-to-1 module `db/<table>.ts` (both TypeScript types and SQL queries)
    paired with `db/schema/<table>.sql` (see [`db/schema/README.md`](../db/schema/README.md)).
  - Fresh databases execute `db/schema/*.sql` directly and mark existing migrations applied;
    existing databases create an automatic `VACUUM INTO` backup before applying new sequential
    `db/migration/NNNN-description.sql` files tracked in `schema_migrations`.
  - Always translate SQL `NULL` and `snake_case` columns to `undefined` and `camelCase` immediately
    at the `db/` row boundary.
- **Routes & `.json` endpoints:**
  - `/arena/` is the central hub, `/arena/ladders/:name/` hosts ladders, `/arena/tournaments/:id/`
    hosts tournaments, `/arena/battles/` hosts the live tracker + paginated history
    (`GET /api/battles.json`), and `/projects/:slug/` hosts per-agent statistical profiles.
  - Expose `.json` (`/<path>.json` === `/<path>/index.json`) **only** for SQLite database-backed
    pages (`/arena`, `/arena/ladders/*`, `/arena/tournaments/*`, `/arena/battles`,
    `/projects/:slug`, `/account`) — never for static YAML/BibTeX/Djot/Git pages.
- **Agent protocol (`PROTOCOL.md`):**
  - Stdio lifecycle, chat/covert-channel elision, and timer rules live in
    [`PROTOCOL.md`](../PROTOCOL.md), implemented in `server/protocol.ts` and tested by
    `test/protocol.test.ts`.
