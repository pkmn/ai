# `pkmn.ai` Planned Work Items

Self-contained engineering specifications for remaining Arena, Server, UI, and Tournament work items.

---

## 2. Cold Bundle Archival (`/Volumes/Archive` + `gs://pkmn-arena`), Eager Retirement Eviction & Cache-Aware Matchmaking Bonus ($\rho_{ij}$)

### Context
- Currently, [arena/packages.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/packages.ts) and [arena/coordinator.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/coordinator.ts) keep unpacked versions in `/opt/arena/agents/` (or Podman) until hot disk usage exceeds 100 GB native / 35 GB container, at which point LRU versions are compressed to `/Volumes/Archive/cold-agents/<target>.tar.zst` and swapped back in on demand.
- Three lifecycle and scaling features from the original specification are not yet wired up:
  1. **Permanent Cold Archival of Raw Bundles**: Every submitted bundle/OCI archive that passes smoke testing should be archived permanently to `/Volumes/Archive/agents/<slug>/<ver>/` and synced to `gs://pkmn-arena/agents/<slug>/<ver>/` by [arena/scripts/archive.sh](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/scripts/archive.sh).
  2. **Eager Eviction of Fully Retired Versions**: When a version's active ladder count (`champion` or `challenger`) drops to `0` across all ladders, its unpacked directory `/opt/arena/agents/<slug>-<id>/` (or Podman image) should be evicted immediately from the internal 256 GB SSD rather than waiting for the 100 GB / 35 GB LRU watermark.
  3. **Cache-Aware Matchmaking Residency Bonus ($\rho_{ij}$)**: When the active version pool exceeds the internal SSD hot budget and uses the two-tier LRU cache, [server/matchmaker.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/server/matchmaker.ts) (`selectNextArenaMatch`) does not yet apply the SSD residency multiplier $\rho_{ij} \in \{1.00, 1.05, 1.15\}$ (see [docs/HISTORICAL.md](file:///Users/kjs/Code/src/github.com/pkmn/ai/docs/HISTORICAL.md#two-tier-ssd-cache-residency-bonus-rho_ij)).

### Implementation Plan
1. **Permanent Cold Archive (`/Volumes/Archive/agents/<slug>/<ver>/` & GCS)**:
   - In `arena/packages.ts`, upon successful smoke test of a native bundle or OCI image, write the compressed archive to `/Volumes/Archive/agents/<slug>/<ver>/bundle.tar.zst` (or `image.oci.tar.zst`) alongside `metadata.json`.
   - In `arena/scripts/archive.sh`, add `gcloud storage rsync /Volumes/Archive/agents gs://pkmn-arena/agents` alongside the existing battle-log and SQLite backup syncs.
2. **Eager Eviction on `activeLadders === 0`**:
   - In `arena/coordinator.ts`, after syncing ladder rosters from `/api/arena/ladders`, compute the set of `versionId`s that hold an active role (`champion` or `challenger`) on at least one active/settling ladder.
   - For any locally resident `local_agents` row whose `version_id` is no longer active on any ladder, immediately invoke `evictAgentToCold` / remove its hot `/opt/arena/agents/<slug>-<id>/` directory (or `podman rmi`) and mark `is_resident = 0`.
3. **Residency Bonus $\rho_{ij}$ in `selectNextArenaMatch`**:
   - Add an optional `residentVersionIds?: ReadonlySet<number>` parameter to `selectNextArenaMatch` in `server/matchmaker.ts`.
   - When `residentVersionIds` is provided, multiply each candidate pair's priority score by:
     - `1.15` if both `v1` and `v2` are in `residentVersionIds`
     - `1.05` if exactly one of `v1` or `v2` is in `residentVersionIds`
     - `1.00` if neither is in `residentVersionIds`
   - Pass the set of currently hot-resident `version_id`s from `arena/coordinator.ts` into `selectNextArenaMatch`.

### Acceptance Criteria
- [ ] Smoke-tested submissions persist a permanent cold archive under `/Volumes/Archive/agents/<slug>/<ver>/` and sync to `gs://pkmn-arena/agents/` in `arena/scripts/archive.sh`.
- [ ] Versions with `0` active ladders are immediately evicted from `/opt/arena/agents/` / Podman hot storage.
- [ ] `selectNextArenaMatch` applies $\rho_{ij} \in \{1.00, 1.05, 1.15\}$ when `residentVersionIds` is supplied, verified by unit tests in `test/ratings.test.ts` and `test/arena.test.ts`.

---

## 3. Read-Only Era-Matched Usage Stats Mounts (`/opt/arena/stats` & `PKMN_STATS_DIR`)

### Context
- The Arena specification provides read-only usage/randbats data files matching the exact period each ladder's teams are drawn from under `/opt/arena/stats/<ladder_id>/` (consuming 0 bytes of an agent's 500 MB bundle quota):
  - Constructed formats (`RBY`, `ADV`, `SV`, `VGC`): `@pkmn/stats` `stats.json`.
  - Random Battles (`RAND`): `data.json`, `full.json`, and `sets.json`.
- Currently, `/opt/arena/stats` is created by `arena/scripts/setup-arena.sh` and permitted in `arena/config/sandbox.sb` and `arena/bin/tourney-agent`, but:
  1. `arena/bin/arena` does not mount `/opt/arena/stats` into `podman run`.
  2. Neither `arena/bin/arena`, `arena/bin/limit.c`, nor `arena/bin/tourney-agent` exports `PKMN_STATS_DIR=/opt/arena/stats`.
  3. Generating the era-matched stats files for constructed ladders is blocked on access to raw Pokémon Showdown server battle logs.

### Implementation Plan
1. **Sandbox & Environment Wiring**:
   - In [arena/bin/arena](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/bin/arena), add `-v /opt/arena/stats:/opt/arena/stats:ro` and `-e PKMN_STATS_DIR=/opt/arena/stats` to the `podman run` invocation.
   - In [arena/bin/limit.c](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/bin/limit.c), add `"PKMN_STATS_DIR=/opt/arena/stats"` to `clean_env` before `execve`.
   - In [arena/bin/tourney-agent](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/bin/tourney-agent), add `--setenv PKMN_STATS_DIR /opt/arena/stats` to the `bwrap` invocation.
   - Document `PKMN_STATS_DIR` in [PROTOCOL.md](file:///Users/kjs/Code/src/github.com/pkmn/ai/PROTOCOL.md) and [arena/SETUP.md](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/SETUP.md).
2. **Era-Matched Stats Data Provisioning *(Blocked on Raw PS Server Logs Access)***:
   - Once raw Pokémon Showdown server logs for the target format epochs are available, run `@pkmn/stats` over the exact snapshot windows used for team harvesting to produce `/opt/arena/stats/<ladder_id>/stats.json` (and copy the pinned `gen9randombattle` `data.json`, `full.json`, and `sets.json` into `/opt/arena/stats/<rand_ladder_id>/`).

### Acceptance Criteria
- [ ] Both native bundles (`limit.c`), macOS OCI containers (`arena/bin/arena`), and tournament containers (`arena/bin/tourney-agent`) have read-only access to `/opt/arena/stats` and receive `PKMN_STATS_DIR=/opt/arena/stats`.
- [ ] Era-matched stats files are populated under `/opt/arena/stats/<ladder_id>/` once raw PS server logs are available.

---

## 4. Two-Pass "Proven-Pilot & Verifiable Contribution" Team Harvesting *(Blocked on Raw PS Server Logs Access)*

### Context
- Harvesting constructed-format team pools (`RBY`, `ADV`, `SV`) from raw Pokémon Showdown battle logs will live outside this repository and is currently blocked on access to raw PS server logs.
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

## 5. Showdown Timer Acceleration / Decay After Turn 100 and Turn 200 (Non-VGC Formats)

### Context
- In Pokémon Showdown's `RoomBattleTimer`, standard non-VGC formats apply stall acceleration after Turn 100 and Turn 200 so endless stall wars cannot replenish `+10s` per turn all the way to Turn 1000:
  - After Turn 100 (`turn > 100`), `addPerTurn` drops by `5s` (from `+10s` to `+5s` in Singles).
  - After Turn 200 (`turn > 200`), `addPerTurn` alternates between its decayed value (`+5s`) and `0s` every other request pair (`Math.floor(requestCount / 2) % 2 === 1`).
- VGC / Champions formats (`formatId.includes('vgc') || formatId.includes('champions')`) do not use this turn-100/200 timer acceleration.
- Currently, [arena/arbiter.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/arbiter.ts) and [arena/tournament.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/tournament.ts) apply a constant `fullTurnIncrementMillis` on all turns.

### Implementation Plan
1. In [arena/arbiter.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/arbiter.ts) and [arena/tournament.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/tournament.ts), compute `accelerate = !formatId.includes('vgc') && !formatId.includes('champions')`.
2. When advancing to a new turn (`this.currentTurn > this.lastRewardedTurn[slot]`):
   - Start with `let incrementMillis = this.fullTurnIncrementMillis`.
   - If `this.accelerate`:
     - If `this.currentTurn > 100 && incrementMillis > 5_000`, subtract `5_000`.
     - If `this.currentTurn > 200 && Math.floor(this.requestCount / 2) % 2 === 1`, set `incrementMillis = 0`.
3. Update [PROTOCOL.md](file:///Users/kjs/Code/src/github.com/pkmn/ai/PROTOCOL.md) to document the Turn-100 and Turn-200 timer decay rules for non-VGC formats.

### Acceptance Criteria
- [ ] Non-VGC formats decay the per-turn increment by `5s` after Turn 100 and alternate with `0s` after Turn 200 in both `arena/arbiter.ts` and `arena/tournament.ts`.
- [ ] VGC/Champions formats keep their constant per-turn increment without Turn-100/200 decay.
- [ ] Unit tests in `test/arena.test.ts` and `test/tournament.test.ts` cover Turn > 100, Turn > 200, and VGC exemption.

---

## 6. Restrict Mid-Turn Switch Increment (`+5s`) to Single-Side Switches (`activeSides.length <= 1`)

### Context
- Pokémon Showdown's `RoomBattleTimer.nextRequest()` grants the `+5s` mid-turn switch increment (`addPerFirstTurn = 5`) on same-turn requests (`newTurn <= this.turn`) **only when at most one side has to act (`activeSides.length <= 1`)**.
- Currently, [arena/arbiter.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/arbiter.ts#L305-L315) and [arena/tournament.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/tournament.ts#L285-L295) award `+5s` whenever `this.currentTurn === this.lastRewardedTurn[player.slot]`, even if both sides fainted simultaneously (e.g. via Explosion or recoil) and both must switch on the same mid-turn pause.

### Implementation Plan
1. In [arena/arbiter.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/arbiter.ts) and [arena/tournament.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/tournament.ts), count how many sides have an active non-wait request on the current decision step (`activeSides.length`).
2. When `this.currentTurn === this.lastRewardedTurn[player.slot]` (same turn number as the previous request), only add `MID_TURN_INCREMENT_MILLIS` (`5_000`) if `activeSides.length <= 1`.

### Acceptance Criteria
- [ ] Single-side mid-turn switches (e.g. U-turn, Volt Switch, or single-side faint) award `+5s`.
- [ ] Simultaneous double-faint mid-turn switches (`activeSides.length === 2` on the same turn) do not award `+5s`.
- [ ] Verified by unit tests in `test/arena.test.ts` and `test/tournament.test.ts`.

---

## 7. Alternate First CPU Slice (`requestCount % 2`) on Simultaneous Requests

### Context
- In the sequential time-sliced Mac mini arbiter ([arena/arbiter.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/arbiter.ts#L168-L176)), when both `p1` and `p2` have pending requests at the start of a turn, the loop currently always steps `p1` before `p2`.
- Alternating which side receives the first CPU slice on simultaneous requests (`p1` first on odd `requestCount`, `p2` first on even `requestCount`) eliminates any systematic OS page-cache or CPU cache-warmth bias between slots.

### Implementation Plan
1. In `ArenaBattle` ([arena/arbiter.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/arbiter.ts)), increment a `requestCount` counter each time a new decision wave begins (`p1.pendingRequestJson !== undefined || p2.pendingRequestJson !== undefined`).
2. Order the two slots as `const ordered = this.requestCount % 2 === 1 ? [this.p1, this.p2] : [this.p2, this.p1]` when stepping pending decisions.

### Acceptance Criteria
- [ ] On odd `requestCount`, `p1` receives the first CPU slice; on even `requestCount`, `p2` receives the first CPU slice.
- [ ] `test/arena.test.ts` verifies alternating step order across turns.

---

## 8. Live Between-Turn RAM Telemetry (`ri_phys_footprint` / Container Memory) During Game 1 & Game 2

### Context
- Currently, `/opt/arena/state/peak_ram_<slot>` is only written when an agent process exits (`arena/bin/limit.c` after `waitpid`, and `arena/bin/arena` on `cleanup`).
- As a result, [arena/coordinator.ts](file:///Users/kjs/Code/src/github.com/pkmn/ai/arena/coordinator.ts#L502-L547) reports a hardcoded `ram: 64` placeholder in live heartbeats (`POST /api/arena/heartbeat`) throughout Game 1, and reports Game 1's peak RAM (`g1Res.p1PeakRam` / `g1Res.p2PeakRam`) throughout Game 2 rather than live between-turn RAM telemetry.

### Implementation Plan
1. **Native Sandbox (`arena/bin/limit.c`)**:
   - In the `limit.c` polling loop (or whenever the child transitions to `SIGSTOP` / every 50 ms sample tick where `current_footprint_bytes > peak_footprint_bytes`), atomically write the updated `peak_mb` to `ARENA_PEAK_RAM_FILE` (`/opt/arena/state/peak_ram_<slot>`) whenever a new peak is reached.
2. **Container Sandbox (`arena/bin/arena`)**:
   - In `arena pause <slot>` (`arena/bin/arena`), query the container's current peak memory (`podman inspect` or cgroup `memory.peak` / `memory.current`) and write the MiB value to `/opt/arena/state/peak_ram_<slot>`.
3. **Arbiter & Coordinator Heartbeat Plumbing (`arena/arbiter.ts` & `arena/coordinator.ts`)**:
   - In `ArenaBattle` (`arena/arbiter.ts`), read `/opt/arena/state/peak_ram_p1` and `/opt/arena/state/peak_ram_p2` (updating `this.p1.peakRamMb` and `this.p2.peakRamMb`) after each decision step before firing `onHeartbeat`.
   - Include `p1RamMb: number` and `p2RamMb: number` in `HeartbeatState` (`arena/arbiter.ts`), and forward `Math.max(hb.p1RamMb, g1PeakRam)` in `arena/coordinator.ts` so `/arena/battles/` displays live memory usage on every turn of Game 1 and Game 2.

### Acceptance Criteria
- [ ] `/opt/arena/state/peak_ram_<slot>` updates during a game as memory usage grows, not only at process exit.
- [ ] `POST /api/arena/heartbeat` reports live `ram` telemetry during both Game 1 and Game 2.
- [ ] Unit/integration tests in `test/arena.test.ts` verify `p1RamMb` and `p2RamMb` are populated in `onHeartbeat`.

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
