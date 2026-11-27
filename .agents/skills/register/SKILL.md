---
name: register
description: >-
  Review, preview, and deploy pkmn.ai Arena project registrations from GitHub issues
  (e.g. `/register #31` or `/register https://github.com/pkmn/ai/issues/31`). Audits
  issue fields, Smogon accounts, chronology, existing catalog entries/renames,
  qualifying evidence, and logos; renders light/dark screenshots for LGTM; then
  commits, deploys to pkmn.ai, sets approved ladders, and verifies production.
---

# Register an Arena Project (`/register`)

End-to-end runbook for onboarding a project from a GitHub registration issue (`pkmn/ai`
issues created with [register.yml](../../../.github/ISSUE_TEMPLATE/register.yml)).

**Golden rules:**
- **Never commit, push, or deploy before explicit user LGTM.** Always stop after Phase 2
  with the proposed YAML, decision summary, flags/blockers, and light/dark screenshots.
- **Never guess Smogon accounts, dates, or ladder eligibility.** Surface mismatches and wait.
- **Never deploy the `arena` Mac mini** for registrations — only `pkmn.ai` (`npm run deploy:reload`).
- **Respect dirty working trees:** if unrelated uncommitted changes exist on `main`, do
  not touch them or run `npm run clean`; stage and commit only the registration files.

---

## Phase 0 — Fetch Issue & Check Workspace State

Parse the issue number from `#<N>`, `<N>`, or `https://github.com/pkmn/ai/issues/<N>`.

```sh
gh issue view <N> --repo pkmn/ai --json number,title,state,author,createdAt,body,comments
git status -sb && git fetch origin main && git log --oneline HEAD..origin/main
```

1. **Read ALL comments**, not just `body` — applicants frequently fix Smogon names,
   initial commit dates, or logos in follow-up comments.
2. Ensure compiled tools exist without clobbering uncommitted work:
   `[ -f build/tools/pkmn.js ] || npm run compile` (and `[ -f public/index.html ] || npm run build`).
3. Create a scratch directory in the conversation artifact scratch path (never inside the
   repo): `<scratch>/register-<N>/`.

---

## Phase 1 — Audit Every Field

Verify each item below and record every decision or anomaly for the Phase 2 summary.

### 1. Required Agreements
- Confirm all 3 checkboxes under **Required Agreements** are checked (`- [x]`).
- Flag if any box is unchecked. Note (without blocking) if an older issue used the
  pre-update template wording (before *"irrevocable"* / *"archive"* were added).

### 2. Project Name, Stylization & Existing Catalog Match
- Check [static/rules.dj](../../../static/rules.dj)
  naming rules: max 18 chars, PS username conventions (prefer `^[A-Za-z ]+$`, avoid
  `poke`/`mon`/`pkmn`/`ai`/`bot`/`agent`/`showdown`/`smogon`, bare English Pokémon species
  names, or known player names — subject to staff discretion; flag violations, don't
  auto-reject).
- Search for existing entries, aliases, renames, or duplicate owners across the repo:
  ```sh
  grep -rni '<name_or_stem>\|<github_login>\|<smogon_name>' \
    static/projects.yml static/projects.tsx static/projects.bib
  ```
- **Existing entry found?** Plan to update it in-place (and move it chronologically if
  its old date was `# ???` or inaccurate).
- **Name or casing changed** (e.g. `Chimera3` → `Chimera`, `pokerus` → `Pokérus`,
  `Mew's Truck` → `mewstruck`): check `RANKING` in
  [static/projects.tsx](../../../static/projects.tsx)
  and plan to update the string there too so ranking order stays matched.
- **Renamed/private predecessor** (e.g. `Porygon2` → `TwinBeam` with matching author,
  initial commit date, and engine): check `curl -sI <old_source_url>` for 404 and flag
  replacing the dead entry vs adding a new one.
- Compute the canonical slug via `slugify` in
  [static/util.tsx](../../../static/util.tsx)
  (folds diacritics, e.g. `Pokérus` → `pokerus`).

### 3. Owners (GitHub & Smogon Verification)
- Confirm exact GitHub login casing (`author.login` or `gh api users/<login> --jq .login`).
- Verify no owner already belongs to another project's `arena.owners` in
  [static/projects.yml](../../../static/projects.yml)
  (strict 1-project-per-developer rule).
- Resolve every owner's Smogon Forums ID and ban status:
  ```sh
  npm run pkmn -- lookup-smogon <smogon_username>
  ```
  *(Retry once on transient 5s timeouts. Must return `banned=false` and yield `<username>.<id>`.)*
- **If `Smogon account "<name>" not found`:**
  - Also check with `SMOGON_TOKEN` on prod:
    `ssh pkmn@pkmn.ai 'cd /home/pkmn/ai && npm run pkmn -- lookup-smogon <name>'`.
  - Check whether they accidentally entered their **Pokémon Showdown** username
    (`curl -fsS https://pokemonshowdown.com/users/<id>.json`), check the OP of any
    Smogon forum thread they linked (`curl -fsSL <thread_url> | grep -oE '/forums/members/[^"]+'`),
    and test obvious base-name variants.
  - **Mark as a BLOCKER.** Never silently substitute an unconfirmed Smogon account — report
    any candidate account (with join date / last seen / thread proof) and wait for human
    confirmation or applicant reply.

### 4. Qualifying Criteria & Ladder Eligibility
Valid ladder slots (from [config/ladders.yml](../../../config/ladders.yml)):
- `rby` (`gen1ou`), `adv` (`gen3ou`), `sv` (`gen9ou`), `rand` (`gen9randombattle`),
  `vgc` (`gen9championsvgc2026regmc`, including `vgc.bot` OTS/CTS/Random ladders).
- Use `none` (`Pending` — unlocks `/account/` tournament submissions + `/wiki`, no
  continuous ladders) when registering for tournaments only or lacking ladder proof.

Verification checks:
- Download any qualifying screenshot images in the issue and inspect them with `read_file`
  to confirm the claimed rank **and screenshot date**.
- If a Smogon thread is linked, inspect `<title>` and OP to confirm ownership and topic.
- Recommend exact ladder slot(s) and justify briefly.

### 5. Date of Initial Commit & Chronology
- Cross-check the stated date against qualifying screenshots, Smogon thread dates, public
  GitHub repo `createdAt`, and comments.
- Flag inconsistencies (e.g., rewrite date later than a qualifying screenshot — chronology
  should reflect when the project itself began, not a later Arena rewrite).
- Format: `active: <YYYY> # <Month Day>` (e.g. `active: 2026 # October 3`), positioned
  chronologically among entries for that year in `static/projects.yml`.

### 6. Metadata Conventions (`static/projects.yml`)
- `language`: canonical names (`Rust`, `Python`, `TypeScript`, `JavaScript`, `C++`, `Zig`);
  scalar if one (`Rust`), inline array if multiple (`[Rust, Python]`). Strip parentheticals
  like `(Node.js)`.
- `engine`: reuse canonical names & URLs already in `static/projects.yml` (`@pkmn/sim`,
  `@pkmn/client`, `pkmn`, `poke-engine`, `poke-engine-doubles`, `poke-env`,
  `pikapro-engine`, `just_a_simulator`, `pokemon-showdown`, `Hoenn`, `Oak`). Mix `Custom`
  and `{name, url}` items in a YAML list when both apply. Omit ML libraries (`PyTorch`,
  `JAX/Flax`).
- `source` / `license`: omit if closed-source, `_No response_`, or `TBD`. Confirm any
  public `source` URL returns HTTP `200`.
- `site`: project homepage, Smogon showcase thread
  (`https://www.smogon.com/forums/threads/<id>/` — even if the user pasted it under
  Qualifying Criteria), or blog/writeup. **Never** use `vgc.bot/bots/...`,
  `pkmn.bot/...`, or `pokemonshowdown.com/users/...` as `site:`.
- `paper`: only set a BibTeX key from `static/projects.bib` dedicated to this project
  (not general competition overview papers like `Karten:2025b`).
- `company`: optional (`string` or `{name, url}`) only when provided.
- `platform`: standard Showdown block (`name: Pokémon Showdown!`,
  `url: https://github.com/smogon/pokemon-showdown`).

### 7. Project Logo Audit (if attached)
Download the image to `<scratch>/register-<N>/logo.raw` and run `file` + `ls -lh`.
- **SVG:**
  - Security-scan for `<script`, `on[a-z]+=`, `javascript:`, `<foreignObject`, `<image`,
    or external `http://`/`https://` links. Reject/flag if anything suspicious appears.
  - Remember **non-`.webp`/`.png` logos MUST set `arena.logo: <slug>.svg`** in `projects.yml`
    (auto-detection only checks `<slug>.webp` then `<slug>.png`).
- **Raster (PNG / WebP / JPEG / GIF):**
  - Inspect the raw image with `read_file`.
  - Check **alpha channel & dark-mode look**: logos render up to `168px` tall (wide
    banners like `629×168` are fine). If a square badge has an opaque solid background
    (no alpha, e.g. `1254×1254` RGB), flag it — it will render as a harsh square sticker
    in dark mode. Offer to trim/mask outer corners transparent and downscale oversized
    `> 500 KB` square rasters to `336×336` (2× retina) while keeping any light inner badge
    intact if needed for contrast.
  - Prefer high-quality WebP (`cwebp -q 90 -m 6 -sharp_yuv`) as `<slug>.webp` for large
    photographic/illustrative rasters, or palette-optimized PNG (`pngquant` / `optipng`)
    as `<slug>.png` for tiny pixel-art or flat-color graphics where PNG is smaller;
    non-`.webp`/`.png` extensions (`.gif`, `.svg`) require `arena.logo: <slug>.<ext>`.

---

## Phase 2 — Isolated Preview & Human LGTM Gate

Write the proposed YAML entry to `<scratch>/register-<N>/entry.yml` (a single YAML list
item `- name: ...`) and run the bundled preview script — this **does not modify any repo
file**:

```sh
node .agents/skills/register/scripts/preview.js <slug> \
  --entry-file <scratch>/register-<N>/entry.yml \
  --out <scratch>/register-<N> \
  [--replace "<Existing Name>"] \
  [--logo <scratch>/register-<N>/<slug>.<ext>] \
  [--ladders <slot,...>]
```

*(See [preview.js](./scripts/preview.js) for flags.)*

1. Confirm the script outputs `httpStatus: 200`, `consoleErrors: []`, `pageErrors: []`,
   `overflowDesktop: false`, `overflowMobile: false`, and valid `logoNatural`/`logoBox`
   (when a logo is present).
2. **Visually inspect BOTH `<slug>-light.png` and `<slug>-dark.png` with `read_file`**
   before replying — catch ugly logo edges, missing fields, broken links, or contrast
   issues yourself.
3. **STOP and present your review to the user** with:
   - **Proposed YAML** (exact block + insertion/replacement spot in `static/projects.yml`,
     and any `static/projects.tsx` `RANKING` edit).
   - **Decision summary & flags:** Smogon lookup result (`username.id`, `banned=false`),
     any blockers/warnings (missing Smogon account, date discrepancy, rename, logo
     background/sizing, agreement wording), metadata normalization choices, and
     **recommended ladder slot(s)**.
   - **Clickable `file://` links** to the light and dark desktop screenshots (and any
     qualifying screenshot inspected).
   - **Explicit LGTM ask** confirming: YAML/logo decisions, ladder slot(s) to enable, and
     permission to commit, push, and deploy.

---

## Phase 3 — Commit, Deploy, Enable Ladders & Verify (After LGTM Only)

Execute only after the user approves (incorporating any requested tweaks first):

### 1. Apply Changes
- Edit [static/projects.yml](../../../static/projects.yml)
  (and [static/projects.tsx](../../../static/projects.tsx)
  `RANKING` if renamed/restylized).
- Copy the approved logo (if any) to `static/avatars/<slug>.<ext>`.

### 2. Validate Locally
- **Clean working tree** (only your registration changes):
  ```sh
  npm run clean && npm test
  ```
- **Dirty working tree** (unrelated user WIP edits present — do **not** run `npm run clean`):
  ```sh
  npx vitest run test/projects.test.ts
  node -e '
    const fs = require("fs"), os = require("os"), path = require("path");
    const {Database} = require("./build/db");
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "pkmn-chk-"));
    const db = new Database(path.join(d, "a.sqlite"));
    db.syncProjects("static/projects.yml");
    const a = db.getAgentBySlug(process.argv[1]);
    if (!a) throw new Error("Agent not synced");
    console.log({slug: a.slug, name: a.name, logo: a.logo, devs: db.getDevelopersForAgent(a.id).map(x => `${x.githubLogin}:${x.smogonUsername}.${x.smogonId}`)});
    db.close(); fs.rmSync(d, {recursive: true, force: true});
  ' <slug>
  ```

### 3. Commit, Push & Deploy to `pkmn.ai`
Stage **only** the registration files and verify `git diff --cached --stat` before
committing:

```sh
git add static/projects.yml [static/projects.tsx] [static/avatars/<slug>.<ext>]
git diff --cached --stat
git commit -m "registration: <Project Name>" -m "Closes #<N>"
git push origin main
```

Before deploying, check whether `pkmn.ai` is already at the parent commit (flag if
unrelated commits would also ride along):
```sh
ssh pkmn@pkmn.ai 'cd /home/pkmn/ai && git rev-parse --short HEAD && git log -1 --format=%s'
npm run deploy:reload
```

### 4. Enable Approved Ladder Slot(s)
Skip if the user requested `pending` / tournament-only (`none`):
```sh
ssh pkmn@pkmn.ai 'cd /home/pkmn/ai && npm run pkmn -- set-ladders <slug> <slot...>'
```

### 5. Live Production Verification (Required)
Run all checks and include concrete results in your final response:

```sh
# 1. Prod SQLite: status, logo, exact ladder slots, Smogon standing (0 bad/unknown/missing)
ssh pkmn@pkmn.ai '
  sqlite3 -header -column /var/lib/pkmn/arena.sqlite "
    SELECT a.slug, a.name, a.status, a.logo,
           GROUP_CONCAT(DISTINCT al.slot) AS slots,
           GROUP_CONCAT(DISTINCT d.github_login || \":\" || d.smogon_username || \".\" || d.smogon_id || \"(\" || d.smogon_standing || \")\") AS owners
    FROM agents a
    LEFT JOIN agent_ladders al ON al.agent_id = a.id
    LEFT JOIN developers d ON d.agent_id = a.id
    WHERE a.slug = \"<slug>\"
    GROUP BY a.id;
    SELECT smogon_standing, COUNT(*) AS n FROM developers GROUP BY smogon_standing;
  "
  journalctl -u pkmn.ai-server -n 10 --no-pager
'

# 2. Live HTTP 200 checks, JSON metadata, logo asset, /projects/ anchor, and closed issue
curl -fsS https://pkmn.ai/projects/<slug>.json | jq '{slug, name, status, logoHref, owners, metadata}'
curl -sS -o /dev/null -w 'HTML: %{http_code} %{size_download}B\n' https://pkmn.ai/projects/<slug>/
# If logo added:
curl -sS -o /dev/null -w 'LOGO: %{http_code} %{content_type} %{size_download}B\n' https://pkmn.ai/projects/<slug>.<ext>
curl -fsS https://pkmn.ai/projects/ | grep -oE 'id="<Project Name>"' | sort -u
gh issue view <N> --repo pkmn/ai --json number,state
```

Report the outcome concisely: **Changes Made**, **Intentionally Untouched**, and
**Verification Story**.
