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
