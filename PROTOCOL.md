# Arena Agent Protocol (`stdin` / `stdout` & Policy Logging)

Arena agents are executed as single-game subprocesses that speak Pokémon Showdown's player stream protocol over `stdin` and `stdout`.

## 1. Stream Lifecycle

1. **Assigned Team (`|utm|<packed_team>`)**: Before `|init|battle`, the arbiter writes your full assigned team (including exact EVs, IVs, and Natures) in `@pkmn/sets` packed format:
   ```text
   |utm|<packed_team>
   ```
   Always slice after the 5-character prefix (`line.slice(5)`) rather than splitting on `|`, because packed team strings use `|` internally as field delimiters.
2. **Battle Events & Decision Requests (`|request|<json>`)**: As the battle progresses, the arbiter writes Showdown protocol lines to your `stdin`, ending each decision prompt with:
   ```text
   |request|{"active":[...],"side":{...}}
   |inactive|Time left: 150.0 sec this turn | 150.0 sec total | 60.0 sec grace
   ```
   - Never identify your seat by display name (blind-pair ladder games anonymize players as `"Bot A"` and `"Bot B"`). Always read `request.side.id` (`"p1"` or `"p2"`).
   - If `request.wait` is truthy (or `request` has none of `teamPreview`, `forceSwitch`, `active`), do **not** write anything to `stdout`.
3. **Responding on `stdout` (`<policy_json>` + `<choice>`)**: For every decision `|request|` (where `request.wait` is falsy), write **two** newline-terminated lines to `stdout` and **flush immediately**:
   1. A single-line plain-text JSON object mapping every legal canonical choice to a float probability in `[0, 1]` summing to `1.0` (`±0.001`). Just like Pokémon Showdown room chat, write the JSON text directly with **no** `/say` prefix.
   2. Your simulator choice line (e.g. `move 1`, `move 2 terastallize`, `switch 3`, `team 1234`, or `/choose move 1`).
   ```text
   {"move 1":0.625,"move 2":0.25,"move 3":0,"move 4":0,"switch 2":0.125,"switch 3":0}
   move 1
   ```
   Write any diagnostic logs to `stderr`, never `stdout`.

## 2. Chat Elision, Timers & Retries

- **Zero Inter-Agent Communication**: Plain-text chat lines from agents are **never** sent to the opponent's `stdin` (all `|c|`, `|c:|`, `|chat|`, `|html|`, `|raw|`, and `|uhtml|` lines are stripped from player streams). Validated policy JSON is recorded as `|c|☆<Agent>|<json>` solely in the omniscient battle log for post-tournament / post-retirement archives and Pokémon Showdown moderation analysis.
- **Time-Slicing (`SIGSTOP` / `SIGCONT`)**: On ladder hardware, your process group is frozen (`SIGSTOP`) immediately after your choice newline arrives on `stdout` and resumed (`SIGCONT`) on your next turn. Do not track your remaining bank across turns via wall-clock `Date.now()` deltas—always parse `|inactive|Time left: ...` on `stdin`, and finish per-turn state updates *before* flushing your choice newline.
- **Invalid Choices (`|error|[Invalid choice]`)**: If a choice is rejected (or if policy validation fails during smoke testing), the arbiter writes `|error|[Invalid choice] ...` to `stdin` while your turn clock keeps running. Three consecutive invalid attempts on the same request forfeit the game (`invalid_choice_3x`).

## 3. Policy JSON Specification

Every decision `|request|` requires a flat JSON object `Record<string, number>` satisfying:

1. **Range & Normalization**: Every value is a finite float in `[0, 1]`, and the sum across all entries is within `1.0 ± 0.001` (`1e-3`). Deterministic or greedy agents simply set `1` on their selected choice and `0` on all remaining legal choices.
2. **Full Legal Coverage**: Every core legal choice implied by your `|request|` JSON must appear in the object (assign `0` to unchosen legal options), and no illegal choices may appear.
3. **Consistency with Chosen Action**: The choice emitted on the next `stdout` line must be explicit (`default` / `auto` is rejected) and must have strictly positive probability (`policy[chosen] > 0`).

### Canonical Choice Keys

All indices are **1-based** indices into `request.active[slot].moves` or `request.side.pokemon`:

| Request Phase | Format | Canonical Key Pattern | Examples |
| :--- | :--- | :--- | :--- |
| **`teamPreview`** | Singles (`maxChosenTeamSize` omitted or `1`) | `team <lead>` | `"team 1"` .. `"team 6"` |
| **`teamPreview`** | Doubles / VGC (`maxChosenTeamSize = 4`) | `team <l1><l2><b1><b2>` (`l1 != l2`, `b1 < b2`) | `"team 1234"`, `"team 2135"` |
| **`forceSwitch`** | Singles (`forceSwitch.length === 1`) | `switch <slot>` (or `"pass"` if none) | `"switch 2"`, `"switch 5"` |
| **`forceSwitch`** | Doubles (`forceSwitch.length === 2`) | `<slot1>, <slot2>` (`switch <s>` or `pass`, distinct bench slots) | `"switch 3, pass"`, `"switch 3, switch 4"` |
| **`active`** | Singles (`active.length === 1`) | `move <1..4>[ <gimmick>]` or `switch <2..6>` | `"move 1"`, `"move 2 terastallize"`, `"switch 3"` |
| **`active`** | Doubles (`active.length === 2`) | `<slot1>, <slot2>` (`+1`/`+2` foe or `-1`/`-2` ally targets when choosable) | `"move 1 +1, move 2"`, `"move 1 +2 terastallize, switch 3"`, `"pass, move 1"` |

- **Gimmick suffixes**: `mega`, `megax`, `megay`, `ultra`, `zmove`, `dynamax`, `terastallize` (at most one gimmick across both active slots in Doubles). When a Pokémon is *already* Dynamaxed (`!canDynamax && maxMoves`), omit `dynamax`.
- **Doubles target suffixes**: Include target specifiers **only** when a move's `target` is in `{'normal', 'any', 'adjacentFoe', 'adjacentAlly', 'adjacentAllyOrSelf'}` (`+1` / `+2` for foe left/right; `-1` / `-2` for ally left/right). Spread, self-targeting, and field moves (`allAdjacentFoes`, `allAdjacent`, `self`, `allySide`, etc.) take **no** target suffix. Self-ally targeting (`move 1 -2` on a `'normal'`/`'any'` move) is optional: you may omit it or include it, provided all foe-targeted core actions (`+1`, `+2`) are present.
- **All moves disabled (Struggle)**: If every move slot is disabled (`0` PP or mid-turn `maybeDisabled` update), the sole move choice is `"move 1"`.

## 4. Sample TypeScript Helper (`emptyPolicy`)

The function below takes a parsed Pokémon Showdown `|request|` JSON object and returns a `Record<string, number>` initialized with `0` for every canonical legal choice (or `undefined` when `request.wait` is set and no action should be sent):

```ts
export interface SidePokemonRequest {
  ident: string;
  details: string;
  condition: string;
  active?: boolean;
  commanding?: boolean;
  reviving?: boolean;
}

export interface MoveSlotRequest {
  move: string;
  id: string;
  pp?: number;
  target?: string;
  disabled?: boolean | string;
}

export interface ActivePokemonRequest {
  moves: MoveSlotRequest[];
  trapped?: boolean;
  canMegaEvo?: boolean;
  canMegaEvoX?: boolean;
  canMegaEvoY?: boolean;
  canUltraBurst?: boolean;
  canZMove?: Array<{move: string; target?: string} | null>;
  canDynamax?: boolean;
  maxMoves?: {
    maxMoves: Array<{move: string; target?: string; disabled?: boolean}>;
  };
  canTerastallize?: string;
}

export interface BattleRequest {
  wait?: boolean;
  teamPreview?: boolean;
  maxChosenTeamSize?: number;
  forceSwitch?: boolean[];
  active?: Array<ActivePokemonRequest | null>;
  side: {
    name: string;
    id: 'p1' | 'p2' | 'p3' | 'p4';
    pokemon: SidePokemonRequest[];
  };
}

const CHOOSABLE_TARGETS = new Set([
  'normal',
  'any',
  'adjacentAlly',
  'adjacentAllyOrSelf',
  'adjacentFoe',
]);

function isFainted(p: SidePokemonRequest | undefined): boolean {
  if (!p) return true;
  return p.condition === '0 fnt' || p.condition.endsWith(' fnt') || p.condition.startsWith('0/');
}

function isMoveDisabled(m: MoveSlotRequest): boolean {
  return m.pp === 0 || m.disabled === true || (typeof m.disabled === 'string' && m.disabled !== '');
}

function moveTargets(target: string | undefined, slotIdx: number, numActive: number): string[] {
  if (numActive <= 1 || !target || !CHOOSABLE_TARGETS.has(target)) return [''];
  const ally = slotIdx === 0 ? '-2' : '-1';
  if (target === 'adjacentAlly') return [ally];
  if (target === 'adjacentAllyOrSelf') return ['-1', '-2'];
  return ['+1', '+2'];
}

interface SlotChoice {
  choice: string;
  switchSlot?: number;
  usesGimmick: boolean;
}

function activeSlotChoices(
  req: BattleRequest,
  slotIdx: number,
  numActive: number,
  bench: number[]
): SlotChoice[] {
  const mon = req.side.pokemon[slotIdx];
  const slot = req.active?.[slotIdx];
  if (!slot || isFainted(mon) || mon?.commanding) {
    return [{choice: 'pass', usesGimmick: false}];
  }

  const out: SlotChoice[] = [];
  let moveCount = 0;
  const alreadyDynamaxed = !slot.canDynamax && Boolean(slot.maxMoves);

  for (let i = 0; i < slot.moves.length; i++) {
    const mv = slot.moves[i];
    const idx = i + 1;
    const baseDisabled = isMoveDisabled(mv);
    const effDisabled = alreadyDynamaxed
      ? Boolean(slot.maxMoves?.maxMoves[i]?.disabled)
      : baseDisabled;
    const effTarget = alreadyDynamaxed
      ? slot.maxMoves?.maxMoves[i]?.target ?? mv.target
      : mv.target;

    if (!effDisabled) {
      for (const t of moveTargets(effTarget, slotIdx, numActive)) {
        out.push({choice: `move ${idx}${t ? ` ${t}` : ''}`, usesGimmick: false});
        moveCount++;
      }
    }

    if (!baseDisabled) {
      const gimmicks: string[] = [];
      if (slot.canMegaEvo) gimmicks.push('mega');
      if (slot.canMegaEvoX) gimmicks.push('megax');
      if (slot.canMegaEvoY) gimmicks.push('megay');
      if (slot.canUltraBurst) gimmicks.push('ultra');
      if (slot.canTerastallize) gimmicks.push('terastallize');
      for (const g of gimmicks) {
        for (const t of moveTargets(mv.target, slotIdx, numActive)) {
          out.push({choice: `move ${idx}${t ? ` ${t}` : ''} ${g}`, usesGimmick: true});
          moveCount++;
        }
      }
    }

    const zSlot = slot.canZMove?.[i];
    if (zSlot) {
      for (const t of moveTargets(zSlot.target ?? mv.target, slotIdx, numActive)) {
        out.push({choice: `move ${idx}${t ? ` ${t}` : ''} zmove`, usesGimmick: true});
        moveCount++;
      }
    }

    const maxSlot = slot.canDynamax ? slot.maxMoves?.maxMoves[i] : undefined;
    if (maxSlot && !maxSlot.disabled) {
      for (const t of moveTargets(maxSlot.target ?? mv.target, slotIdx, numActive)) {
        out.push({choice: `move ${idx}${t ? ` ${t}` : ''} dynamax`, usesGimmick: true});
        moveCount++;
      }
    }
  }

  if (moveCount === 0) out.push({choice: 'move 1', usesGimmick: false});

  if (!slot.trapped) {
    for (const b of bench) {
      out.push({choice: `switch ${b}`, switchSlot: b, usesGimmick: false});
    }
  }
  return out;
}

export function emptyPolicy(req: BattleRequest): Record<string, number> | undefined {
  if (!req || req.wait || (!req.teamPreview && !req.forceSwitch && !req.active)) {
    return undefined;
  }

  const party = req.side.pokemon ?? [];
  const n = party.length;
  const keys: string[] = [];

  if (req.teamPreview) {
    const pick = req.maxChosenTeamSize === undefined ? 1 : Math.min(req.maxChosenTeamSize, n);
    if (pick <= 1) {
      for (let i = 1; i <= n; i++) keys.push(`team ${i}`);
    } else {
      const chooseBench = (leads: number[], start: number, bench: number[], need: number) => {
        if (bench.length === need) {
          keys.push(`team ${leads.join('')}${bench.join('')}`);
          return;
        }
        for (let s = start; s <= n; s++) {
          if (leads.includes(s)) continue;
          bench.push(s);
          chooseBench(leads, s + 1, bench, need);
          bench.pop();
        }
      };
      for (let l1 = 1; l1 <= n; l1++) {
        for (let l2 = 1; l2 <= n; l2++) {
          if (l1 !== l2) chooseBench([l1, l2], 1, [], pick - 2);
        }
      }
    }
  } else if (req.forceSwitch) {
    const slots = req.forceSwitch.length;
    const reviving = party.some((p, i) => i < slots && Boolean(p.reviving));
    const bench: number[] = [];
    for (let i = reviving ? 0 : slots; i < n; i++) {
      if (reviving ? isFainted(party[i]) : !isFainted(party[i]) && !party[i].active) {
        bench.push(i + 1);
      }
    }
    if (slots === 1) {
      if (bench.length > 0) for (const s of bench) keys.push(`switch ${s}`);
      else keys.push('pass');
    } else {
      const [f0, f1] = req.forceSwitch;
      if (f0 && !f1) {
        if (bench.length > 0) for (const s of bench) keys.push(`switch ${s}, pass`);
        else keys.push('pass, pass');
      } else if (!f0 && f1) {
        if (bench.length > 0) for (const s of bench) keys.push(`pass, switch ${s}`);
        else keys.push('pass, pass');
      } else if (f0 && f1) {
        if (bench.length >= 2) {
          for (const a of bench) {
            for (const b of bench) {
              if (a !== b) keys.push(`switch ${a}, switch ${b}`);
            }
          }
        } else if (bench.length === 1) {
          keys.push(`switch ${bench[0]}, pass`, `pass, switch ${bench[0]}`);
        } else {
          keys.push('pass, pass');
        }
      } else {
        keys.push('pass, pass');
      }
    }
  } else if (req.active) {
    const numActive = req.active.length;
    const bench: number[] = [];
    for (let i = numActive; i < n; i++) {
      if (!isFainted(party[i]) && !party[i].active) bench.push(i + 1);
    }
    if (numActive === 1) {
      for (const o of activeSlotChoices(req, 0, 1, bench)) keys.push(o.choice);
    } else {
      const left = activeSlotChoices(req, 0, 2, bench);
      const right = activeSlotChoices(req, 1, 2, bench);
      for (const l of left) {
        for (const r of right) {
          if (l.switchSlot !== undefined && l.switchSlot === r.switchSlot) continue;
          if (l.usesGimmick && r.usesGimmick) continue;
          keys.push(`${l.choice}, ${r.choice}`);
        }
      }
    }
  }

  const policy: Record<string, number> = {};
  for (const k of keys) policy[k] = 0;
  return policy;
}
```

### Usage Example

```ts
const policy = emptyPolicy(request);
if (policy) {
  const choices = Object.keys(policy);
  // Assign your agent's probability distribution in [0, 1] summing to 1.0:
  const chosen = choices[0];
  policy[chosen] = 1;
  process.stdout.write(`${JSON.stringify(policy)}\n${chosen}\n`);
}
```
