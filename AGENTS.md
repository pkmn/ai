# `pkmn.ai` Agent Guidelines

Repository-specific style, naming, and architectural rules for AI coding agents working in `pkmn/ai`. Always follow these alongside `@pkmn/eslint-config` (`node_modules/@pkmn/eslint-config/README.md`).

## TypeScript & `@pkmn` Style

- **`undefined` over `null`:** Always use `undefined` (and optional properties `foo?: Bar`) instead of `null` in TypeScript. Translate `NULL` to/from `undefined` immediately at the SQLite row boundary. Initialize class fields in constructors so V8 object shapes stay monomorphic.
- **Formatting:** 2-space indentation (never tabs), **100-character** maximum line length, and single quotes `'` everywhere (use template literals `` `...` `` instead of string concatenation; never `"` in TypeScript).
- **String literal unions, never `enum`:** Do not use TypeScript `enum`. Use string literal union types:
  - Prefer `'Title Case'` for concepts written in title case in prose.
  - Use `'lowercase'` when every literal is a single word that would not appear in title case.
  - Use `'camelCase'` only when directly mapping to `keyof` an interface/object.
  - Never use `'snake_case'` or `'kebab-case'` in new string literal unions (except external Pokémon Showdown protocol strings or SQL enum columns).
- **Imports & exports:**
  - Prefer plain `import` / `export`; only use `import type` / `export type` when strictly required by `isolatedModules` or a value/type collision.
  - When a named import or export list would wrap past one 100-char line, use a namespace import/export instead (`import * as render from './render'`).
  - Never disable `@typescript-eslint/no-shadow`, `@typescript-eslint/no-floating-promises`, or `@typescript-eslint/no-misused-promises` with `eslint-disable`; fix the promise handling or use namespace imports / non-shadowing names.
- **Shared utilities:** Import `ROOT`, `root(...paths)`, `slugify`, `toID`, `escapeHtml`, `raw`, `h`, `Fragment`, `TablePager`, `readBody`, `writeFileAtomic`, `copyFileAtomic`, and name/version validators from `static/util.tsx` rather than re-implementing them per file.
- **Structured parameters & domain substructs (never flat parameter bags):** Keep positional parameter lists to $\le 7\text{–}8$ arguments. More importantly, **switching a long positional list to a single giant flat `{...}` object is still bad** — any options object, payload, or domain interface with many fields should itself be decomposed into logical substructs rather than left as a flat 15–30 property bag:
  - Group symmetric per-player fields into `p1` / `p2` substructs (`MirrorPlayer`, `PlayerGameResult`, `MountedEntrant`, `GamePlayerStats`) and multi-game series into a `games` array rather than flattening `p1VersionId`/`p2VersionId` or `game1*`/`game2*`/`game3*` top-level fields.
  - Group cohesive domain state and repeated context (`TopKClock`, `RankBoundsPosterior`, `AgentLinkContext`, `GuildCache`) into reusable substructs composed inside larger interfaces and options objects.
  - **Database table exemption:** Structs that map directly to/from a SQLite database table or query view (`*Row`, `Raw*Row`, `*View`, and direct row write payloads) are exempt — do not artificially nest 1-to-1 SQL column mappings into substructs when the underlying table is intentionally flat.

## Terminology & Naming

- **Never use `"bot"`:** Always use **`agent`** or **`project`** in identifiers, types, file names, SQL table/column names, config keys, and UI prose. The only exceptions are external upstream names (`vgc.bot`, `PokemonShowdownBot`) in `static/projects.yml` or citations.
- **Implicit module scope:** Do not repeat the filename in exported symbols. Export `Config`, `Options`, `Entry`, `register` from `server/wiki.tsx` (consumed as `wiki.Config`), not `WikiConfig` or `WikiOptions`.
- **No `DEFAULT_` prefix:** Name module constants directly (`DB_PATH`, `PROJECTS_FILE`, `AVATARS_DIR`), never `DEFAULT_DB_PATH`.
- **Terse, un-abbreviated names:** Prefer concise names where context is clear (`ram` instead of `ramMib` once documented), but spell words out instead of using cryptic abbreviations (`Millis` over `Ms`, `Seconds` over `Sec`, `auth_token_encoding` over `auth_token_enc`).
- **`@pkmn` ID casing:** Always use `toID` and `ID` (never `toId`).
- **No underscores outside SQL:**
  - **Filenames:** Prefer single-word filenames where unambiguous (`server/profile.tsx`, `server/tournaments.tsx`, `tools/mock.ts`, `test/api.test.ts`). When multiple words are needed, always use hyphenated **`kebab-case`** (`db/agent-versions.ts`, `db/schema/agent-versions.sql`, `db/migration/0001-example.sql`) — never `_` underscores in filenames.
  - **Identifiers:** Use `camelCase` / `PascalCase` / `UPPER_SNAKE_CASE` in TypeScript; keep `snake_case` strictly for SQLite schema columns/tables and external wire payloads.

## Comments

- Do **not** add boilerplate JSDoc comments on obvious functions, parameters, or types (this codebase is an internal site/service, not a published library).
- **Do** write concise comments explaining *why* non-obvious code exists and documenting tricky invariants (e.g., XNU `SIGSTOP` physical footprint accounting, Davidson Cholesky gauge pinning, Showdown `|t:|` ordering relative to `|turn|N`, VGC `2/N` pool sampling, and chat `|c|` elision).

## Architecture & Conventions

- **`db/` module boundaries:** `db/` contains only `db/index.ts` (connection + migrations) and 1-to-1 per-table modules (`db/<table>.ts`) owning **both** the TypeScript interfaces and SQL queries for `db/schema/<table>.sql` (with sequential migrations under `db/migration/NNNN-*.sql` tracked in `schema_migrations`). Keep pure math (`server/ratings.ts`), external API clients (`server/smogon.ts`), auth/crypto helpers (`server/auth.ts`, `server/account.tsx`), and stdio/chat elision (`server/protocol.ts`) in `server/` — never create a catch-all `db/types.ts`.
- **Dev SQLite & side-effect isolation:** Default local SQLite databases and `-wal`/`-shm` files belong in gitignored `db/data/` (never `private/`, which is watched by `site.serve`), and production opens `/var/lib/pkmn/arena.sqlite` automatically when `/var/lib/pkmn` exists or `NODE_ENV=production` (no `ARENA_DB_PATH` override). Production-only side effects (`server/discord.ts` 60s sync loop, `server/wiki.tsx` `git push`, `https://pkmn.ai` OAuth origin, `Secure` cookies) are gated strictly on `NODE_ENV === 'production'` (no `DISCORD_SYNC` / `WIKI_PUSH` / `PUBLIC_URL` env toggles). The HTTP server always listens on port `1234` (no `PORT`/`HOST` env vars), binding `127.0.0.1:1234` in `NODE_ENV === 'production'` and booting via `site.serve` otherwise (live static rebuilds + LAN IP display).
- **Immutable external IDs:** Whenever persisting external accounts (GitHub, Smogon XenForo, Discord), key uniqueness on the immutable numeric/Snowflake ID (`github_id`, `smogon_id`, `discord_id`) alongside the mutable display username.
- **TSX views & CSS in `static/`, `server/` & `tools/`:** Render HTML views using the custom React-free TSX runtime in `static/dom.ts` (`h`, `Fragment`, `raw`) across `.tsx` modules (`static/*.tsx`, `server/*.tsx`, `tools/shots.tsx`) rather than string-concatenated HTML or `.html` template files. Place page stylesheets in `static/style/*.css` / `tools/*.css` (checked by `stylelint` for property order and `no-descending-specificity`).
- **Config, hardcoded canonical paths & single pathways:**
  - Load secrets flat from root `.env` via `--env-file-if-exists=.env` without multi-file YAML/env fallback chains.
  - Keep `config/discord.yml` and `config/ladders.yml` (mtime-cached on read). In `config/ladders.yml`, `version` is optional and defaults to `SIM_VERSION = '0.11.0'` (explicit per-ladder overrides are supported by the multi-version `sim/<version>` worker pool), and minimum active agents are hardcoded by team mode (`minAgentsForTeamMode`: `4` for `pools`, `2` otherwise — no `min:` key).
  - Hardcode canonical production paths (`packages.PROD_DIRS`, `/opt/arena/state/arena.sqlite`, `/Volumes/Archive`, `gs://pkmn-arena`) instead of adding per-directory env vars (`ARENA_*_DIR`, `ARENA_STATE_DB*`) or multi-directory option bags; tests isolate state via a single `rootDir` (`packages.dirsForRoot(rootDir)`).
  - Keep **one** canonical pathway per operation: admin-only mutations (`upload-ladder-teams`, `publish-tournament-archive`) run exclusively via `npm run pkmn` CLI (no duplicate HTTP routes); `arena/coordinator.ts` owns daily `.7z` log compression for all ladders on UTC day rollover plus `<ladderId>-logs.tar` upload, while `arena/scripts/archive.sh` owns only mount verification, daily SQLite `.backup`/zstd, 1st-of-month `.tar` rollups, and `gcloud storage rsync`; `arena/bin/limit.c` is strictly root-only fail-closed (`exit 126`) with no unprivileged dev/test mode.
  - Require explicit CLI flags in `teams/` and `tools/` rather than magic path/default inference. Never canonicalize or watermark static human team files on disk; canonicalize exclusively at runtime when loading/packing teams.
- **Trusted internal control plane vs. untrusted boundaries (important for security reviews):**
  - **We own both ends of the stack** (`pkmn.ai` web server, admin CLI `tools/pkmn.ts`, `config/*.yml`, and our own Mac mini / GCP `arena/` coordinators live in this repo and share TypeScript interfaces). Never add defensive "protection" against inputs we completely control — including `Bearer $ARENA_SECRET`-authenticated `/api/arena/*` IDs/payloads (e.g. `game.id` / `match.id` path-traversal guards, field-by-field JSON schema parsers, numeric/enum coercion, legacy wire fallbacks, or re-running `sim.validateTeam` on pre-assigned server teams), admin CLI arguments (`pkmn install-sim`, `rotate-ladder`), `config/ladders.yml` values (`version`), or our own server->browser DB/SSE payloads (`completedAt`, `seed`, `games`). Keep only Bearer authentication, body size limits, lifecycle state gates, SHA-256 binary integrity verification, and `pools` privacy/viewer sanitization on `/api/arena/*`.
  - **Keep strict validation on all untrusted external boundaries:** competitor bundle/OCI/rootfs unpacking (`arena/unpack.ts`, `arena/packages.ts`, `arena/tournament.ts` `finalizeUnpackedOciRootfs`), sandboxed agent stdio & tournament `/utm` submissions (`server/protocol.ts`, `arena/arbiter.ts`, `arena/tournament.ts`), human team pastes (`server/teams.ts`, `server/account.tsx`), sandbox & privilege enforcement (`arena/bin/limit.c`, `arena/bin/arena`, `arena/config/sandbox.sb`, `pf.anchor`, `sudoers`), OAuth/CSRF/session/Bearer/Discord Ed25519 authentication (`server/auth.ts`, `server/discord.ts`), wiki Djot/slug/git checks (`server/wiki.tsx`), Smogon redirect host checks (`server/smogon.ts`), Showdown viewer `postMessage` origin checks, and `pools` privacy publication gates.
- **Routes & `.json` endpoints:**
  - `/arena/` is the central hub, `/arena/ladders/:name/` hosts ladders, `/arena/tournaments/:id/` hosts tournaments, `/arena/battles/` hosts the live tracker + inline-expandable paginated battle history (`GET /api/battles.json`), and `/projects/:slug/` hosts per-agent statistical profiles.
  - Expose `.json` (`/<path>.json` === `/<path>/index.json`) **only** for SQLite database-backed pages (`/arena`, `/arena/ladders/*`, `/arena/tournaments/*`, `/arena/battles`, `/projects/:slug`, `/account`). Never emit `.json` endpoints for static YAML/BibTeX/Djot/git pages (`/projects`, `/glossary`, `/research`, `/wiki*`, prose essays).
  - Full battle logs and `teams.json` for competitor-submitted `pools` ladders may only be published **after** the ladder status is `archived` (retired).
- **Qualification & account permissions (`pending` vs `qualified`):**
  - Registering an `arena:` block in `static/projects.yml` with `qualified: false` (`agents.status = 'pending'`) **intentionally** grants registered owners immediate access to `/wiki*` editing and scheduled tournament submissions (`/account/`), while gating continuous ladder submissions behind `qualified: true` (`agents.status = 'qualified'`). Only `disabled` accounts (`agents.status = 'disabled'`) are blocked from tournaments and `/account/`.
- **`pools` ladder fairness & team canonicalization invariants:**
  - `samplePoolsPair` (`server/teams.ts`) **intentionally** samples active competitors' own rosters with marginal probability `2/N` (`{A, C}` with `2/N`, `{B, C}` with `2/N`, `{C1, C2}` with `(N-4)/N`, and at most 1 of the 2 match teams from `{A, B}` combined). Never dealing competitors their own submitted teams would remove skin-in-the-game and incentivize poisoning the shared pool with weak teams the author never has to pilot; any single-game hidden-information asymmetry is neutralized across the 2-game mirror pair because P1 and P2 swap teams in Game 2.
  - `@pkmn/sets` `Team.canonicalize` deterministically sorts all 6 team slots and 4 move slots (neutralizing Team Preview slot-order watermarking) while **intentionally** preserving `shiny`, `gender`, and explicit under-leveled sets (`s.level = s.level || (champions ? 50 : 100)`) on stored/battle packed teams because `shiny` and `gender` affect legality and battle mechanics (event moves, shiny-locked legendaries, `Rivalry`, `Attract`, `Cute Charm`). Only distinctness / cross-competitor deduplication (`canonicalDedupeKey` and `toUniquenessEntry` in `server/teams.ts`) strips `shiny`, `gender`, and levels above `defaultLevel` (`50` in VGC/Champions).
  - `THRESHOLD = 1.30` in `teams/index.ts` intentionally permits teams sharing 5 of 6 species (`+1.0` from the swapped 6th slot) provided the 5 shared Pokémon contribute at least `+0.30` in set distance.
  - Agents execute in an **airgapped sandbox with zero network access** (macOS Seatbelt `(deny network*)` + `/etc/pf.anchors/ai.pkmn.arena` for native bundles, `podman run --network=none` for containers). Observing opponent sets during a game cannot exfiltrate private teams off the Arena host; only cross-game local persistence matters, which is prevented by wiping `/Volumes/P1` and `/Volumes/P2` around every game.

## Verification

- Run `npm run test` (`tsc -p .`, static build, `eslint --cache`, `stylelint static/style/*.css tools/*.css`, and `hyperlink public --check-anchors`) and `npx vitest run` before considering any change complete.
- When modifying TSX views, CSS, or client scripts, run `npm run shots --
  --baseline` before your changes and `npm run shots` afterward to verify all
  viewports (`375px` `small` through `desktop` in `light` and `dark` themes)
  have zero console/page errors and zero horizontal overflow (`scrollWidth <=
  innerWidth`), inspect visual diffs in `.shots/index.html` and changed
  `.shots/` PNGs directly, and re-run `npm run clean && npm run test` afterward
  so `public/` contains no mock artifacts. Always include links to the relevant
  screenshots that changed (light mode desktop) in the response to the user, and
  include the full path on disk to the .shots/index.html file in case you are
  working in a git-worktree
- **Keep `tools/shots.tsx` scenarios in sync with the UI:** Whenever adding, modifying, or removing a route, UI view, interactive control, lifecycle state, or error/edge case, add or update the corresponding scenario(s) in `tools/shots.tsx` (`buildScenarios`) and `docs/TESTING.md` so the `.shots/index.html` Visual Atlas never goes stale.
