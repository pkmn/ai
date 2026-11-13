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
- **Shared utilities:** Import `ROOT`, `root(...paths)`, `slugify`, `toID`, `escapeHtml`, `renderTemplate`, and name/version validators from `static/util.ts` rather than re-implementing them per file.

## Terminology & Naming

- **Never use `"bot"`:** Always use **`agent`** or **`project`** in identifiers, types, file names, SQL table/column names, config keys, and UI prose. The only exceptions are external upstream names (`vgc.bot`, `PokemonShowdownBot`) in `static/projects.yml` or citations.
- **Implicit module scope:** Do not repeat the filename in exported symbols. Export `Config`, `Options`, `Entry`, `register` from `server/wiki.ts` (consumed as `wiki.Config`), not `WikiConfig` or `WikiOptions`.
- **No `DEFAULT_` prefix:** Name module constants directly (`DB_PATH`, `PROJECTS_FILE`, `AVATARS_DIR`), never `DEFAULT_DB_PATH`.
- **Terse, un-abbreviated names:** Prefer concise names where context is clear (`ram` instead of `ramMib` once documented), but spell words out instead of using cryptic abbreviations (`Millis` over `Ms`, `Seconds` over `Sec`, `auth_token_encoding` over `auth_token_enc`).
- **`@pkmn` ID casing:** Always use `toID` and `ID` (never `toId`).
- **No underscores outside SQL:**
  - **Filenames:** Prefer single-word filenames where unambiguous (`server/profile.ts`, `server/tournaments.ts`, `tools/mock.ts`, `test/api.test.ts`). When multiple words are needed, always use hyphenated **`kebab-case`** (`db/agent-versions.ts`, `db/schema/agent-versions.sql`, `db/migration/0001-example.sql`) — never `_` underscores in filenames.
  - **Identifiers:** Use `camelCase` / `PascalCase` / `UPPER_SNAKE_CASE` in TypeScript; keep `snake_case` strictly for SQLite schema columns/tables and external wire payloads.

## Comments

- Do **not** add boilerplate JSDoc comments on obvious functions, parameters, or types (this codebase is an internal site/service, not a published library).
- **Do** write concise comments explaining *why* non-obvious code exists and documenting tricky invariants (e.g., XNU `SIGSTOP` physical footprint accounting, Davidson Cholesky gauge pinning, Showdown `|t:|` ordering relative to `|turn|N`, VGC `2/N` pool sampling, and chat `|c|` elision).

## Architecture & Conventions

- **`db/` module boundaries:** `db/` contains only `db/index.ts` (connection + migrations) and 1-to-1 per-table modules (`db/<table>.ts`) owning **both** the TypeScript interfaces and SQL queries for `db/schema/<table>.sql` (with sequential migrations under `db/migration/NNNN-*.sql` tracked in `schema_migrations`). Keep pure math (`server/ratings.ts`), external API clients (`server/smogon.ts`), auth/crypto helpers (`server/auth.ts`, `server/account.ts`), and stdio/chat elision (`server/protocol.ts`) in `server/` — never create a catch-all `db/types.ts`.
- **Dev SQLite & side-effect isolation:** Default local SQLite databases and `-wal`/`-shm` files belong in gitignored `db/data/` (never `private/`, which triggers static file-watcher rebuilds). Gate production-only background loops like Discord role sync behind explicit opt-in/prod env config.
- **Immutable external IDs:** Whenever persisting external accounts (GitHub, Smogon XenForo, Discord), key uniqueness on the immutable numeric/Snowflake ID (`github_id`, `smogon_id`, `discord_id`) alongside the mutable display username.
- **Templates & CSS in `static/`:** Never inline large HTML, CSS, or client `<script>` blocks inside `server/*.ts`. Place stylesheets in `static/*.css` (checked by `stylelint` for property order and `no-descending-specificity`) and HTML templates in `static/*.html` rendered via `renderTemplate`.
- **Config & CLI flags:** Load secrets from root `.env` via `--env-file-if-exists=.env` without multi-file YAML/env fallback chains. Put ladder-specific parameters (`team_count`, `pool_dirs`, `min_agents`) in `config/ladders.yml`, and require explicit CLI flags in `teams/` and `tools/` rather than magic path/default inference. Never canonicalize or watermark static human team files on disk; canonicalize exclusively at runtime when loading/packing teams.
- **Routes & `.json` endpoints:**
  - `/arena/` is the central hub, `/arena/ladders/:name/` hosts ladders, `/arena/tournaments/:id/` hosts tournaments, `/arena/battles/` hosts the live tracker + inline-expandable paginated battle history (`GET /api/battles.json`), and `/projects/:slug/` hosts per-agent statistical profiles.
  - Expose `.json` (`/<path>.json` === `/<path>/index.json`) **only** for SQLite database-backed pages (`/arena`, `/arena/ladders/*`, `/arena/tournaments/*`, `/arena/battles`, `/projects/:slug`, `/account`). Never emit `.json` endpoints for static YAML/BibTeX/Djot/git pages (`/projects`, `/glossary`, `/research`, `/wiki*`, prose essays).
  - Full battle logs and `teams.json` for competitor-submitted `pools` ladders may only be published **after** the ladder status is `archived` (retired).
- **Qualification & account permissions (`pending` vs `qualified`):**
  - Registering an `arena:` block in `static/projects.yml` with `qualified: false` (`agents.status = 'pending'`) **intentionally** grants registered owners immediate access to `/wiki*` editing and scheduled tournament submissions (`/account/`), while gating continuous ladder submissions behind `qualified: true` (`agents.status = 'qualified'`). Only `disabled` accounts (`agents.status = 'disabled'`) are blocked from tournaments and `/account/`.
- **`pools` ladder fairness & team canonicalization invariants:**
  - `samplePoolsPair` (`server/teams.ts`) **intentionally** samples active competitors' own rosters with marginal probability `2/N` (`{A, C}` with `2/N`, `{B, C}` with `2/N`, `{C1, C2}` with `(N-4)/N`, and at most 1 of the 2 match teams from `{A, B}` combined). Never dealing competitors their own submitted teams would remove skin-in-the-game and incentivize poisoning the shared pool with weak teams the author never has to pilot; any single-game hidden-information asymmetry is neutralized across the 2-game mirror pair because P1 and P2 swap teams in Game 2.
  - `@pkmn/sets` `Team.canonicalize` deterministically sorts all 6 team slots and 4 move slots (neutralizing Team Preview slot-order watermarking) while preserving explicit under-leveled sets (`s.level = s.level || (champions ? 50 : 100)`).
  - `THRESHOLD = 1.30` in `teams/index.ts` intentionally permits teams sharing 5 of 6 species (`+1.0` from the swapped 6th slot) provided the 5 shared Pokémon contribute at least `+0.30` in set distance.

## Verification

- Run `npm run test` (`tsc -p .`, static build, `eslint --cache`, `stylelint static/*.css`, and `hyperlink public --check-anchors`) and `npx vitest run` before considering any change complete.
- When modifying HTML templates, CSS, or client scripts, run `npm run shots` to verify all viewports (`375px` `small` through `desktop` in `light` and `dark` themes) have zero console/page errors and zero horizontal overflow (`scrollWidth <= innerWidth`), inspect changed `.shots/` PNGs directly, and re-run `npm run clean && npm run test` afterward so `public/` contains no mock artifacts.
