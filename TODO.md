# `pkmn.ai` Planned Work Items

---

## 4. Two-Pass "Proven-Pilot & Verifiable Contribution" Team Harvesting & Era-Matched Stats *(Blocked on Raw PS Server Logs)*

Harvesting constructed-format team pools (`RBY`, `ADV`, `SV`) and generating era-matched `@pkmn/stats`
(`/opt/arena/stats/<ladder_id>/stats.json`, plus pinned `gen9randombattle` `data.json`, `full.json`,
`sets.json` into `/opt/arena/stats/<rand_ladder_id>/`) will live outside this repo once raw Pokémon
Showdown battle logs are available.

### Why Naive Rating Filtering Fails

1. Sorting `(pilot_elo, team)` and keeping top 10–20% harvests losing meme teams: a 1900-Elo pilot
   going `0–4` still has 1840–1900 Elo during those losses.
2. Rating/GXE distributions vary across formats (`gen9ou` peaks `2000+` vs. tighter `gen1ou`/`gen3ou`),
   so fixed Elo cutoffs don't generalize.

### Two-Pass Algorithm

1. **Pass 1 (Empirical Distribution & Proven Pilots):**
   - Stream `<format>/<YYYY-MM-DD>.7z` via `7z x -so`, skipping `turns < 5` or missing
     `p1rating`/`p2rating`.
   - From `elo = r.elo ?? r.oldacre` and `gxe = r.gxe`, compute format percentiles $E_X = P_X(\text{elo})$
     (default $X = 90$, configurable $80\text{–}90$) and $E_{X-10} = P_{X-10}(\text{elo})$.
   - Track per-player (`toID(username)`) rated battle count, `peakElo`, and `peakGxe`. Define proven
     pilots $\mathcal{U}_{\text{proven}}$ as pilots with $M_{\text{pilot}} \ge 15$,
     $\text{peakElo} \ge E_X$, and $\text{peakGxe} \ge P_X(\text{gxe})$.
2. **Pass 2 (Canonicalized Trajectories in $\ge E_{X-10}$):**
   - Re-stream sides with $u \in \mathcal{U}_{\text{proven}}$, $\text{elo}_u \ge E_{X-10}$, and
     $\text{elo}_{\text{opp}} \ge E_{X-15}$.
   - Validate via `new TeamValidator(formatId).validateTeam(team)` and canonicalize immediately via
     `@pkmn/sets` `Team.canonicalize(team, gen)` *before* aggregating so nickname/slot-order/2-EV
     tweaks merge into one `(pilot, canonicalKey)` trajectory (`wins`, `losses`, `ties`,
     `netEloSurplus`, `maxEloWon`).
3. **Qualification, Scoring & Diversity Caps:**
   - Qualify iff `wins >= 4`, raw win rate `>= 0.55`, Laplace win rate `(wins + 1) / (decisive + 2) > 0.52`,
     and (`netEloSurplus > 0` or `maxEloWon >= E_X`).
   - Score: $(\text{wins} - \text{losses} + \text{netEloSurplus}) \cdot \max\!\left(1.0,\; \frac{\text{maxEloWon} - E_{X-10}}{\max(25,\; E_X - E_{X-10})}\right)$.
   - Keep top $K_{\text{pilot}} = 5$ teams/pilot, merge across pilots with boost
     `totalScore * (1 + 0.15 * (pilots - 1))`, and cap at $K_{\text{core}} = 3$ variants per 6-species
     core:

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

## 9. Global Ladder History Chart Controls (`30d` / `90d` / `All`, Version Markers & KotH Banner)

`server/render.tsx` currently renders one static SVG history chart for the top 6 agents on
`/arena/ladders/:name/`. Add:

1. **Range tabs (`30d` / `90d` / `All`):** Client-side tabs toggling pre-rendered SVG `<g>` layers
   (or filtering snapshot points).
2. **Version milestone markers (`● vX.Y.Z`):** On `#history`, mark UTC days where a newer `version_id`
   becomes a project family's top non-provisional version (`<circle>` + `<title>vX.Y.Z</title>` /
   label).
3. **King of the Hill reign banner:** Compact summary bar below `#history` listing settled `#1` reigns
   (agent, version, start/end dates, consecutive days, peak Elo).
4. **Verification:** Add `tools/shots.tsx` + `docs/TESTING.md` scenarios; verify zero console/page
   errors and zero overflow across `375px`–`desktop` in `npm run shots`.

---

## 10. Profile Multi-Version Convergence Chart (`View B`: Date vs. `Matches 1..N`)

`server/profile.tsx` currently renders only the Version Lineage step chart (`View A`) on
`/projects/:slug/`. Add a view toggle on the `Versions` chart switching between:

1. **Lineage (`View A`):** Chronological version step chart (`rating_elo`, $\pm 1.96\,\text{SE}$ error
   bars, $\Delta\text{Elo}$).
2. **Calendar (`View B — Date`):** Multi-version `rating_snapshots` over `day_utc` with $\pm 95\%$
   confidence ribbons.
3. **Convergence (`View B — Matches 1..N`):** Multi-version `rating_snapshots` aligned at $x = 0$ by
   `matches_played` (`Match 1..N`) to compare convergence speed across versions.

Add `tools/shots.tsx` + `docs/TESTING.md` scenarios and verify via `npm run shots`, `npm run test`,
and `npx vitest run`.
