# `pkmn.ai` Planned Work Items

Self-contained engineering specifications for remaining Arena, Server, UI, and Tournament work items.

---

## 4. Two-Pass "Proven-Pilot & Verifiable Contribution" Team Harvesting & Era-Matched Stats Provisioning *(Blocked on Raw PS Server Logs Access)*

### Context
- Harvesting constructed-format team pools (`RBY`, `ADV`, `SV`) and generating era-matched `@pkmn/stats` usage files (`/opt/arena/stats/<ladder_id>/stats.json`) from raw Pokémon Showdown battle logs will live outside this repository and are currently blocked on access to raw PS server logs.
- Once raw Pokémon Showdown server logs for the target format epochs are available, run `@pkmn/stats` over the exact snapshot windows used for team harvesting to populate `/opt/arena/stats/<ladder_id>/stats.json` (and copy the pinned `gen9randombattle` `data.json`, `full.json`, and `sets.json` into `/opt/arena/stats/<rand_ladder_id>/`).
- The complete Two-Pass harvesting algorithm is documented below so no design details are lost.

### Algorithm Specification

#### Why Naive Single-Battle Rating Filtering Fails
1. Simply collecting `(pilot_elo, team)` from every battle, sorting by `pilot_elo`, and keeping the top 10–20% lets **bad or meme teams piloted by elite players** pollute the pool: a 1900-Elo player who tests an unviable gimmick team and goes `0–4` still has a 1840–1900 rating during those losses, so naive filtering harvests their losing experiment.
2. Each format has a distinct rating distribution (`gen9ou` active peaks exceed `2000+` Elo while `gen1ou` or `gen3ou` have tighter distributions and different `gxe` curves), so fixed Elo cutoffs cannot be reused across ladders.

#### Pass 1 — Format-Specific Empirical Rating Distribution & Proven Pilot Identification
1. Stream all `<format>/<YYYY-MM-DD>.7z` archives in the snapshot window (`7z x -so <archive.7z>`), ignoring battles with `turns < 5` (to filter instant forfeits/disconnects) or missing `p1rating` / `p2rating`.
2. Collect the empirical distribution of pre/post-battle ratings (`elo = r.elo ?? r.oldacre` and `gxe = r.gxe`) across all valid battle sides in that format, and compute the exact format-specific percentiles:
   - **$E_X = P_X(\text{elo})$**: The **Proven Pilot Threshold** at the $X$-th percentile (default $X = 90$, configurable $80\text{–}90$).
   - **$E_{X-10} = P_{X-10}(\text{elo})$**: The **Qualifying Battle Floor** at the $(X - 10)$-th percentile (e.g., $80\text{th}$ percentile when $X = 90$).
3. Simultaneously track each normalized player ID (`toID(username)`) across the window: total rated battles played and peak rating achieved (`peakElo`, `peakGxe`).
4. Define the set of **Proven High-Ladder Pilots** $\mathcal{U}_{\text{proven}}$ as players who played at least $M_{\text{pilot}} \ge 15$ rated battles in the window and reached $\text{peakElo}(u) \ge E_X$ (and $\text{peakGxe}(u) \ge P_X(\text{gxe})$) at some point in their run.

#### Pass 2 — Early `@pkmn/sets` Canonicalization & Trajectory Tracking in $\ge P_{X-10}$ Battles
1. Stream the window a second time, filtering to battle sides where the pilot $u \in \mathcal{U}_{\text{proven}}$ and the battle takes place at or above the $(X - 10)$-th percentile ($\text{elo}_{u} \ge E_{X-10}$ and opponent $\text{elo}_{\text{opp}} \ge E_{X-15}$).
2. **Validate & Canonicalize *Before* Aggregating Wins (`@pkmn/sets`)**:
   - Validate the raw `p1team` / `p2team` against the Arena's pinned format ruleset via `new TeamValidator(formatId).validateTeam(team)`.
   - Immediately pass the validated team through `Team.canonicalize(team, gen)` from `@pkmn/sets`.
   - **Why canonicalizing before aggregation matters**: High-ladder players frequently change nicknames, reorder slots in Team Preview, or shift 2 wasted EVs mid-climb. Canonicalizing first ensures all battles with the same functional 6-Pokémon team merge into a single `(pilot, canonicalKey)` trajectory.
3. For each `(pilot u, canonicalKey H)` trajectory in the $\ge E_{X-10}$ bracket, accumulate `wins`, `losses`, `ties`, `netEloSurplus`, and `maxEloWon`.

#### Verifiable Contribution Criteria & Diversity-Capped Selection
1. A `(pilot u, team H)` trajectory qualifies if and only if:
   - **Minimum High-Ladder Wins**: $\text{wins}_{u,H} \ge N_{\min}$ (default $N_{\min} = 4$).
   - **Strictly Positive Win Rate & Confidence**: Raw win rate $\frac{\text{wins}_{u,H}}{\text{wins}_{u,H} + \text{losses}_{u,H}} \ge 0.55$ and Laplace-smoothed win rate $\frac{\text{wins}_{u,H} + 1}{\text{games}_{u,H} + 2} > 0.52$.
   - **Upward Rating Contribution**: $\text{netEloSurplus}_{u,H} > 0$ **or** $\text{maxEloWon}_{u,H} \ge E_X$.
2. **Per-Pilot & 6-Species Core Diversity Caps**:
   - Score each qualifying trajectory by its **Climb Contribution Score**:
     $$\text{score}(u, H) = (\text{wins}_{u,H} - \text{losses}_{u,H} + \text{netEloSurplus}_{u,H}) \cdot \max\!\left(1.0,\; \frac{\text{maxEloWon}_{u,H} - E_{X-10}}{E_X - E_{X-10}}\right)$$
   - **Per-Pilot Cap ($K_{\text{pilot}} = 5$)**: Keep at most the top $5$ distinct canonical teams per pilot $u$.
   - **Cross-Pilot Merge & 6-Species Core Cap ($K_{\text{core}} = 3$)**: Merge across pilots with a multi-pilot boost `totalScore * (1 + 0.15 * (pilots - 1))` and keep at most $K_{\text{core}} = 3$ variants per 6-species core.

```ts
export interface TeamTrajectory {
  pilotId: string;
  canonicalPacked: string;
  speciesCoreKey: string;
  wins: number;
  losses: number;
  ties: number;
  netEloSurplus: number;
  maxEloWon: number;
}

export function filterAndRankHarvestedTeams(
  trajectories: Iterable<TeamTrajectory>,
  provenPilots: ReadonlySet<string>,
  eloFloorP80: number,
  eloTargetP90: number,
  minWins = 4,
  maxTeamsPerPilot = 5,
  maxVariantsPerSpeciesCore = 3,
): string[] {
  const byPilot = new Map<string, Array<TeamTrajectory & { score: number }>>();
  const denomSpan = Math.max(25, eloTargetP90 - eloFloorP80);

  for (const t of trajectories) {
    if (!provenPilots.has(t.pilotId)) continue;
    const decisive = t.wins + t.losses;
    if (t.wins < minWins || decisive === 0) continue;

    const winRate = t.wins / decisive;
    const smoothedWinRate = (t.wins + 1) / (decisive + 2);
    const contributedToClimb = t.netEloSurplus > 0 || t.maxEloWon >= eloTargetP90;
    if (winRate < 0.55 || smoothedWinRate <= 0.52 || !contributedToClimb) continue;

    const altitudeWeight = Math.max(1.0, (t.maxEloWon - eloFloorP80) / denomSpan);
    const score = (t.wins - t.losses + t.netEloSurplus) * altitudeWeight;

    const list = byPilot.get(t.pilotId) ?? [];
    list.push({ ...t, score });
    byPilot.set(t.pilotId, list);
  }

  const mergedTeams = new Map<
    string,
    { canonicalPacked: string; speciesCoreKey: string; totalScore: number; pilots: number }
  >();
  for (const list of byPilot.values()) {
    list.sort((a, b) => b.score - a.score);
    for (const item of list.slice(0, maxTeamsPerPilot)) {
      const prev = mergedTeams.get(item.canonicalPacked);
      if (prev) {
        prev.totalScore += item.score;
        prev.pilots += 1;
      } else {
        mergedTeams.set(item.canonicalPacked, {
          canonicalPacked: item.canonicalPacked,
          speciesCoreKey: item.speciesCoreKey,
          totalScore: item.score,
          pilots: 1,
        });
      }
    }
  }

  const ranked = [...mergedTeams.values()].sort(
    (a, b) =>
      b.totalScore * (1 + 0.15 * (b.pilots - 1)) - a.totalScore * (1 + 0.15 * (a.pilots - 1)),
  );
  const coreCounts = new Map<string, number>();
  const finalPool: string[] = [];

  for (const entry of ranked) {
    const count = coreCounts.get(entry.speciesCoreKey) ?? 0;
    if (count >= maxVariantsPerSpeciesCore) continue;
    coreCounts.set(entry.speciesCoreKey, count + 1);
    finalPool.push(entry.canonicalPacked);
  }
  return finalPool;
}
```

---

## 9. Global Ladder History Chart Controls (`30d` / `90d` / `All-Time` Tabs, Version Milestone Markers & KotH Banner)

### Context
- Currently, [server/render.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/server/render.ts) and [static/ladder.html](file:///Users/kjs/Code/src/github.com/pkmn/ai/static/ladder.html) render a single static SVG rating history chart for the top 6 agents over time, without time-window filter tabs, version upgrade markers, or a "King of the Hill" reign summary banner on the ladder page.

### Implementation Plan
1. **Time-Window Range Tabs (`30d` / `90d` / `All-Time`)**:
   - In `server/render.ts` and `static/ladder.html`, add client-side range tabs (`30d`, `90d`, `All`) that toggle pre-rendered SVG `<g>` layers (or filter snapshot points) for the last 30 days, last 90 days, and all-time history.
2. **Version Milestone Markers (`● vX.Y.Z`)**:
   - When plotting each project family's daily effective rating trajectory on `#history`, detect UTC days where a newer `version_id` surpasses the project's previous version as the family's highest-rated non-provisional version, and render a labeled milestone marker (`<circle>` + `<title>vX.Y.Z</title>` / label) at that point.
3. **"King of the Hill" Reign Banner**:
   - Below the `#history` SVG on `/arena/ladders/:name/`, render a compact reign timeline/summary bar listing the ladder's historical settled `#1` reigns (Agent Name, version, start/end dates, consecutive days at `#1`, and peak Elo).
4. **Visual Atlas Scenarios (`tools/shots.ts`)**:
   - Add/update scenarios in `tools/shots.ts` and `docs/TESTING.md` covering the history range tabs and KotH banner, and verify across all viewports and themes with `npm run shots`.

### Acceptance Criteria
- [ ] `/arena/ladders/:name/` includes `30d` / `90d` / `All` history chart tabs, version milestone markers, and the KotH reign banner.
- [ ] Zero console/page errors and zero horizontal overflow across all viewports (`375px` `small` through `desktop`) in `npm run shots`.

---

## 10. Per-Agent Profile Multi-Version Convergence Chart (`View B` Relative Matches Played `1..N` Toggle)

### Context
- Currently, [server/profile.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/server/profile.ts) and [static/profile.html](file:///Users/kjs/Code/src/github.com/pkmn/ai/static/profile.html) render the Version Lineage step chart (`View A`) and Version Progression table on `/projects/:slug/`, but do not include `View B — Multi-Version Time-Series & Convergence Curves` with an X-axis toggle between `Calendar Date` and `Relative Matches Played (Match 1 .. N)`.

### Implementation Plan
1. In `server/profile.ts` and `static/profile.html`, add a view toggle on the `Versions` chart section switching between:
   - **Lineage (`View A`)**: Chronological version step chart with settled `rating_elo`, $\pm 1.96\,\text{SE}$ error bars, and $\Delta\text{Elo}$ annotations.
   - **Calendar Time-Series (`View B — Date`)**: Multi-version `rating_snapshots` trajectories plotted over `day_utc` with $\pm 95\%$ confidence ribbons.
   - **Relative Convergence (`View B — Matches 1..N`)**: Multi-version `rating_snapshots` trajectories aligned at $x = 0$ by `matches_played` (`Match 1 .. N`) so authors can compare how quickly `v1.0.0`, `v1.1.0`, and `v2.0.0` converged.
2. Add corresponding visual regression scenarios in `tools/shots.ts` and `docs/TESTING.md`.

### Acceptance Criteria
- [ ] `/projects/:slug/` supports toggling between Version Lineage and Multi-Version Convergence curves (`Date` vs `Matches 1..N`).
- [ ] Verified by `npm run shots`, `npm run test`, and `npx vitest run`.

---

## 11. Explicit Tournament `team` Mode (`byot` | `harvested` | `random` | `pools`)

### Context
- Ladders in [config/ladders.yml](file:///Users/kjs/Code/src/github.com/pkmn/ai/config/ladders.yml) have an explicit `team` mode (`harvested` | `random` | `pools`), whereas `tournaments` ([db/schema/tournaments.sql](file:///Users/kjs/Code/src/github.com/pkmn/ai/db/schema/tournaments.sql)) currently has no `team` column and implicitly infers whether a tournament is BYOT or pool-assigned based on whether any ladder with the same `format_id` happens to have a non-empty team pool.

### Implementation Plan
1. **Database Schema & Migration**:
   - Add `team TEXT NOT NULL DEFAULT 'byot' CHECK (team IN ('byot', 'harvested', 'random', 'pools'))` to [db/schema/tournaments.sql](file:///Users/kjs/Code/src/github.com/pkmn/ai/db/schema/tournaments.sql) and create a sequential migration in `db/migration/`.
   - Update `TournamentRow` and queries in [db/tournaments.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/db/tournaments.ts).
2. **CLI & Server Wiring**:
   - Require `--team=byot|harvested|random|pools` (or default to `byot`) in `create-tournament` ([server/cli.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/server/cli.ts)).
   - In [server/arena.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/server/arena.ts) (`startTournament` / tournament state endpoints) and [arena/tournament.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/tournament.ts):
     - `byot`: Empty `teamPool`; agents supply their own team via `/utm <packed_team>` on their first `stdout` line, and real entrant `displayName`s are visible in `|player|`.
     - `random`: `@pkmn/sim` generates teams from the game PRNG seed; generic `"Agent A"` / `"Agent B"` names on `stdin`.
     - `harvested` / `pools`: Load the team pool for the tournament's format/season and deal teams via `|utm|<packed_team>` on `stdin` with generic `"Agent A"` / `"Agent B"` names on `stdin`.
3. **UI & Docs**:
   - Display the tournament's team mode on `/arena/tournaments/:id/` and `/account/`, and update `docs/ADMIN.md` and `PROTOCOL.md`.

### Acceptance Criteria
- [ ] `tournaments` table, `create-tournament` CLI, `server/arena.ts`, and `arena/tournament.ts` use an explicit `team` mode (`'byot' | 'harvested' | 'random' | 'pools'`).
- [ ] Unit tests in `test/tournament.test.ts` and `test/api.test.ts` cover all 4 tournament team modes.

---

## 12. Common Random Numbers (CRN) Locked $2M$-Team Book for Pool Tournaments

### Context
- When a tournament runs in `harvested` or `pools` mode with $G = 2M$ games ($M$ seat-swapped pairs) per head-to-head matchup, [arena/tournament.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/tournament.ts#L569-L619) currently samples a fresh pair of teams for each matchup independently.
- Over a short series ($M = 10\text{–}25$ pairs), independent sampling introduces cross-pairing variance: Contender $A$ may randomly draw polarized `90–10` auto-split pairs against weaker opponents while Contender $B$ draws interactive `50–50` pairs against those same opponents and sweeps `2–0` (see [docs/HISTORICAL.md](file:///Users/kjs/Code/src/github.com/pkmn/ai/docs/HISTORICAL.md)).
- Locking a single ordered book of $M$ team pairs $\mathcal{B}_{\text{tourney}} = ((T_1, T_2), (T_3, T_4), \dots, (T_{2M-1}, T_{2M}))$ across all $\binom{E}{2}$ matchups (Common Random Numbers, analogous to a TCEC opening book) eliminates 100% of inter-pairing team-draw luck.

### Implementation Plan
1. When starting a `harvested` or `pools` tournament (`startTournament` in [server/arena.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/server/arena.ts)), sample a fixed book of $M = \lceil G / 2 \rceil$ team pairs ($2M$ teams) from the master pool:
   - Enforce **at most 1 team per 6-species core** across all $2M$ teams in the book (when the pool has $\ge 2M$ distinct cores).
   - Pair the $2M$ teams into $M$ match pairs $(T_{2m-1}, T_{2m})$ such that no pair shares $\ge 4$ species.
2. Persist `p1_team_packed` and `p2_team_packed` on each `tournament_games` row when generating the round-robin schedule so that for every head-to-head pairing $(i, j)$:
   - Odd game $2m - 1$ assigns `p1_team_packed = T_{2m-1}`, `p2_team_packed = T_{2m}`.
   - Even game $2m$ swaps seats and assigns the swapped teams so both agents pilot $T_{2m-1}$ and $T_{2m}$ under the identical PRNG seed.

### Acceptance Criteria
- [ ] In `harvested` and `pools` tournaments, every head-to-head pairing faces the exact same sequence of $M$ team pairs ($2M$ teams), with seats and teams swapped on even games $(2m - 1, 2m)$.
- [ ] No two teams in the $2M$-team book share all 6 species, and no match pair shares $\ge 4$ species.
- [ ] Verified by unit tests in `test/tournament.test.ts`.
