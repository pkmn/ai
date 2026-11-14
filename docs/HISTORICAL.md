# Historical Design Derivations, Benchmarks & Sizing Analyses

This document preserves the mathematical derivations, empirical Pokémon Showdown log benchmarks, Monte Carlo matchmaking simulations, game-theoretic pool-sampling proofs, and cloud GPU sizing/cost analyses from the original `pkmn.ai` Arena design specification.

---

## 1. Empirical Showdown Battle Duration Benchmarks (11.2M Games)

A game in the continuous Arena uses Pokémon Showdown's official battle timer (`starting = 150s`, `grace = 60s` on the first turn, `maxPerTurn = 150s`, `addPerFirstTurn = 5s` on single-side mid-turn switches, and `addPerTurn = 10s` for Singles or `25s` for Doubles). Because `p1` and `p2` are time-sliced sequentially on the Arena Mac mini, the theoretical maximum wall-clock duration of a single $N$-turn Singles game (if both agents burn 100% of their initial $210\text{s}$ bank plus every $+10\text{s}$ turn increment) is:

$$T_{\text{seq}}(N) = \begin{cases} 400 + 20N \text{ sec} & \text{without Team Preview } (\text{RBY, ADV, RAND}) \\ 420 + 20N \text{ sec} & \text{with Team Preview } (\text{SV}) \end{cases}$$

Scanning all `2023-06` Pokémon Showdown battle logs (**`11,200,943` games** across all formats) yields the empirical turn-count, human wall-clock (`t:` timestamps), and sequential worst-case timer distributions:

| Format | Battles | Turns (Mean / **p50** / p95 / p99) | Human Time (**p50** / p95) | Sequential Max Timer (**p50** / p95 / p99) |
| :--- | ---: | :--- | :--- | :--- |
| `gen1ou` (`RBY`) | 22,274 | 35.5 / **33** / 77 / 120 | **5:18** / 12:18 | **17:40** / 32:20 / 43:20 |
| `gen3ou` (`ADV`) | 61,084 | 24.0 / **22** / 51 / 81 | **3:58** / 10:09 | **14:00** / 23:40 / 33:40 |
| `gen9ou` (`SV`) | 2,110,279 | 18.2 / **18** / 36 / 52 | **4:05** / 8:53 | **13:00** / 19:00 / 24:20 |
| `gen9randombattle` (`RAND`) | 7,216,636 | 17.1 / **17** / 35 / 47 | **4:16** / 9:06 | **12:20** / 18:20 / 22:20 |

In practice, agents moving in `0.5–3s` per turn finish a 2-game match in **1–6 minutes**, while two slow search agents burning their entire Showdown banks sequentially take **~25 minutes** per 2-game match on average (~37 minutes at p95).

---

## 2. Batch MAP Generalized Davidson Rating System

### 2.1 Why Batch MAP Generalized Davidson Is Used

Agent versions (`v1`, `v2`) are immutable software artifacts whose true skill never drifts over time ($\frac{d\theta_i}{dt} = 0$). We model ratings using batch Maximum a posteriori (MAP) estimation over a 5-category Generalized Davidson (1970) model (`server/ratings.ts`) rather than online human ladder formulas because:

- **Glicko / Whole-History Rating (WHR) time-decay** inflates rating deviation ($RD' = \sqrt{RD^2 + c^2}$) when an agent waits its turn in the scheduler queue, destroying valid historical certainty and tricking uncertainty-based matchmakers into wasting games on already-settled agents.
- **Sequential Elo** depends on game order, oscillates with random-walk width $O(\sqrt{K})$, and fails to propagate rating updates retroactively when two new agents play each other before playing established agents.
- **Naive Game-Level Bradley–Terry** treats Game 1 and Game 2 of a swapped-team blind pair as two independent coin flips, which compresses Elo spreads and understates standard errors whenever team matchups are lopsided.

### 2.2 Blind-Pair 9-Outcome Sufficiency Proof

In a 2-game blind-pair match between Agent $i$ and Agent $j$ with true skill log-odds difference $\Delta_{ij} = \theta_i - \theta_j$ and structural team/seat advantage $\delta$ (which flips $+\delta \mapsto -\delta$ when the two agents swap teams and seats in Game 2):

- **Nuisance Cancellation on Sweeps**: Under a logistic single-game model where $\text{logit}\Pr(\text{G1 win}) = \Delta_{ij} + \delta$ and $\text{logit}\Pr(\text{G2 win}) = \Delta_{ij} - \delta$, whenever a match ends in a 2–0 sweep ($WW$ or $LL$), the structural team advantage $\delta$ cancels completely for *any* distribution of $\delta$:
  $$\frac{\Pr(WW \mid \Delta_{ij}, \delta)}{\Pr(LL \mid \Delta_{ij}, \delta)} = \frac{\sigma(\Delta_{ij} + \delta)\,\sigma(\Delta_{ij} - \delta)}{\sigma(-\Delta_{ij} - \delta)\,\sigma(-\Delta_{ij} + \delta)} = e^{2\Delta_{ij}} \implies \Pr(WW \mid WW \cup LL, \Delta_{ij}) = \sigma(2\Delta_{ij})$$
- **Ancillarity of `WL` vs `LW`**: The ratio $\frac{\Pr(WL \mid \Delta_{ij}, \delta)}{\Pr(LW \mid \Delta_{ij}, \delta)} = e^{2\delta}$ has zero dependence on $\Delta_{ij}$; both are 1–1 splits where the same team won both games.
- **9-Outcome Generalized Davidson Model**: Including single-game ties (`T` from the 1000-turn limit or simultaneous faint), the $3 \times 3 = 9$ ordered 2-game outcomes (`WW, WT, TW, WL, LW, TT, TL, LT, LL`) collapse without loss of information into **5 sufficient-statistic match-score categories** $y_{ij} \in \{+1, +0.5, 0, -0.5, -1\}$ (corresponding to match points $S_{ij} \in \{2.0, 1.5, 1.0, 0.5, 0.0\}$):
  $$\Pr(Y_{ij} = y \mid \Delta_{ij}) = \frac{w_y \, e^{y \Delta_{ij}}}{Z(\Delta_{ij})}, \qquad Z(\Delta_{ij}) = e^{\Delta_{ij}} + \nu_1 e^{\Delta_{ij}/2} + \nu_0 + \nu_1 e^{-\Delta_{ij}/2} + e^{-\Delta_{ij}}$$
  where $w_{\pm 1} = 1$, $w_{\pm 0.5} = \nu_1$ (`WT` / `TW` and `TL` / `LT`), and $w_0 = \nu_0$ (`WL` / `LW` / `TT`).

### 2.3 Future Model Augmentations (Bounded-Luck $\beta$ & 2D Cyclic Styles) & Cross-Validation Rule

In competitive Pokémon (especially `gen9randombattle` and `gen1ou`), two structural deviations from a 1D transitive skill model can arise:

1. **Unavoidable Luck Floor ($\beta$, BlaTMMR)**: Even an infinitely stronger agent cannot win 100% of games against a competent opponent due to team-matchup auto-losses, critical hits, full paralysis, and 1-turn wakes. In the Bounded-Luck model, outcome probabilities are damped by a format-specific ceiling $\beta \in (0, 1]$ (where $\beta = 1$ recovers the standard Davidson model and $1 - \beta$ is the irreducible luck floor).
2. **Intransitive / Cyclic Matchup Styles ($\mathbf{u}_i \in \mathbb{R}^2$, Balduzzi et al. `mElo-2`)**: Augmenting the pairwise log-odds with a rank-2 skew-symmetric interaction term:
   $$\Delta_{ij} = (\theta_i - \theta_j) + \mathbf{u}_i^\top \mathbf{J} \mathbf{u}_j, \qquad \mathbf{J} = \begin{pmatrix} 0 & 1 \\ -1 & 0 \end{pmatrix}$$
   captures rock-paper-scissors strategy cycles while keeping $\theta_i$ as each agent's scalar transitively-averaged skill.

- **Retroactive Re-Optimization**: Because `pair_aggregates` and `matches` store all historical 5-category counts (`ww`, `wt`, `split`, `tl`, `ll`), enabling $\beta$ or $\mathbf{u}_i \in \mathbb{R}^2$ later requires zero schema changes and re-optimizes the batch objective in `< 5 ms`.
- **5-Fold Cross-Validation Decision Rule**: Once a ladder accumulates $\ge 1,000$ matches, partition completed matches into 5 folds, evaluate held-out Multi-class Log-Loss and Brier Score, and only enable $\beta < 1$ or `mElo-2` on a ladder if it reduces held-out cross-validated Log-Loss by at least **`0.005 nats/match`** with paired bootstrap $p < 0.01$.

---

## 3. Active Matchmaking Simulation Benchmarks (52 Agents, 20 Trials)

The active matchmaker (`selectNextArenaMatch` in `server/matchmaker.ts`) combines Fisher information gain on the posterior covariance matrix, adjacent-rank Conservative Rating overlap, and Upper Confidence Bound (UCB) challenger triage. Evaluated across 20 Monte Carlo trials of 52 agents using Kendall rank correlation ($\tau$) and Top-$K$ placement latency against uniform Round-Robin scheduling:

| Strategy | New Top-10 Agent Latency | Top-3 Exact | Top-10 Stable | Full-52 $\tau \ge 0.95$ | Top-5 Rank Err @ 12k |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Round-Robin** | 220.7 matches | 21,649 | 24,354 | 13,012 | 1.09 |
| **Active ($\alpha = 0.45$)** | **78.1 matches** | **11,890** | **15,694** | **12,023** | **0.35** |

### Two-Tier SSD Cache Residency Bonus ($\rho_{ij}$)

When the number of active versions across all ladders exceeds the Mac mini's internal SSD hot budget (~150–170 GB across `/opt/arena/agents/` and the Podman VM), cold versions are stored on `/Volumes/Archive` and swapped in on demand (~0.8–1.5s over USB 3.2 / Thunderbolt). Multiplying each candidate pair's matchmaking score by a mild residency bonus:

$$\rho_{ij} = \begin{cases} 1.15 & \text{if both } i \text{ and } j \text{ are currently resident on the internal SSD} \\ 1.05 & \text{if exactly one of } i \text{ or } j \text{ is resident} \\ 1.00 & \text{if neither is resident} \end{cases}$$

prefers warm pairs when two matchups have similar information-gain priority (cutting cold swap-ins by `>80%`), while expected information gain $\text{IG}(i, j)$, UCB triage (`triageBonus` up to $3.0\times$), and the repeat damper $\frac{1}{1 + 0.25 m_{ij}}$ vary by $2\times\text{–}10\times$ so cold agents that genuinely need matches are never starved.

---

## 4. Leaderboard Ranking, Challenger Usurpation & Post-Match Complexity

### 4.1 Why Displayed Records & Streaks Are Match-Based (`W–L–T`)

In a 2-game blind-pair match (`Bo2`) where Agent $A$ and Agent $B$ play Game 1 (`A` with $T_1$, `B` with $T_2$) and Game 2 (`B` with $T_1$, `A` with $T_2$) under the identical PRNG seed $s$, a single game is not an independent competitive unit (since $T_1$ may have an `80–20` matchup advantage over $T_2$). While SQLite (`ladder_entries` and `pair_aggregates`) retains the exact 5 sufficient-statistic match categories (`ww`, `wt`, `split`, `tl`, `ll`) for Davidson MAP estimation, every user-facing table, profile card, and streak counter collapses the 9 ordered 2-game outcomes into ternary **Match `W / L / T`**:

| Displayed Match Outcome | Underlying 2-Game Outcomes | Match Points ($S_{ij}$) | Davidson Category ($y_{ij}$) | Exact Formula from SQLite Columns |
| :--- | :--- | :---: | :---: | :--- |
| **Match Win (`W`)** | `WW`, `WT`, `TW` | $2.0$ or $1.5$ | $+1.0$ or $+0.5$ | `W = ww + wt` |
| **Match Tie (`T`)** | `WL`, `LW`, `TT` | $1.0$ | $0.0$ | `T = split` |
| **Match Loss (`L`)** | `LL`, `LT`, `TL` | $0.0$ or $0.5$ | $-1.0$ or $-0.5$ | `L = ll + tl` |
| **Total Matches** | All 9 outcomes | — | — | `Matches = matches_played = W + L + T` |

Because single-game ties occur in `< 0.05%` of Pokémon battles, `W` is almost exclusively `2–0` sweeps (`WW`), `T` is `1–1` splits (`WL`/`LW`), and `L` is `0–2` sweeps (`LL`).

### 4.2 Solving the "Unsettled Challenger Usurpation" Problem (`LCB` & Plausible Rank Bounds)

A classic failure mode on naive rating leaderboards (such as `vgc.bot`) occurs when agents are sorted by their raw point-estimate rating $R_i$ regardless of confidence interval width:

- **Concrete Example (`vgc.bot` Failure Mode)**: Suppose an established champion `wolfe` sits at **`1679 ± 37`** over 600 games ($\text{SE} \approx 18.9\text{ Elo}$, 95% CI $[1642, 1716]$), while a new challenger `AsterAI` sits at **`1720 ± 79`** after 30 games / 15 matches ($\text{SE} \approx 40.3\text{ Elo}$, 95% CI $[1641, 1799]$).
- Sorting by raw point estimate ($1720 > 1679$) places `AsterAI` at `#1` ahead of `wolfe` even though:
  1. Pairwise Likelihood of Superiority is only $\text{LOS}(\text{AsterAI} > \text{wolfe}) = \Phi\!\left(\frac{1720 - 1679}{\sqrt{40.3^2 + 18.9^2}}\right) \approx 82\%$ (below a 95% confidence standard), and
  2. `AsterAI`'s 95% lower confidence bound ($1720 - 79 = \mathbf{1641}$) is actually **lower** than `wolfe`'s 95% lower confidence bound ($1679 - 37 = \mathbf{1642}$).
- Furthermore, if `Best Rank`, `Max Elo`, and `Max GXE` are tracked from Match 1 on raw point estimates, nearly every agent's all-time "peak" rank and rating will be an early small-sample fluke (e.g., going `4–0` in matches 1–4 with `1760 ± 160`) before its rating settles.

`pkmn.ai` prevents both failure modes using three mechanisms:

1. **Conservative Rating (`rating_lcb`) as the Canonical Leaderboard Sort Key**:
   - Each version's **Conservative Rating** is the **95% Lower Confidence Bound (`LCB`)** of its posterior skill distribution (analogous to Pokémon Showdown's `ACRE` and Microsoft TrueSkill's $\mu - k\sigma$):
     $$R_{\text{LCB}, i} = R_i - 1.96 \cdot \text{SE}(R_i) = \text{rating\_elo}_i - \text{ci95}_i$$
   - A challenger $C$ with wider uncertainty $\text{SE}_C$ can only overtake an incumbent rank holder $H$ with tighter uncertainty $\text{SE}_H$ when:
     $$R_C - 1.96\,\text{SE}_C > R_H - 1.96\,\text{SE}_H \iff R_C - R_H > 1.96\,\bigl(\text{SE}_C - \text{SE}_H\bigr)$$
   - In the `wolfe` (`1679 ± 37`, $R_{\text{LCB}} = 1642$) vs. `AsterAI` (`1720 ± 79`, $R_{\text{LCB}} = 1641$) example, `wolfe` automatically remains ranked ahead of `AsterAI` until `AsterAI` plays enough matches to shrink its confidence interval and raise its lower bound above `1642`. Once two agents are both well-settled ($\text{SE}_C \approx \text{SE}_H$), $1.96(\text{SE}_C - \text{SE}_H) \to 0$ and the ordering converges to pure Elo $R_i$.
2. **Two-Stage Provisional & Settlement Gates (`Provisional` vs. `Settled`)**:
   - **Provisional Calibration Gate (`matches_played < 10` or `rating_se > 60` Elo)**: Newly submitted versions with fewer than 10 matches (20 games) or $\text{SE}(R_i) > 60\text{ Elo}$ ($\text{CI}_{95} > \pm 118\text{ Elo}$) are badged `[Provisional]` with Rank = `—` (`undefined`).
   - **Full Settlement Gate (`settled_at IS NOT NULL`, i.e., `matches_played >= 25` AND `rating_se <= 30` Elo / `ci95 <= ±58.8` Elo)**: Peak point-estimate records (`Max Elo`, `Max GXE`, `Best Rank`) and `#1` Leaderboard / Discord Role usurpation are **only recorded once a version is Settled**.
3. **Guaranteed Plausible Rank Bounds (`[rank_min, rank_max]`) for Top-1 / Top-10 / Top-100 Reigns**:
   - Using `computeGuaranteedRankBounds` (`server/ratings.ts`), which evaluates pairwise $\text{LOS}(i > j) = \Phi\!\left(\frac{\theta_i - \theta_j}{\sqrt{\Sigma_{ii} + \Sigma_{jj} - 2\Sigma_{ij}}}\right) \ge 0.95$ across all active project families, every project family has a **95% Plausible Rank Interval** $[\text{rank\_min}(b), \text{rank\_max}(b)]$.
   - A high-variance powerhouse with plausible rank range `[1, 4]` immediately accrues Guaranteed Top-10 Streak & Duration (`rank_max <= 10`), whereas Guaranteed Top 1 requires `rank_current === 1`, `settled_at IS NOT NULL`, and `LCB_1 >= LCB_2`.

### 4.3 Post-Match Incremental Computation & Latency Breakdown

No post-match step ever scans the historical `matches` table; every statistic is maintained over fixed-size tables (`ladder_entries`, `agent_ladder_stats`, and `pair_aggregates`):

| Post-Match Step | Target Tables / Data Structures | Asymptotic Complexity | Wall-Clock Time ($M = 150$ versions) | Why It Never Scales with Total Historical Matches ($N_{\text{matches}}$) |
| :--- | :--- | :---: | :---: | :--- |
| **1. Match `W/L/T` & Streak Update** | 2 rows in `ladder_entries`, 2 rows in `agent_ladder_stats`, 1 row in `pair_aggregates` | **$O(1)$** | **`< 0.03 ms`** | Updates `ww/wt/split/tl/ll` and `cur/max_win_streak`, `cur/max_loss_streak`, and H2H `cur_streak` in-place on the 2 participating agents. |
| **2. Warm-Started Davidson MAP & Cholesky Covariance** | In-memory `PairMatchCounts[]` ($\le \binom{M}{2}$ pairs) + $M \times M$ `Float64Array` Hessian | **$O(M^2 + \tfrac{1}{6}M^3)$** | **`~0.75 ms`** | Warm-starting `theta` from the previous solve converges in **3–5 Newton steps** (`~0.15 ms`); Cholesky inversion of a $150 \times 150$ `Float64Array` takes `~0.60 ms`. |
| **3. Conservative Ranking & Guaranteed Rank Bounds (`[rank_min, rank_max]`)** | $B$ active project families ($B \le 85$) | **$O(B^2)$** | **`~0.04 ms`** | $85 \times 85 = 7,225$ fast inline `normalCdf` checks over the already-inverted covariance matrix $\boldsymbol{\Sigma}$. |
| **4. Peak Milestones & Top-1/10/100 Duration Clocks** | $M$ rows in `ladder_entries` + $B$ rows in `agent_ladder_stats` | **$O(M)$** | **`~0.02 ms`** | Compares current values against stored `max_*` fields and adds $\Delta t = t_{\text{now}} - t_{\text{prev}}$ to `top{1,10,100}_total_seconds` for agents with `rank_max <= K`. |
| **5. SQLite WAL Transaction & Atomic Static HTML Write** | Single `BEGIN IMMEDIATE ... COMMIT` + template string render | **$O(M)$** | **`~1.5–4.0 ms`** | Batch-updates the $M$ rows of ladder $L$ in one WAL commit and atomically renames pre-rendered static `.html` / `.json` files. |
| **Total Post-Match Pipeline** | — | **$O(M^3)$** *(independent of $N_{\text{matches}}$)* | **`~2.3–4.8 ms` total** | **0.00% CPU overhead** relative to a 1–25 minute 2-game Pokémon match. |

---

## 5. Seasonal Competitor-Supplied 20-Team Pools (`VGC` Pseudo-Blind-Pair Mode)

When launching a seasonal ladder where historical high-ladder Pokémon Showdown battle logs do not yet exist (`pools` mode, e.g. `VGC`), each participating project supplies $T = 20$ valid teams on its first submission to that seasonal `ladder_id`.

### 5.1 The Uniqueness vs. Probing Dilemma

A subtle security and fairness dilemma arises when two competitors submit identical or heavily overlapping teams (such as a popular tournament-winning rental team):

1. **Why Rejecting Duplicate Submissions Across Competitors Fails (The Probing Oracle Attack)**:
   - If `pkmn.ai` rejected Project $B$'s team submission because one or more of its 20 teams were too close to an earlier competitor's private submission, that rejection would act as a **membership oracle**: a late submitter could probe candidate teams during submission to discover the archetypes earlier competitors submitted.
   - Even an $M / T$ overlap threshold (e.g., rejecting only when $\ge 5$ of $20$ teams overlap) reduces to a 1-bit oracle once an attacker fixes $M - 1$ known staple teams in slots $1 \dots M-1$, places target team $X$ in slot $M$, and fills slots $M+1 \dots 20$ with obscure teams.
2. **Why Naive Silent Overlap Acceptance Also Fails**:
   - Treating identical submissions without tracking cross-project ownership breaks the pseudo-blind-pair knowledge bound if Project $A$ submitted canonical team $H$ as `"Project A Team #1"` and Project $G$ submitted the exact same canonical team $H$ as `"Project G Team #6"`.

### 5.2 Zero-Oracle $d_{\text{1-NN}} \ge 1.30$ Validation & Uniform $\frac{2}{N}$ Roster-Pair Sampling

`pkmn.ai` (`teams/index.ts` and `server/teams.ts`) resolves both problems by combining **Zero-Oracle Submission Validation** against only the public reference pool + the submitter's own prior slots ($d_{\text{1-NN}} \ge 1.30$) with **Uniform $\frac{2}{N}$ Hierarchical Roster-Pair Sampling**:

1. **Why Naive Flat-Pool Rejection Sampling Biases Pool Assignment**:
   - Naively drawing $T_1$ from the flat $20N$-team pool and excluding $P_A \cup P_B$ from $T_2$ whenever $T_1 \in P_A \cup P_B$ under-samples the active players' pools ($\frac{2}{N} - \frac{1}{N(N-1)}$) and over-samples every third-party pool ($\frac{2}{N} + \frac{2}{N(N-1)(N-2)}$), creating an incentive to pollute rivals' matches with weak or high-variance teams.
2. **Uniform $\frac{2}{N}$ Roster-Pair Sampling (`samplePoolsPair` in `server/teams.ts`)**:
   - Because holding both the pseudo-blind-pair knowledge bound ($X_A + X_B \le 1$, at most 1 of the 2 match teams from $P_A \cup P_B$) and exact uniform per-competitor pool assignment ($\mathbb{E}[X_i] = \frac{2}{N}$) requires $\Pr(X_A + X_B = 1) = \frac{4}{N} \le 1$, **a minimum of $N \ge 4$ active projects (`min_agents: 4`, $\ge 80$ teams)** is required before matchmaking begins.
   - In a 2-game match between Project $A$ ($P_A$) and Project $B$ ($P_B$) with $N \ge 4$ active projects, sample the unordered pair of distinct rosters $\{I, J\} \subset \{1 \dots N\}$ **first**:
     - With probability **$\frac{2}{N}$**: $\{P_A, P_C\}$ for a uniformly chosen third party $P_C \notin \{P_A, P_B\}$.
     - With probability **$\frac{2}{N}$**: $\{P_B, P_C\}$ for a uniformly chosen third party $P_C \notin \{P_A, P_B\}$.
     - With probability **$\frac{N - 4}{N}$**: $\{P_{C_1}, P_{C_2}\}$ uniformly from the $\binom{N - 2}{2}$ pairs of distinct third parties.
   - Any third party $P_C \notin \{P_A, P_B\}$ is chosen with marginal probability:
     $$\frac{2}{N}\cdot\frac{1}{N-2} + \frac{2}{N}\cdot\frac{1}{N-2} + \frac{N-4}{N}\cdot\frac{2}{N-2} = \frac{2}{N}$$
     which is identical to $P_A$ and $P_B$.
   - Flip a fair coin to orient $(I, J)$ vs $(J, I)$, draw $T_1 \sim \text{Unif}(\mathcal{R}_I)$ and $T_2 \sim \text{Unif}(\mathcal{R}_J)$, and rejection-resample if $T_1$ and $T_2$ share all 6 species, $\text{Owners}(T_1) \cap \text{Owners}(T_2) \neq \emptyset$, either team is jointly owned by $P_A$ and $P_B$, or $\bigl|(\text{Owners}(T_1) \cup \text{Owners}(T_2)) \cap \{P_A, P_B\}\bigr| > 1$.

---

## 6. Cloud GPU Championship Tournaments (TCEC / CCC Mode)

### 6.1 Architectural Comparison: Continuous Arena (CCRL) vs. Live Tournament (TCEC / CCC)

| Dimension | Continuous Rating Arena (CCRL Mode) | Weekend Live Tournament (TCEC / CCC Mode) |
| :--- | :--- | :--- |
| **Computer Chess Analogy** | **CCRL / CEGT**: Continuous background calibration of all versions on standardized openings (`ponder = false`). | **TCEC / CCC**: Scheduled premier championship event on dedicated datacenter GPUs & high-core CPUs (`ponder = true`, live broadcast). |
| **Coordinator & `@pkmn/sim`** | Runs on the M6 Mac mini's 2 Efficiency cores (`pkmn@arena`). | Runs on the tournament coordinator (`< 0.2 ms` CPU per turn, `< 50 MB` RAM for $K \le 16$ concurrent tables). |
| **Agent Worker Hardware & OS** | Owned **Apple M6 Mac mini** (`darwin/arm64` + `libkrun` `linux/arm64`), 12c CPU, 12c integrated GPU, 32 GB Unified Memory. | Ephemeral **1-Agent GCP `g2-custom-24-49152` Spot VMs (`Ubuntu 24.04 LTS x86_64`)**: **1× NVIDIA L4 (`24 GB GDDR6`)** + **24 vCPUs (`12` physical Xeon cores)** + **48 GB DDR5 RAM** per agent (`$0.50/hr` Spot per agent, **`$1.00/hr` per 2-VM match table**). |
| **Per-Agent Compute** | **Shared & Time-Sliced**: 10 CPU cores + M6 GPU (~5 TFLOPS) + 14 GiB total RAM, **only while active**. | **100% Dedicated & Concurrent (`1 VM = 1 Agent`)**: Full VM (**242 TFLOPS FP16 / 485 TOPS INT8 GPU** w/ `24 GB` VRAM + **all 24 vCPUs** + **48 GB host RAM** = **72 GB total memory per agent**). |
| **Execution & Pondering** | **Sequential (`ponder = false`)**: Inactive agent is frozen (`SIGSTOP` / `podman pause`) between its choices. | **Concurrent (`ponder = true`)**: Both agents run continuously on separate VMs; thinking on simultaneous turns overlaps and waiting agents ponder freely. |
| **Sandbox Technology** | macOS `sandbox-exec` (Seatbelt) + XNU `limit.c` supervisor + `pf` firewall (or `krunkit` micro-VM). | **Rootless `bubblewrap` (`bwrap --unshare-all`)**: Unshares network (`CLONE_NEWNET`), PID (`CLONE_NEWPID`), and mount namespaces (read-only rootfs + `/tmp` tmpfs); VM hypervisor enforces hardware limits. |
| **Clock Measurement** | Local `performance.now()` on Mac mini. | Measured **locally on the GCP VM** inside `/opt/arena/bin/tourney-agent` (`ARENA_TURN_MS=<ms>` on `stderr`) so SSH network RTT is never billed against an agent's clock. |
| **Team Source & Match Unit** | **2-Game Paired Team-Swap Matches** using **Arena-Assigned (`|utm|<packed_team>`)** teams sampled from shared pools to cancel team-matchup variance and isolate piloting skill. | **Individual Standalone Games (BYOT)** where entrants bring their own custom-built team(s) or dynamic team generator (`/utm <packed_team>`), or **Blind-Pair Tournament Mode** over a locked $2M$-team book. |
| **Public Replays & Teams** | **Hidden** on active ladders (published for `pools` ladders only after `archived`). | **Public & Streamed Live** on `/arena/tournaments/:id/` (full Showdown replay viewer, live clocks, and real-time round-robin crosstable). |

### 6.2 Cloud GPU & High-vCPU Sizing (`2× g2-custom-24-49152` Spot)

In Pokémon AI, the forward battle simulator (`@pkmn/engine` in Zig/C, `poke-engine` in Rust, or C++ MCTS/CFR rollouts) executes on the CPU. Even GPU-heavy AlphaZero/PUCT/Nash-MCTS agents spend substantial CPU resources expanding $9 \times 9 = 81$ joint action branches, sampling stochastic damage/effect rolls, and traversing search trees across worker threads to feed leaf batches to the GPU.

On Google Cloud's `G2` (Intel Sapphire Rapids Xeon) series, `1 vCPU = 1 hyperthread (SMT thread)`, so `12 vCPUs` (`g2-standard-12`) is only **6 physical CPU cores**. Multi-GPU `G2` instances (`g2-standard-24` with 2 GPUs, `g2-standard-48` with 4 GPUs, `g2-standard-96` with 8 GPUs) **hard-cap the CPU-to-GPU ratio at 12 vCPUs (6 physical cores) per GPU** and provide **zero multi-GPU price discount** (GCP bills `G2` strictly as the linear sum of its components). By contrast, **1-GPU `G2` instances allow Custom `G2` Machine Types (`g2-custom-<vCPUs>-<RAM_MB>`)**, doubling the CPU allocation to **24 vCPUs (12 physical Xeon cores)** with **48 GB DDR5 RAM** (`g2-custom-24-49152`) for **`$0.50/hr` Spot per agent** (**`$1.00/hr` per 2-VM match table**), while minimizing preemption blast radius to a single in-flight game and giving each agent KVM hypervisor isolation.

| Provider & Tier | Configuration (Per 1 Match Table = 2 Agents) | Per-Agent GPU & VRAM | Per-Agent CPU (`vCPUs` / Physical Cores) & Host RAM | 1-Agent VM Rate (`Spot` / `On-Demand`) | **Table Rate (2 Agents)** (`Spot` / `On-Demand`) | Evaluation & Recommendation |
| :--- | :--- | :--- | :--- | :---: | :---: | :--- |
| **GCP `G2` — 24 vCPU** *(Selected Standard)* | **2× `g2-custom-24-49152`** | **1× NVIDIA L4** (`24 GB GDDR6`, 242 TFLOPS FP16) | **24 vCPUs** (`12` phys. cores) + **48 GB DDR5** | **`$0.50/h`** / `$1.52/h` | **`$1.00/hr` (Spot)**<br>`$3.04/hr` (OD) | **Committed Tournament Standard.** Doubles physical CPU cores vs. `g2-standard-12` (`24 vCPUs` + `48 GB` RAM + `24 GB` VRAM per agent) for a clean `$1.00/hr` per table on Spot. |
| **GCP `G2` — 12 vCPU** *(Lower-Core Baseline)* | **2× `g2-standard-12`** | **1× NVIDIA L4** (`24 GB GDDR6`) | **12 vCPUs** (`6` phys. cores) + **48 GB DDR5** | `$0.38/h` / `$1.14/h` | `$0.75/hr` (Spot)<br>`$2.28/hr` (OD) | Saves `$0.25/hr` per table, but 6 physical Xeon cores can bottleneck heavy CPU tree search (`@pkmn/engine` / `poke-engine`). |
| **GCP `G2` — 16 vCPU** *(Predefined Mid-Tier)* | **2× `g2-standard-16`** | **1× NVIDIA L4** (`24 GB GDDR6`) | **16 vCPUs** (`8` phys. cores) + **64 GB DDR5** | `$0.44/h` / `$1.34/h` | `$0.88/hr` (Spot)<br>`$2.67/hr` (OD) | Only `$0.06/hr/agent` cheaper than `g2-custom-24-49152` despite having 33% fewer CPU cores (8 vs. 12 physical cores). |
| **GCP `G2` — 32 vCPU** *(Max G2 CPU)* | **2× `g2-custom-32-65536`** *(or `g2-standard-32`)* | **1× NVIDIA L4** (`24 GB GDDR6`) | **32 vCPUs** (`16` phys. cores) + **64 GB DDR5** | `$0.61/h` / `$1.84/h` | `$1.22/hr` (Spot)<br>`$3.68/hr` (OD) | Optional upgrade (`32 vCPUs` per agent), though `g2-custom-24-49152` hits the better price/core sweet spot and easier Spot quota. |
| **GCP `A2` — Flagship** *(A100 Alternative)* | **2× `a2-highgpu-1g`** | **1× NVIDIA A100** (`40 GB HBM2`, 312 TFLOPS FP16) | **12 vCPUs** (`6` phys. cores) + **85 GB DDR4** | `$1.20/h` / `$3.67/h` | `$2.40/hr` (Spot)<br>`$7.35/hr` (OD) | $2.4\times$ more expensive than `g2-custom-24-49152` and only has 12 vCPUs (6 physical cores) per agent. |
| **AWS EC2 `G6`** *(Enterprise Alternative)* | **2× `g6.4xlarge`** *(or `2× g6.8xlarge`)* | **1× NVIDIA L4** (`24 GB GDDR6`) | **16 vCPUs** + **64 GB** *(or **32 vCPUs** + **128 GB**)* | `$0.46/h` / `$1.32/h`<br>*(32v: `$0.78/h`)* | `$0.92/hr` (Spot 16v)<br>`$1.56/hr` (Spot 32v) | No custom 24-vCPU shape on AWS EC2 (`g6` jumps from 16 to 32 vCPUs) and incurs egress fees from `gs://pkmn-arena`. |
| **RunPod Secure Cloud** *(Consumer GPU Alternative)* | **2× `RTX 4090` Pod** | **1× NVIDIA RTX 4090** (`24 GB GDDR6X`, 330 TFLOPS FP16) | **16–24 vCPUs** + **62 GB DDR5** | `$0.59/h` / `$0.69/h` | `$1.18/hr` (Spot)<br>`$1.38/hr` (OD) | Fast consumer GPU, but requires container API rather than pre-baked custom VM disk images and native `bwrap`. |
| **Lambda Cloud** *(High-Core A10)* | **1× `gpu_2x_a10`** | **1× NVIDIA A10** (`24 GB GDDR6`) | **30 vCPUs** + **100 GB RAM** per agent | — / `$0.75/h` | `$1.50/hr` (OD) | No Spot tier and frequent weekend capacity shortages. |

### 6.3 Anti-Starvation vs. Agent-Loading Churn (`selectNextTournamentBatch`)

In a GPU tournament where agents carry 1–10+ GB of neural network weights, ONNX/TensorRT engines, and lookup tables, switching which agent is loaded on a VM incurs cold-start churn (reading weights into the VM's 48 GB DDR5 Linux page cache and warming JIT caches). `selectNextTournamentBatch` (`arena/tournament.ts`) balances anti-starvation against cold-start churn using three mechanisms:

1. **Mini-Batch Macro-Cycles ($B = 5$ or $B = 10$ Consecutive Games per Matchup Visit)**:
   - Each head-to-head matchup's $G$ games are divided into $C = G / B$ macro-cycles of $B$ consecutive games (`B = 5` for $G \in \{20, 30\}$; `B = 10` for $G \in \{50, 100\}$), keeping both agents resident in RAM (`vmtouch -t`) across all $B$ games.
2. **Zero-Copy Logical `p1`/`p2` Seat Alternation**:
   - On even games ($g = 2, 4, \dots, B$), the arbiter swaps the logical `p1` and `p2` SSH stream references in memory without swapping physical VMs.
3. **Sticky-VM Pivot Residency Bonus + Anti-Starvation Deficit**:
   - Each pending mini-batch $(i, j, c)$ is scored for Table $k$ (`res_1`, `res_2`) as:
     $$\text{Score}(i, j, c \mid \text{Table } k) = \underbrace{1000 \cdot (C - c)}_{\text{Macro-Cycle Wave Gate}} + \underbrace{10 \cdot \bigl((g_{\max} - g_i) + (g_{\max} - g_j)\bigr)}_{\text{Anti-Starvation Deficit}} + \underbrace{250 \cdot \mathbb{I}\!\left[\{i, j\} \cap \{\text{res}_1, \text{res}_2\} \neq \emptyset\right]}_{\text{Sticky-VM Pivot Bonus}}$$
   - **Quantitative Impact ($E = 12, G = 50, B = 10 \implies 3,300$ Games)**:
     - Naive 1-game Berger cycles: **`6,600` VM agent loads**.
     - $B = 10$ mini-batches without Sticky-VM Pivot: **`660` VM agent loads**.
     - $B = 10$ mini-batches **with Sticky-VM Pivot**: **`~365` VM agent loads** (**`94.5%` reduction in agent-loading churn**, while every entrant advances in 5 lockstep waves of 10 games per opponent).

### 6.4 Statistical Resolution Power by Games per Matchup ($G \in \{20, 30, 50, 100\}$)

In an $E$-entrant Round-Robin where every pair plays $G$ games ($G_{\text{agent}} = (E - 1)G$ total games per agent), the Laplace posterior standard error of an agent's tournament rating $R_i$ (relative to the field mean) and pairwise difference $R_i - R_j$ are:

$$\text{SE}(R_i) \approx \frac{400}{\ln 10} \sqrt{\frac{E - 1}{E} \cdot \frac{4}{E \cdot G}} \approx \frac{347.4}{\sqrt{E \cdot G}}\text{ Elo}, \qquad \text{SE}(R_i - R_j) \approx \frac{491.3}{\sqrt{E \cdot G}}\text{ Elo}$$

| Games / Matchup ($G$) | Mini-Batch Waves ($C \times B$) | Direct H2H 95% CI ($\pm \%$) | Min Single-H2H Score for $p < 0.05$ | Overall Tournament Rating 95% CI ($\pm 1.96\,\text{SE}(R_i)$) by Entrants ($E$) | Recommended Use Case |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **$G = 20$** | $4 \times 5\text{g}$ | $\pm 21.9\%$ | $15.5 / 20$ (`77.5%`) | $E=8: \mathbf{\pm 50.4\text{ Elo}}$ (`140` g/agent)<br>$E=12: \mathbf{\pm 42.1\text{ Elo}}$ (`220` g/agent)<br>$E=16: \mathbf{\pm 36.9\text{ Elo}}$ (`300` g/agent)<br>$E=24: \mathbf{\pm 30.4\text{ Elo}}$ (`460` g/agent) | **Large Fields ($E \ge 16$) or Qualifier Stage**: Every agent plays $300\text{–}460$ games, so overall tournament standings are well-settled ($\text{SE} \le 19\text{ Elo}$). |
| **$G = 30$** | $6 \times 5\text{g}$ *(or $3 \times 10\text{g}$)* | $\pm 17.9\%$ | $20.5 / 30$ (`68.3%`) | $E=8: \mathbf{\pm 41.1\text{ Elo}}$ (`210` g/agent)<br>$E=12: \mathbf{\pm 34.4\text{ Elo}}$ (`330` g/agent)<br>$E=16: \mathbf{\pm 30.1\text{ Elo}}$ (`450` g/agent)<br>$E=24: \mathbf{\pm 24.8\text{ Elo}}$ (`690` g/agent) | **Balanced Mid-Size Fields ($E = 10\text{–}16$)**: Sweet spot between weekend runtime and sub-$20\text{ Elo}$ standard error. |
| **$G = 50$** *(Recommended Default for $E \le 12$)* | $5 \times 10\text{g}$ | $\pm 13.9\%$ | $32.0 / 50$ (`64.0%`) | $E=6: \mathbf{\pm 35.9\text{ Elo}}$ (`250` g/agent)<br>$E=8: \mathbf{\pm 31.8\text{ Elo}}$ (`350` g/agent)<br>$E=10: \mathbf{\pm 28.9\text{ Elo}}$ (`450` g/agent)<br>$E=12: \mathbf{\pm 26.6\text{ Elo}}$ (`550` g/agent)<br>$E=16: \mathbf{\pm 23.3\text{ Elo}}$ (`750` g/agent) | **Premier Division ($E = 6\text{–}12$)**: Matches TCEC Premier Division depth; both overall standings ($\text{SE} \approx 13\text{–}16\text{ Elo}$) and individual H2H matchup cells ($\pm 13.9\%$) are statistically sharp. |
| **$G = 100$** | $10 \times 10\text{g}$ | $\pm 9.8\%$ | $60.0 / 100$ (`60.0%`) | $E=6: \mathbf{\pm 25.4\text{ Elo}}$ (`500` g/agent)<br>$E=8: \mathbf{\pm 22.5\text{ Elo}}$ (`700` g/agent)<br>$E=12: \mathbf{\pm 18.8\text{ Elo}}$ (`1100` g/agent) | **Invitational Top-6/Top-8 or Sunday 2-Agent Superfinal**: Gold-standard resolution where even a `60–40` (`+70 Elo`) edge in a single H2H is statistically significant. |

### 6.5 Horizontal Scaling Invariance & Master Cost Matrix (`2× g2-custom-24-49152` per Table)

Because GCP bills `g2-custom-24-49152` Spot VMs per second (after a 1-minute minimum) at **`$0.50/hr` per agent VM (`$1.00/hr` per 2-VM match table)** and every Spot VM boots from the pre-baked `pkmn-tourney` Custom Machine Image in `< 25s`, total compute cost depends **only on total Table-Hours ($H_{\text{table}} = \frac{G_{\text{total}}}{R_{\text{table}}}$)**, not on how many tables $K$ run in parallel:

$$\text{Total Cost} = H_{\text{table}} \times \$1.00/\text{hr} = \left(\frac{H_{\text{table}}}{K}\text{ wall-clock hours}\right) \times \left(K \times \$1.00/\text{hr}\right)$$

Below is the full sizing, wall-clock duration, and cloud cost matrix across **Standard Concurrent Pace (`40 games/hr/table`, $\bar{T}_{\text{game}} = 1.5\text{ min}$)** and **Conservative Heavy-Search Pace (`25 games/hr/table`, $\bar{T}_{\text{game}} = 2.4\text{ min}$)**:

| Entrants ($E$) | Matchups $\binom{E}{2}$ | Games / Matchup ($G$) | Total Games ($G_{\text{total}}$) | Games / Agent ($G_{\text{agent}}$) | Rating 95% CI ($\pm\text{Elo}$) | Table-Hours (`Cons. 25g/h` / `Std. 40g/h`) | Wall-Clock Time ($K=2$ Tables / 4 VMs) | Wall-Clock Time ($K=4$ Tables / 8 VMs) | Wall-Clock Time ($K=8$ Tables / 16 VMs) | **`g2-custom-24-49152` Spot Cost** (`$1.00/h` Table) `Cons.` / `Std.` | **`g2-custom-24-49152` On-Demand** (`$3.04/h` Table) `Cons.` / `Std.` |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **6** | 15 | **20** | 300 | 100 | $\pm 56.7$ | `12.0h` / `7.5h` | `6.0h` / `3.8h` | `3.0h` / `1.9h`* | `1.5h` / `0.9h`* | **$12.00** / **$7.50** | $36.48 / $22.80 |
| **6** | 15 | **30** | 450 | 150 | $\pm 46.3$ | `18.0h` / `11.3h` | `9.0h` / `5.6h` | `4.5h` / `2.8h`* | `2.3h` / `1.4h`* | **$18.00** / **$11.25** | $54.72 / $34.20 |
| **6** | 15 | **50** | 750 | 250 | $\pm 35.9$ | `30.0h` / `18.8h` | `15.0h` / `9.4h` | `7.5h` / `4.7h`* | `3.8h` / `2.3h`* | **$30.00** / **$18.75** | $91.20 / $57.00 |
| **6** | 15 | **100** | 1,500 | 500 | $\pm 25.4$ | `60.0h` / `37.5h` | `30.0h` / `18.8h` | `15.0h` / `9.4h`* | `7.5h` / `4.7h`* | **$60.00** / **$37.50** | $182.40 / $114.00 |
| **8** | 28 | **20** | 560 | 140 | $\pm 50.4$ | `22.4h` / `14.0h` | `11.2h` / `7.0h` | `5.6h` / `3.5h` | `2.8h` / `1.8h`* | **$22.40** / **$14.00** | $68.10 / $42.56 |
| **8** | 28 | **30** | 840 | 210 | $\pm 41.1$ | `33.6h` / `21.0h` | `16.8h` / `10.5h` | `8.4h` / `5.3h` | `4.2h` / `2.6h`* | **$33.60** / **$21.00** | $102.14 / $63.84 |
| **8** | 28 | **50** | 1,400 | 350 | $\pm 31.8$ | `56.0h` / `35.0h` | `28.0h` / `17.5h` | `14.0h` / `8.8h` | `7.0h` / `4.4h`* | **$56.00** / **$35.00** | $170.24 / $106.40 |
| **8** | 28 | **100** | 2,800 | 700 | $\pm 22.5$ | `112.0h` / `70.0h` | `56.0h` / `35.0h` | `28.0h` / `17.5h` | `14.0h` / `8.8h`* | **$112.00** / **$70.00** | $340.48 / $212.80 |
| **10** | 45 | **20** | 900 | 180 | $\pm 45.7$ | `36.0h` / `22.5h` | `18.0h` / `11.3h` | `9.0h` / `5.6h` | `4.5h` / `2.8h`* | **$36.00** / **$22.50** | $109.44 / $68.40 |
| **10** | 45 | **30** | 1,350 | 270 | $\pm 37.3$ | `54.0h` / `33.8h` | `27.0h` / `16.9h` | `13.5h` / `8.4h` | `6.8h` / `4.2h`* | **$54.00** / **$33.75** | $164.16 / $102.60 |
| **10** | 45 | **50** | 2,250 | 450 | $\pm 28.9$ | `90.0h` / `56.3h` | `45.0h` / `28.1h` | `22.5h` / `14.1h` | `11.3h` / `7.0h`* | **$90.00** / **$56.25** | $273.60 / $171.00 |
| **10** | 45 | **100** | 4,500 | 900 | $\pm 20.4$ | `180.0h` / `112.5h` | `90.0h` / `56.3h` | `45.0h` / `28.1h` | `22.5h` / `14.1h`* | **$180.00** / **$112.50** | $547.20 / $342.00 |
| **12** | 66 | **20** | 1,320 | 220 | $\pm 42.1$ | `52.8h` / `33.0h` | `26.4h` / `16.5h` | `13.2h` / `8.3h` | `6.6h` / `4.1h`* | **$52.80** / **$33.00** | $160.51 / $100.32 |
| **12** | 66 | **30** | 1,980 | 330 | $\pm 34.4$ | `79.2h` / `49.5h` | `39.6h` / `24.8h` | `19.8h` / `12.4h` | `9.9h` / `6.2h`* | **$79.20** / **$49.50** | $240.77 / $150.48 |
| **12** | 66 | **50** | 3,300 | 550 | $\pm 26.6$ | `132.0h` / `82.5h` | `66.0h` / `41.3h` | `33.0h` / `20.6h` | `16.5h` / `10.3h`* | **$132.00** / **$82.50** | $401.28 / $250.80 |
| **12** | 66 | **100** | 6,600 | 1,100 | $\pm 18.8$ | `264.0h` / `165.0h` | `132.0h` / `82.5h` | `66.0h` / `41.3h` | `33.0h` / `20.6h`* | **$264.00** / **$165.00** | $802.56 / $501.60 |
| **16** | 120 | **20** | 2,400 | 300 | $\pm 36.9$ | `96.0h` / `60.0h` | `48.0h` / `30.0h` | `24.0h` / `15.0h` | `12.0h` / `7.5h` | **$96.00** / **$60.00** | $291.84 / $182.40 |
| **16** | 120 | **30** | 3,600 | 450 | $\pm 30.1$ | `144.0h` / `90.0h` | `72.0h` / `45.0h` | `36.0h` / `22.5h` | `18.0h` / `11.3h` | **$144.00** / **$90.00** | $437.76 / $273.60 |
| **16** | 120 | **50** | 6,000 | 750 | $\pm 23.3$ | `240.0h` / `150.0h` | `120.0h` / `75.0h` | `60.0h` / `37.5h` | `30.0h` / `18.8h` | **$240.00** / **$150.00** | $729.60 / $456.00 |
| **16** | 120 | **100** | 12,000 | 1,500 | $\pm 16.5$ | `480.0h` / `300.0h` | `240.0h` / `150.0h` | `120.0h` / `75.0h` | `60.0h` / `37.5h` | **$480.00** / **$300.00** | $1,459.20 / $912.00 |
| **20** | 190 | **20** | 3,800 | 380 | $\pm 33.2$ | `152.0h` / `95.0h` | `76.0h` / `47.5h` | `38.0h` / `23.8h` | `19.0h` / `11.9h` | **$152.00** / **$95.00** | $462.08 / $288.80 |
| **20** | 190 | **30** | 5,700 | 570 | $\pm 27.1$ | `228.0h` / `142.5h` | `114.0h` / `71.3h` | `57.0h` / `35.6h` | `28.5h` / `17.8h` | **$228.00** / **$142.50** | $693.12 / $433.20 |
| **20** | 190 | **50** | 9,500 | 950 | $\pm 21.0$ | `380.0h` / `237.5h` | `190.0h` / `118.8h` | `95.0h` / `59.4h` | `47.5h` / `29.7h` | **$380.00** / **$237.50** | $1,155.20 / $722.00 |
| **24** | 276 | **20** | 5,520 | 460 | $\pm 30.4$ | `220.8h` / `138.0h` | `110.4h` / `69.0h` | `55.2h` / `34.5h` | `27.6h` / `17.3h` | **$220.80** / **$138.00** | $671.23 / $419.52 |
| **24** | 276 | **30** | 8,280 | 690 | $\pm 24.8$ | `331.2h` / `207.0h` | `165.6h` / `103.5h` | `82.8h` / `51.8h` | `41.4h` / `25.9h` | **$331.20** / **$207.00** | $1,006.85 / $629.28 |
| **24** | 276 | **50** | 13,800 | 1,150 | $\pm 19.2$ | `552.0h` / `345.0h` | `276.0h` / `172.5h` | `138.0h` / `86.3h` | `69.0h` / `43.1h` | **$552.00** / **$345.00** | $1,678.08 / $1,048.80 |

*\*When $K > E/2$ (e.g., $K = 8$ tables with $E \le 12$ entrants), all $K$ tables are kept 100% utilized by pulling games from multiple Berger rounds concurrently.*
