To ensure tournament variety and prevent bots from bringing trivial modifications of known public
teams or of their own submitted teams, each candidate team T is evaluated by its 1-Nearest-Neighbor
(1-NN) distance against the reference pool 𝒫: d_{1-NN}(T, 𝒫) = min_{B∈𝒫} D(T, B) ∈ [0, 6]. The
reference pool was first deduplicated using Smogon usage stats and iterative σ-clipping on its 1-NN
distribution (τ = μ_{1-NN} - kσ_{1-NN}), and the tournament threshold of 1.30 was chosen from the
resulting metagame 1-NN distribution. To build a 20-team submission, check each candidate team
against the reference pool (d_{1-NN} >= 1.30), add each passing team to your local pool directory,
and repeat so every team is at least 1.30 away from both the public blocklist and your other 19
teams.

Before comparing two teams A and B, both are canonicalized with
[@pkmn/sets](https://www.npmjs.com/package/@pkmn/sets) (stripping nicknames, genders, shininess, and
party/move slot order) and matched by canonical species. Each Pokémon species on A that is not
present on B contributes 1.00 to D(A, B). Each Pokémon species that is shared by both teams is
compared by its set and contributes up to 0.80 (0.80 × [0.50 × d_{moves} + 0.25 × d_{item} + 0.10 ×
d_{ability} + 0.15 × d_{stats}]). Because a shared species is capped at 0.80, replacing a Pokémon
with a different species (1.00) always contributes more uniqueness than completely overhauling the
moves, item, ability, and EVs of the same Pokémon (0.80).

Within a shared species, each unshared move on a 4-move set adds 0.10 (0.40 max), a different held
item adds 0.20, and a different ability adds 0.08. Functionally equivalent moves — specifically
Return ↔ Frustration and all stalling Protect variants (Protect, Detect, Spiky Shield, Baneful
Bunker, Burning Bulwark, Silk Trap, King's Shield, Obstruct) — are normalized to the same move ID.
Additionally, if both sets hold the same Mega Stone, differing pre-Mega base abilities are ignored
(0.00) unless at least one is a switch-in ability (such as Intimidate, Drizzle, or Trace).

Stat spreads (0.12 max) are compared using the L₁ distance of actual computed level-50 stats
relative to a neutral 0-EV baseline (L₁ = ∑ₛ|Δstatₛ/baseₛ|), protected by a two-tier anti-EV-gaming
deadband. If a Pokémon's moves, item, and ability are identical (d_{moves} + d_{item} + d_{ability}
= 0), a strict deadband of L₁ ≤ 0.30 applies — any EV, IV, or nature adjustments within that
deadband contribute 0.00 distance, and only a complete stat/role overhaul (L₁ > 0.30) will register.
When paired with at least one move, item, or ability change, a minor-creep deadband of L₁ ≤ 0.08
ignores small speed-creep/bulk tweaks and scales linearly above 0.08 up to the full 0.12 stat weight
at L₁ ≥ 0.50. In practice, reaching 1.30 against a closest-neighbor team requires either swapping at
least 2 Pokémon species (D ≥ 2.00), or swapping 1 Pokémon species (+1.00) plus at least 0.30 in set
changes across the remaining 5 Pokémon (e.g., 3 moves, or 1 item + 1 move).
