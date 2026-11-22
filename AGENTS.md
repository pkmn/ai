# `pkmn.ai` Agent Guidelines

Repo-specific style, naming, and architecture rules alongside `@pkmn/eslint-config`
(`node_modules/@pkmn/eslint-config/README.md`).

## TypeScript & `@pkmn` Style

- **`undefined` over `null`:** Use `undefined` and `foo?: Bar` in TS; translate SQLite `NULL` at the
  row boundary. Initialize class fields in constructors for monomorphic V8 shapes.
- **Formatting:** 2-space indent, 100-char max line length, single quotes `'` (template literals over
  concatenation; never `"` in TS).
- **String literal unions, never `enum`:** Use `'Title Case'` for prose-titled concepts, `'lowercase'`
  for single words, `'camelCase'` only when mapping to `keyof`. Never `'snake_case'` or `'kebab-case'`
  in new unions (except Showdown protocol strings or SQL enums).
- **Imports & exports:** Prefer plain `import`/`export` (use `import type`/`export type` only for
  `isolatedModules` or value/type collisions). Use namespace imports/exports (`import * as render from './render'`)
  when a named list would wrap past 100 chars. Never `eslint-disable`
  `@typescript-eslint/no-shadow`, `no-floating-promises`, or `no-misused-promises`.
- **Shared utilities:** Import `ROOT`, `root(...paths)`, `slugify`, `toID`, `escapeHtml`, `raw`, `h`,
  `Fragment`, `TablePager`, `readBody`, `writeFileAtomic`, `copyFileAtomic`, and name/version
  validators from `static/util.tsx`.
- **Structured params & substructs:** Keep positional args $\le 7\text{–}8$, and decompose large
  options/domain interfaces into substructs instead of flat 15–30 property bags:
  - Group per-player fields into `p1`/`p2` substructs (`MirrorPlayer`, `PlayerGameResult`,
    `MountedEntrant`, `GamePlayerStats`) and series into a `games` array.
  - Reuse cohesive domain substructs (`TopKClock`, `RankBoundsPosterior`, `AgentLinkContext`,
    `GuildCache`).
  - **SQLite exemption:** Direct 1-to-1 table/view structs (`*Row`, `Raw*Row`, `*View`, row write
    payloads) stay flat.

## Terminology & Naming

- **Never `"bot"`:** Always use **`agent`** or **`project`** everywhere (identifiers, types, files,
  SQL, config, UI), except upstream names (`vgc.bot`, `PokemonShowdownBot`) in `static/projects.yml`
  or citations.
- **Implicit module scope:** Don't repeat filenames in exports (`Config`, `Options`, `Entry`,
  `register` from `server/wiki.tsx`, consumed as `wiki.Config`).
- **No `DEFAULT_` prefix:** Name constants directly (`DB_PATH`, `PROJECTS_FILE`, `AVATARS_DIR`).
- **Terse, un-abbreviated names:** Prefer `ram` over `ramMib` once documented; spell out `Millis`,
  `Seconds`, `auth_token_encoding` (not `Ms`, `Sec`, `auth_token_enc`).
- **`@pkmn` ID casing:** Always `toID` and `ID` (never `toId`).
- **No underscores outside SQL:** Filenames are single-word (`server/profile.tsx`, `tools/mock.ts`)
  or `kebab-case` (`db/agent-versions.ts`, `db/migration/0001-example.sql`). TS identifiers use
  `camelCase`/`PascalCase`/`UPPER_SNAKE_CASE`; reserve `snake_case` for SQL and external wire payloads.

## Comments

- Skip boilerplate JSDoc on obvious code (internal service, not a published library).
- Document *why* non-obvious invariants exist (XNU `SIGSTOP` footprint accounting, Davidson Cholesky
  gauge pinning, Showdown `|t:|` vs `|turn|N` ordering, VGC `2/N` pool sampling, chat `|c|` elision).

## Architecture & Conventions

- **Don't cache — fix the design:** Caching is cope for a slow or leaky design. Never pursue ad-hoc
  caching (`Map`s, memoization layers) to mask repeated work — redesign the underlying lifecycle or
  data flow to be fast instead (reuse existing singletons/build artifacts, load static repo assets
  once at module init, eliminate redundant per-request or per-test work).
- **`db/` boundaries:** Contains only `db/index.ts` (connection + migrations) and 1-to-1 `db/<table>.ts`
  owning both TS interfaces and SQL queries for `db/schema/<table>.sql` (migrations in
  `db/migration/NNNN-*.sql`, tracked in `schema_migrations`). Pure math (`server/ratings.ts`), API
  clients (`server/smogon.ts`), auth (`server/auth.ts`, `server/account.tsx`), and protocol
  (`server/protocol.ts`) live in `server/` — never a catch-all `db/types.ts`.
- **SQLite & side-effect isolation:** Dev SQLite lives in gitignored `db/data/` (never `private/`,
  watched by `site.serve`); prod auto-opens `/var/lib/pkmn/arena.sqlite` when `/var/lib/pkmn` exists
  or `NODE_ENV=production` (no `ARENA_DB_PATH`). Gate prod side effects (`server/discord.ts` 60s sync,
  `server/wiki.tsx` `git push`, `https://pkmn.ai` OAuth origin, `Secure` cookies) strictly on
  `NODE_ENV === 'production'`. Server always listens on port `1234` (no `PORT`/`HOST`): `127.0.0.1:1234`
  in prod, `site.serve` otherwise.
- **Immutable external IDs:** Key external account uniqueness on immutable numeric/Snowflake IDs
  (`github_id`, `smogon_id`, `discord_id`) alongside mutable usernames.
- **TSX & CSS:** Render HTML with the React-free TSX runtime in `static/dom.ts` (`h`, `Fragment`,
  `raw`) across `.tsx` files (`static/*.tsx`, `server/*.tsx`, `tools/shots.tsx`). Put CSS in
  `static/style/*.css` / `tools/*.css` (`stylelint`-checked).
- **Config, canonical paths & single pathways:**
  - Load flat secrets from root `.env` via `--env-file-if-exists=.env`.
  - Keep mtime-cached `config/discord.yml` and `config/ladders.yml` (`version` defaults to
    `SIM_VERSION = '0.11.0'`; `minAgentsForTeamMode` hardcodes `4` for `pools`, `2` otherwise — no
    `min:` key).
  - Hardcode prod paths (`packages.PROD_DIRS`, `/opt/arena/state/arena.sqlite`, `/Volumes/Archive`,
    `gs://pkmn-arena`); isolate tests via one `rootDir` (`packages.dirsForRoot(rootDir)`).
  - One pathway per op: admin mutations (`upload-ladder-teams`, `publish-tournament-archive`) via
    `npm run pkmn` only; `arena/coordinator.ts` owns daily `.7z` log compression + `<ladderId>-logs.tar`
    upload while `arena/scripts/archive.sh` owns mount checks, daily SQLite `.backup`/zstd, 1st-of-month
    `.tar` rollups, and `gcloud storage rsync`; `arena/bin/limit.c` is strictly root-only fail-closed
    (`exit 126`).
  - Explicit CLI flags in `teams/` and `tools/` (no magic inference). Never canonicalize static human
    team files on disk; canonicalize at runtime.
- **Trusted control plane vs. untrusted boundaries:**
  - **We own both ends** (`pkmn.ai`, `tools/pkmn.ts`, `config/*.yml`, `arena/` coordinators). Never
    add defensive validation/coercion/path-traversal guards/legacy fallbacks for `Bearer $ARENA_SECRET`
    `/api/arena/*` payloads/IDs, admin CLI args (`install-sim`, `rotate-ladder`), `ladders.yml`, or
    server->browser DB/SSE payloads (nor re-validate pre-assigned server teams). Keep Bearer auth,
    body limits, lifecycle gates, SHA-256 binary integrity, and `pools` privacy/viewer sanitization.
  - **Enforce strict validation on untrusted boundaries:** bundle/OCI/rootfs unpacking (`arena/unpack.ts`,
    `arena/packages.ts`, `arena/tournament.ts` `finalizeUnpackedOciRootfs`), agent stdio & `/utm`
    (`server/protocol.ts`, `arena/arbiter.ts`, `arena/tournament.ts`), human team pastes (`server/teams.ts`,
    `server/account.tsx`), sandbox/privilege (`arena/bin/limit.c`, `arena/bin/arena`, `sandbox.sb`,
    `pf.anchor`, `sudoers`), OAuth/CSRF/session/Bearer/Discord Ed25519 (`server/auth.ts`,
    `server/discord.ts`), wiki Djot/slug/git (`server/wiki.tsx`), Smogon redirect hosts (`server/smogon.ts`),
    viewer `postMessage` origins, and `pools` publication gates.
- **Routes & `.json`:** `/arena/` (hub), `/arena/ladders/:name/`, `/arena/tournaments/:id/`,
  `/arena/battles/` (live + paginated history via `GET /api/battles.json`), `/projects/:slug/`. Emit
  `.json` (`/<path>.json` === `/<path>/index.json`) **only** for SQLite-backed pages (`/arena`,
  `/arena/ladders/*`, `/arena/tournaments/*`, `/arena/battles`, `/projects/:slug`, `/account`), never
  static YAML/BibTeX/Djot/git pages. Publish `pools` battle logs and `teams.json` **only** after
  `status = 'archived'`.
- **Qualification (`pending` vs `qualified`):** `qualified: false` (`agents.status = 'pending'`)
  intentionally grants `/wiki*` editing and scheduled tournament submissions (`/account/`), gating
  only continuous ladders behind `qualified: true`. Only `disabled` accounts are blocked from
  tournaments and `/account/`.
- **`pools` fairness & canonicalization:**
  - `samplePoolsPair` (`server/teams.ts`) intentionally samples active players' own rosters with
    marginal probability `2/N` (`{A,C}` `2/N`, `{B,C}` `2/N`, `{C1,C2}` `(N-4)/N`, $\le 1$ team from
    `{A,B}`) for skin-in-the-game; 2-game team swaps neutralize hidden-info asymmetry.
  - `@pkmn/sets` `Team.canonicalize` sorts 6 slots and 4 moves (preventing slot-order watermarking)
    while preserving `shiny`, `gender`, and explicit under-leveled sets (`level || (champions ? 50 : 100)`)
    for legality/mechanics (`Rivalry`, `Attract`, `Cute Charm`, event/shiny-locked moves). Only
    dedup/uniqueness (`canonicalDedupeKey`, `toUniquenessEntry`) strips `shiny`, `gender`, and levels
    above `defaultLevel` (`50` in VGC/Champions).
  - `THRESHOLD = 1.30` (`teams/index.ts`) intentionally allows 5/6 shared species (`+1.0`) plus
    $\ge +0.30$ set distance across the shared 5.
  - Sandboxes are airgapped (`(deny network*)` + `/etc/pf.anchors/ai.pkmn.arena`, `podman --network=none`),
    preventing exfiltration; wiping `/Volumes/P1` and `/Volumes/P2` around every game prevents
    cross-game persistence.

## Verification

- Run `npm run test` (`tsc -p .`, static build, `eslint --cache`, `stylelint static/style/*.css tools/*.css`,
  `hyperlink public --check-anchors`) and `npx vitest run`.
- For TSX/CSS/client changes: **scope `npm run shots` with `--only <section|scenario,...>`** to
  capture only the states affected by your changes (`npm run shots -- --list` lists all sections and
  names; `--only` accepts comma-separated or repeatable filters, e.g. `--only ladders,battles`):
  run `npm run shots -- --baseline --only <targets>` before edits and `npm run shots -- --only <targets>`
  after edits. Reserve unfiltered full `npm run shots` for changes to shared chrome, layout, or
  global CSS (`static/style/index.css`, `static/build.tsx`, shared tables/nav). Verify zero
  console/page errors and zero overflow (`scrollWidth <= innerWidth`) across `375px`
  `small`–`desktop` (`light` & `dark`), inspect `.shots/index.html` and changed PNGs, then run
  `npm run clean && npm run test` so `public/` has no mock artifacts. Link changed light-mode desktop
  screenshots and include the full disk path to `.shots/index.html` (important in worktrees).
- **Keep `tools/shots.tsx` in sync:** Update `buildScenarios` in `tools/shots.tsx` and
  `docs/TESTING.md` whenever changing routes, views, controls, lifecycle states, or edge cases.
- **Keep `static/llms.txt` in sync:** Update `static/llms.txt` whenever changing `static/rules.dj`
  (or arena protocol, limits, formats, hardware, or packaging rules).
