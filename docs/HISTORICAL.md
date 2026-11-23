# Historical Design Derivations, Benchmarks & Sizing Analyses

Mathematical derivations, Showdown log benchmarks, Monte Carlo simulations, pool-sampling proofs,
and cloud GPU sizing analyses from the original `pkmn.ai` Arena design.

## 1. Empirical Showdown Battle Duration Benchmarks (11.2M Games)

Continuous Arena games use Showdown's official timer (`starting = 150s`, `grace = 60s` Turn 1,
`maxPerTurn = 150s`, `addPerFirstTurn = 5s` on single-side mid-turn switches, `addPerTurn = 10s`
Singles / `25s` Doubles). With sequential time-slicing on the Mac mini, worst-case duration for an
$N$-turn Singles game is:

$$T_{\text{seq}}(N) = \begin{cases} 400 + 20N \text{ sec} & \text{no Team Preview (RBY, ADV, RAND)} \\ 420 + 20N \text{ sec} & \text{with Team Preview (SV)} \end{cases}$$

From all `2023-06` Showdown logs (**11,200,943 games**):

| Format | Battles | Turns (Mean / **p50** / p95 / p99) | Human Time (**p50** / p95) | Seq. Max Timer (**p50** / p95 / p99) |
| :--- | ---: | :--- | :--- | :--- |
| `gen1ou` (`RBY`) | 22,274 | 35.5 / **33** / 77 / 120 | **5:18** / 12:18 | **17:40** / 32:20 / 43:20 |
| `gen3ou` (`ADV`) | 61,084 | 24.0 / **22** / 51 / 81 | **3:58** / 10:09 | **14:00** / 23:40 / 33:40 |
| `gen9ou` (`SV`) | 2,110,279 | 18.2 / **18** / 36 / 52 | **4:05** / 8:53 | **13:00** / 19:00 / 24:20 |
| `gen9randombattle` (`RAND`) | 7,216,636 | 17.1 / **17** / 35 / 47 | **4:16** / 9:06 | **12:20** / 18:20 / 22:20 |

In practice, agents moving in `0.5–3s`/turn finish a 2-game match in **1–6 min**; two slow search
agents burning full banks average **~25 min** (~37 min at p95).

## 2. Batch MAP Generalized Davidson Rating System

### 2.1 Why Batch MAP Generalized Davidson

Agent versions are immutable ($\frac{d\theta_i}{dt} = 0$). Batch MAP over a 5-category Generalized
Davidson (1970) model (`server/ratings.ts`) avoids three human-ladder failure modes:

- **Glicko / WHR time-decay** inflates $RD' = \sqrt{RD^2 + c^2}$ while idle in queue, wasting
  matches on already-settled agents.
- **Sequential Elo** is order-dependent, random-walks with width $O(\sqrt{K})$, and doesn't
  retroactively propagate rating changes.
- **Game-level Bradley–Terry** treats Games 1 & 2 of a swapped-team blind pair as independent,
  compressing Elo spreads and understating SE under lopsided team matchups.

### 2.2 Blind-Pair 9-Outcome Sufficiency Proof

For skill log-odds $\Delta_{ij} = \theta_i - \theta_j$ and structural team/seat advantage $\delta$
(flipping $+\delta \mapsto -\delta$ in Game 2), with $\text{logit}\Pr(\text{G1}) = \Delta_{ij} + \delta$
and $\text{logit}\Pr(\text{G2}) = \Delta_{ij} - \delta$:

- **Sweep nuisance cancellation:** $\delta$ cancels identically for *any* distribution of $\delta$:
  $$\frac{\Pr(WW \mid \Delta_{ij}, \delta)}{\Pr(LL \mid \Delta_{ij}, \delta)} = \frac{\sigma(\Delta_{ij} + \delta)\,\sigma(\Delta_{ij} - \delta)}{\sigma(-\Delta_{ij} - \delta)\,\sigma(-\Delta_{ij} + \delta)} = e^{2\Delta_{ij}} \implies \Pr(WW \mid WW \cup LL, \Delta_{ij}) = \sigma(2\Delta_{ij})$$
- **Ancillarity of splits:** $\frac{\Pr(WL \mid \Delta_{ij}, \delta)}{\Pr(LW \mid \Delta_{ij}, \delta)} = e^{2\delta}$
  is independent of $\Delta_{ij}$.
- **5 sufficient-statistic categories:** Including ties (`T`), the 9 outcomes (`WW, WT, TW, WL, LW,
  TT, TL, LT, LL`) collapse losslessly to $y_{ij} \in \{+1, +0.5, 0, -0.5, -1\}$ (match points
  $S_{ij} \in \{2.0, 1.5, 1.0, 0.5, 0.0\}$):
  $$\Pr(Y_{ij} = y \mid \Delta_{ij}) = \frac{w_y \, e^{y \Delta_{ij}}}{Z(\Delta_{ij})}, \qquad Z(\Delta_{ij}) = e^{\Delta_{ij}} + \nu_1 e^{\Delta_{ij}/2} + \nu_0 + \nu_1 e^{-\Delta_{ij}/2} + e^{-\Delta_{ij}}$$
  where $w_{\pm 1} = 1$, $w_{\pm 0.5} = \nu_1$ (`WT`/`TW`/`TL`/`LT`), and $w_0 = \nu_0$ (`WL`/`LW`/`TT`).

### 2.3 Future Augmentations & Cross-Validation Gate

1. **Bounded-luck floor ($\beta \in (0, 1]$, BlaTMMR):** Damps probabilities by ceiling $\beta$
   ($1 - \beta$ = irreducible RNG/matchup floor; $\beta = 1$ recovers standard Davidson).
2. **Cyclic styles (`mElo-2`, $\mathbf{u}_i \in \mathbb{R}^2$):** Adds skew-symmetric interaction
   $\Delta_{ij} = (\theta_i - \theta_j) + \mathbf{u}_i^\top \mathbf{J} \mathbf{u}_j$,
   $\mathbf{J} = \begin{pmatrix} 0 & 1 \\ -1 & 0 \end{pmatrix}$, keeping scalar skill $\theta_i$.

Both re-optimize retroactively from `pair_aggregates` in `< 5 ms` with zero schema changes. Enable on
a ladder only once it has $\ge 1,000$ matches and 5-fold CV reduces held-out Log-Loss by
$\ge \mathbf{0.005\text{ nats/match}}$ (paired bootstrap $p < 0.01$).

## 3. Active Matchmaking Benchmarks (52 Agents, 20 Trials)

`selectNextArenaMatch` (`server/matchmaker.ts`) combines Fisher information gain, adjacent-rank LCB
overlap, and UCB challenger triage:

| Strategy | New Top-10 Latency | Top-3 Exact | Top-10 Stable | Full-52 $\tau \ge 0.95$ | Top-5 Rank Err @ 12k |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Round-Robin** | 220.7 matches | 21,649 | 24,354 | 13,012 | 1.09 |
| **Active ($\alpha = 0.45$)** | **78.1 matches** | **11,890** | **15,694** | **12,023** | **0.35** |

### Two-Tier SSD Residency Bonus ($\rho_{ij}$)

When active versions exceed the Mac mini's internal SSD hot budget (~150–170 GB), cold versions swap
from `/Volumes/Archive` (~0.8–1.5s). Multiplying pair scores by $\rho_{ij} = 1.15$ (both resident),
$1.05$ (one resident), or $1.00$ (neither) cuts cold swap-ins by `>80%` without starving cold agents
(since $\text{IG}(i,j)$, `triageBonus` up to $3.0\times$, and repeat damper $\frac{1}{1 + 0.25 m_{ij}}$
vary by $2\times\text{–}10\times$).

## 4. Ranking, Challenger Usurpation & Post-Match Complexity

### 4.1 Match-Based `W–L–T` Records

Single games in a swapped-team blind pair are not independent. SQLite keeps all 5 Davidson
categories, while UI records collapse them into ternary Match `W / L / T` (single-game ties occur in
`< 0.05%` of games, so `W ≈ 2–0`, `T ≈ 1–1`, `L ≈ 0–2`):

| Displayed | 2-Game Outcomes | Points ($S_{ij}$) | Davidson ($y_{ij}$) | SQLite Formula |
| :--- | :--- | :---: | :---: | :--- |
| **Win (`W`)** | `WW`, `WT`, `TW` | $2.0$ / $1.5$ | $+1.0$ / $+0.5$ | `ww + wt` |
| **Tie (`T`)** | `WL`, `LW`, `TT` | $1.0$ | $0.0$ | `split` |
| **Loss (`L`)** | `LL`, `LT`, `TL` | $0.0$ / $0.5$ | $-1.0$ / $-0.5$ | `ll + tl` |
| **Total** | All 9 | — | — | `matches_played = W + L + T` |

### 4.2 Preventing Unsettled Challenger Usurpation

Sorting by raw Elo lets an unsettled challenger (`AsterAI`, `1720 ± 79`, 15 matches, $\text{SE}=40.3$)
leapfrog an established champion (`wolfe`, `1679 ± 37`, 300 matches, $\text{SE}=18.9$) despite only
~82% LOS and a lower 95% lower bound (`1641 < 1642`), and makes early small-sample streaks (`4–0`,
`1760 ± 160`) permanent all-time peaks. Three mechanisms prevent this:

1. **Conservative Rating (`rating_lcb`) sort key:** $R_{\text{LCB}, i} = R_i - 1.96\,\text{SE}(R_i)$
   (analogous to Showdown `ACRE` / TrueSkill $\mu - k\sigma$). Challenger $C$ passes incumbent $H$
   iff $R_C - R_H > 1.96(\text{SE}_C - \text{SE}_H)$, converging to pure Elo as SEs equalize.
2. **Two-stage gates:**
   - **Provisional** (`matches_played < 10` or `rating_se > 60` Elo, $\text{CI}_{95} > \pm 118$):
     badged `[Provisional]`, Rank `—`.
   - **Settled** (`matches_played >= 25` and `rating_se <= 30` Elo, $\text{CI}_{95} \le \pm 58.8$):
     required to record peak milestones (`Max Elo`, `Max GXE`, `Best Rank`) or claim `#1` roles.
3. **Guaranteed Plausible Rank Bounds (`[rank_min, rank_max]`):** `computeGuaranteedRankBounds`
   (`server/ratings.ts`) evaluates pairwise $\text{LOS}(i > j) = \Phi\!\left(\frac{\theta_i - \theta_j}{\sqrt{\Sigma_{ii} + \Sigma_{jj} - 2\Sigma_{ij}}}\right) \ge 0.95$.
   A `[1, 4]` powerhouse immediately accrues Top-10 reign time (`rank_max <= 10`), while Top-1
   requires `rank_current === 1`, `settled_at IS NOT NULL`, and `LCB_1 >= LCB_2`.

### 4.3 Post-Match Latency ($M = 150$ Versions, Independent of Total Matches)

| Step | Target | Complexity | Time | Notes |
| :--- | :--- | :---: | :---: | :--- |
| 1. `W/L/T` & streaks | 2 `ladder_entries`, 2 `agent_ladder_stats`, 1 `pair_aggregates` | $O(1)$ | `< 0.03 ms` | In-place count & streak updates. |
| 2. Davidson MAP + Cholesky | $\le \binom{M}{2}$ pairs, $M \times M$ `Float64Array` | $O(M^2 + \tfrac{1}{6}M^3)$ | `~0.75 ms` | Warm-started: 3–5 Newton steps (`~0.15 ms`) + Cholesky inv (`~0.60 ms`). |
| 3. Rank bounds | $B \le 85$ active families | $O(B^2)$ | `~0.04 ms` | 7,225 inline `normalCdf` checks over $\boldsymbol{\Sigma}$. |
| 4. Peaks & Top-$K$ clocks | $M$ entries + $B$ stats | $O(M)$ | `~0.02 ms` | Adds $\Delta t$ to `top{1,10,100}_total_seconds` when `rank_max <= K`. |
| 5. WAL commit + HTML/JSON | 1 `BEGIN IMMEDIATE` + atomic writes | $O(M)$ | `~1.5–4.0 ms` | Batch update + atomic rename. |
| **Total** | — | **$O(M^3)$** | **`~2.3–4.8 ms`** | **0.00% overhead** vs. 1–25 min matches. |

## 5. Seasonal 20-Team Pools (`VGC` Pseudo-Blind-Pair Mode)

Each project submits $T = 20$ valid teams on first entry.

### 5.1 Uniqueness vs. Probing Dilemma

- **Cross-competitor rejection = membership oracle:** Rejecting Project $B$ for overlapping Project
  $A$'s private teams lets an attacker probe earlier submissions (even an $M/T$ threshold collapses
  to a 1-bit oracle by fixing $M-1$ staples, probing $X$ in slot $M$, and padding $M+1\dots 20$).
- **Silent overlap without ownership tracking** breaks the knowledge bound if $A$ and $G$ submit the
  same canonical team $H$.

### 5.2 Zero-Oracle $d_{\text{1-NN}} \ge 1.30$ & Uniform $\frac{2}{N}$ Sampling

`teams/index.ts` validates strictly against the public reference pool + the submitter's own prior
slots ($d_{\text{1-NN}} \ge 1.30$). `samplePoolsPair` (`server/teams.ts`) avoids flat-pool rejection
bias (which under-samples active players by $\frac{1}{N(N-1)}$ and over-samples third parties by
$\frac{2}{N(N-1)(N-2)}$, incentivizing pool poisoning):

- Requiring $X_A + X_B \le 1$ (at most 1 match team from $P_A \cup P_B$) and $\mathbb{E}[X_i] = \frac{2}{N}$
  implies $\Pr(X_A + X_B = 1) = \frac{4}{N} \le 1 \implies N \ge 4$ (`min_agents: 4`, $\ge 80$ teams).
- Sample unordered distinct rosters $\{I, J\}$ first: $\{P_A, P_C\}$ w.p. $\frac{2}{N}$, $\{P_B, P_C\}$
  w.p. $\frac{2}{N}$, and $\{P_{C_1}, P_{C_2}\}$ w.p. $\frac{N-4}{N}$ (uniform over third parties).
  Every third party $P_C$ gets marginal probability:
  $$\frac{2}{N}\cdot\frac{1}{N-2} + \frac{2}{N}\cdot\frac{1}{N-2} + \frac{N-4}{N}\cdot\frac{2}{N-2} = \frac{2}{N}$$
- Fair-coin orient $(I, J)$, draw $T_1 \sim \text{Unif}(\mathcal{R}_I)$ and
  $T_2 \sim \text{Unif}(\mathcal{R}_J)$, and rejection-resample if: all 6 species match,
  $\text{Owners}(T_1) \cap \text{Owners}(T_2) \neq \emptyset$, either team is jointly owned by $P_A$
  and $P_B$, or $|(\text{Owners}(T_1) \cup \text{Owners}(T_2)) \cap \{P_A, P_B\}| > 1$.

## 6. Cloud GPU Tournaments (TCEC / CCC Mode)

### 6.1 Continuous Arena (CCRL) vs. Live Tournament (TCEC / CCC)

| Dimension | Continuous Arena (CCRL) | Live Tournament (TCEC / CCC) |
| :--- | :--- | :--- |
| **Coordinator & Sim** | M6 Mac mini 2 E-cores (`pkmn@arena`). | Tournament coordinator (`<0.2 ms`/turn, `<50 MB` RAM for $K \le 16$ tables). |
| **Worker Hardware** | Owned **M6 Mac mini** (`darwin/arm64` + `libkrun`), 12c CPU (`2S+4P+6E`) / 12c GPU, 32 GB Unified. | Ephemeral **1-Agent GCP `g2-custom-24-49152` Spot VMs** (`Ubuntu 24.04 x86_64`): 1× NVIDIA L4 (`24 GB`), 24 vCPUs (12 Xeon cores), 48 GB DDR5 (`$0.50/hr` Spot/agent = **`$1.00/hr`/table**). |
| **Per-Agent Compute** | Time-sliced: 10c CPU (`2S+4P+4E`) + M6 GPU (~5 TFLOPS) + 14 GiB RAM while active. | Dedicated (`1 VM = 1 Agent`): L4 (242 TFLOPS FP16 / 485 TOPS INT8, 24 GB VRAM) + 24 vCPUs + 48 GB RAM (72 GB total). |
| **Execution** | Sequential (`ponder = false`; `SIGSTOP` / `podman pause`). | Concurrent (`ponder = true`; overlapping simultaneous turns + pondering). |
| **Sandbox** | macOS Seatbelt + `limit.c` + `pf` (or `krunkit`). | Rootless `bwrap --unshare-all` (RO rootfs + `/tmp` tmpfs) + KVM hypervisor isolation. |
| **Clock** | Local `performance.now()`. | Measured on-VM in `/opt/arena/bin/tourney-agent` (`ARENA_TURN_MS`), excluding SSH RTT. |
| **Teams & Replays** | 2-game swapped-team (`\|utm\|`) blind pairs; logs hidden (`pools` published once `archived`). | Standalone BYOT (`/utm`) or locked $2M$-team blind-pair book; public live broadcast & replays. |

### 6.2 Cloud GPU Sizing (`2× g2-custom-24-49152` Spot)

Forward battle rollouts (`@pkmn/engine`, `poke-engine`, MCTS/CFR) are CPU-heavy. Multi-GPU GCP `G2`
shapes cap CPU at 12 vCPUs (6 physical Xeon cores) per GPU with zero multi-GPU discount, whereas
1-GPU custom `G2` (`g2-custom-24-49152`) doubles CPU to 24 vCPUs (12 physical cores) + 48 GB RAM for
`$0.50/hr` Spot while isolating preemption to 1 game:

| Provider & Tier | Per Table (2 Agents) | GPU / Agent | CPU & RAM / Agent | 1-VM (`Spot`/`OD`) | Table (`Spot`/`OD`) | Notes |
| :--- | :--- | :--- | :--- | :---: | :---: | :--- |
| **GCP `G2` 24v** *(Selected)* | 2× `g2-custom-24-49152` | L4 (`24 GB`, 242 TF) | 24v (12c) + 48 GB | **`$0.50`** / `$1.52` | **`$1.00`** / `$3.04` | Committed standard; 2× cores vs `g2-standard-12`. |
| **GCP `G2` 12v** | 2× `g2-standard-12` | L4 (`24 GB`) | 12v (6c) + 48 GB | `$0.38` / `$1.14` | `$0.75` / `$2.28` | 6 physical cores bottleneck CPU search. |
| **GCP `G2` 16v** | 2× `g2-standard-16` | L4 (`24 GB`) | 16v (8c) + 64 GB | `$0.44` / `$1.34` | `$0.88` / `$2.67` | Only `$0.06/h` cheaper for 33% fewer cores. |
| **GCP `G2` 32v** | 2× `g2-custom-32-65536` | L4 (`24 GB`) | 32v (16c) + 64 GB | `$0.61` / `$1.84` | `$1.22` / `$3.68` | Optional upgrade; harder Spot quota. |
| **GCP `A2` A100** | 2× `a2-highgpu-1g` | A100 (`40 GB`, 312 TF) | 12v (6c) + 85 GB | `$1.20` / `$3.67` | `$2.40` / `$7.35` | $2.4\times$ cost, only 6 physical cores. |
| **AWS EC2 `G6`** | 2× `g6.4xl` (`8xl`) | L4 (`24 GB`) | 16v+64G (32v+128G) | `$0.46` / `$1.32` (`$0.78`) | `$0.92` (`$1.56` 32v) | No 24v shape; GCS egress fees. |
| **RunPod** | 2× `RTX 4090` | 4090 (`24 GB`, 330 TF) | 16–24v + 62 GB | `$0.59` / `$0.69` | `$1.18` / `$1.38` | Container API only; no custom VM images/`bwrap`. |
| **Lambda Cloud** | 1× `gpu_2x_a10` | A10 (`24 GB`) | 30v + 100 GB | — / `$0.75` | — / `$1.50` | No Spot; weekend shortages. |

### 6.3 Anti-Starvation vs. Cold-Start Churn (`selectNextTournamentBatch`)

`arena/tournament.ts` cuts weight-loading churn (1–10+ GB per agent) via:
1. **Mini-batch macro-cycles:** Split $G$ games into $C = G/B$ waves of $B$ consecutive games (`B=5`
   for $G \in \{20,30\}$; `B=10` for $G \in \{50,100\}$), keeping weights warm (`vmtouch -t`).
2. **Zero-copy seat swap:** On even games ($g = 2, 4, \dots, B$), swap logical `p1`/`p2` SSH streams
   in memory without swapping VMs.
3. **Sticky-VM Pivot + Deficit score** for Table $k$ (`res_1`, `res_2`):
   $$\text{Score}(i, j, c \mid k) = \underbrace{1000(C - c)}_{\text{Wave Gate}} + \underbrace{10\bigl((g_{\max} - g_i) + (g_{\max} - g_j)\bigr)}_{\text{Anti-Starvation Deficit}} + \underbrace{250\,\mathbb{I}[\{i, j\} \cap \{\text{res}_1, \text{res}_2\} \neq \emptyset]}_{\text{Sticky-VM Pivot}}$$
   For $E = 12, G = 50, B = 10$ (`3,300` games): naive 1-game Berger = **6,600** loads; $B=10$ alone
   = **660**; $B=10$ + Sticky-VM Pivot = **~365** (**94.5% reduction**).

### 6.4 Statistical Resolution ($G \in \{20, 30, 50, 100\}$)

For an $E$-entrant Round-Robin with $G$ games/matchup ($G_{\text{agent}} = (E-1)G$):

$$\text{SE}(R_i) \approx \frac{400}{\ln 10}\sqrt{\frac{E-1}{E}\cdot\frac{4}{E \cdot G}} \approx \frac{347.4}{\sqrt{E \cdot G}}\text{ Elo}, \qquad \text{SE}(R_i - R_j) \approx \frac{491.3}{\sqrt{E \cdot G}}\text{ Elo}$$

| $G$ | Waves ($C \times B$) | H2H 95% CI | Min H2H ($p<0.05$) | Rating 95% CI ($\pm 1.96\,\text{SE}(R_i)$) | Use Case |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **20** | $4 \times 5$ | $\pm 21.9\%$ | $15.5/20$ (`77.5%`) | $E=8: \pm 50.4$ (`140`g); $12: \pm 42.1$ (`220`g); $16: \pm 36.9$ (`300`g); $24: \pm 30.4$ (`460`g) | Large fields ($E \ge 16$) / Qualifier ($\text{SE} \le 19$). |
| **30** | $6 \times 5$ ($3 \times 10$) | $\pm 17.9\%$ | $20.5/30$ (`68.3%`) | $E=8: \pm 41.1$ (`210`g); $12: \pm 34.4$ (`330`g); $16: \pm 30.1$ (`450`g); $24: \pm 24.8$ (`690`g) | Mid-size fields ($E = 10\text{–}16$). |
| **50** *(Default)* | $5 \times 10$ | $\pm 13.9\%$ | $32.0/50$ (`64.0%`) | $E=6: \pm 35.9$ (`250`g); $8: \pm 31.8$ (`350`g); $10: \pm 28.9$ (`450`g); $12: \pm 26.6$ (`550`g); $16: \pm 23.3$ (`750`g) | Premier Division ($E = 6\text{–}12$, TCEC depth). |
| **100** | $10 \times 10$ | $\pm 9.8\%$ | $60.0/100$ (`60.0%`) | $E=6: \pm 25.4$ (`500`g); $8: \pm 22.5$ (`700`g); $12: \pm 18.8$ (`1100`g) | Top-6/8 Invitational or Sunday Superfinal. |

### 6.5 Horizontal Scaling & Cost Matrix (`2× g2-custom-24-49152`/Table)

With per-second Spot billing (`$1.00/hr`/table) and `< 25s` boots from `pkmn-tourney` images, total
cost depends only on Table-Hours $H_{\text{table}}$, independent of parallel tables $K$:
$\text{Cost} = H_{\text{table}} \times \$1.00/\text{hr}$. Shown for **Conservative (`25 g/h`, 2.4m/g)** /
**Standard (`40 g/h`, 1.5m/g)**:

| $E$ | $\binom{E}{2}$ | $G$ | $G_{\text{total}}$ | $G_{\text{agent}}$ | 95% CI | Table-Hours (`Cons`/`Std`) | Wall ($K=2$) | Wall ($K=4$) | Wall ($K=8$) | **Spot** (`$1.00/h`) | **On-Demand** (`$3.04/h`) |
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

*\*When $K > E/2$, tables stay 100% utilized by pulling games from multiple Berger rounds concurrently.*
