# Team Distance (`teams/`)

To prevent trivial tweaks of public teams or an agent's own roster, each candidate team $T$ is scored
by its 1-Nearest-Neighbor (1-NN) distance to reference pool $\mathcal{P}$:
$d_{\text{1-NN}}(T, \mathcal{P}) = \min_{B \in \mathcal{P}} D(T, B) \in [0, 6]$. The reference pool
was deduplicated using Smogon usage stats and iterative $\sigma$-clipping
($\tau = \mu_{\text{1-NN}} - k\sigma_{\text{1-NN}}$), yielding a tournament threshold of **1.30**.
To build a 20-team submission, verify each candidate against $\mathcal{P}$ ($d_{\text{1-NN}} \ge 1.30$),
add passing teams to your local pool directory, and repeat so all 20 teams are $\ge 1.30$ from both
the public blocklist and each other.

Teams $A$ and $B$ are first canonicalized with [@pkmn/sets](https://www.npmjs.com/package/@pkmn/sets)
(stripping nicknames, genders, shininess, and party/move slot order) and matched by canonical species:

- **Unshared species (`1.00` each):** Always outweighs overhauling a shared species (`0.80` max).
- **Shared species (`0.80` max):** $0.80 \times (0.50\,d_{\text{moves}} + 0.25\,d_{\text{item}} + 0.10\,d_{\text{ability}} + 0.15\,d_{\text{stats}})$:
  - **Moves (`0.40` max):** `0.10` per unshared move on a 4-move set. `Return`/`Frustration` and
    stalling Protect variants (`Protect`, `Detect`, `Spiky Shield`, `Baneful Bunker`,
    `Burning Bulwark`, `Silk Trap`, `King's Shield`, `Obstruct`) normalize to the same move ID.
  - **Item (`0.20`):** `0.20` if different.
  - **Ability (`0.08`):** `0.08` if different. If both sets hold the same Mega Stone, differing
    pre-Mega base abilities score `0.00` unless at least one is a switch-in ability (e.g.
    `Intimidate`, `Drizzle`, `Trace`).
  - **Stats (`0.12` max):** $L_1 = \sum_s |\Delta\text{stat}_s / \text{base}_s|$ on level-50 stats
    vs. a neutral 0-EV baseline, with a two-tier anti-EV-gaming deadband:
    - Identical moves, item, and ability ($d_{\text{moves}} + d_{\text{item}} + d_{\text{ability}} = 0$):
      $L_1 \le 0.30 \mapsto 0.00$ (only a full role overhaul registers).
    - Otherwise: $L_1 \le 0.08 \mapsto 0.00$, scaling linearly to `0.12` at $L_1 \ge 0.50$.

In practice, $D \ge 1.30$ requires swapping $\ge 2$ species ($D \ge 2.00$), or swapping 1 species
(`+1.00`) plus $\ge 0.30$ in set changes across the remaining 5 Pokémon (e.g., 3 moves, or 1 item + 1
move).
