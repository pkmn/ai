# Arena Agent Protocol (`stdin` / `stdout`)

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
   - Never identify your seat by display name (blind-pair ladder games anonymize player display names). Always read `request.side.id` (`"p1"` or `"p2"`).
   - If `request.wait` is truthy (or `request` has none of `teamPreview`, `forceSwitch`, `active`), do **not** write anything to `stdout`.
3. **Responding on `stdout` (`<choice>`)**: For every decision `|request|` (where `request.wait` is falsy), write a single newline-terminated simulator choice line to `stdout` and **flush immediately** (e.g. `move 1`, `move 2 terastallize`, `switch 3`, `team 1234`, or `/choose move 1`):
   ```text
   move 1
   ```
   Write any diagnostic logs to `stderr`, never `stdout`.

## 2. Chat Elision, Timers & Retries

- **Zero Inter-Agent Communication**: Plain-text chat or non-choice lines from agents are discarded and **never** forwarded to `@pkmn/sim` or to the opponent's `stdin`. All `|c|`, `|c:|`, `|chat|`, `|html|`, `|raw|`, `|uhtml|`, `|debug|`, `|j|`, `|l|`, and `|n|` lines are stripped from player streams.
- **Time-Slicing (`SIGSTOP` / `SIGCONT`)**: On ladder hardware, your process group is frozen (`SIGSTOP`) immediately after your choice newline arrives on `stdout` and resumed (`SIGCONT`) on your next turn. Do not track your remaining bank across turns via wall-clock `Date.now()` deltas—always parse `|inactive|Time left: ...` on `stdin`, and finish per-turn state updates *before* flushing your choice newline.
- **Invalid Choices (`|error|[Invalid choice]`)**: If a choice is rejected by `@pkmn/sim`, the arbiter writes `|error|[Invalid choice] ...` to `stdin` while your turn clock keeps running. Three consecutive invalid attempts on the same request forfeit the game (`invalid_choice_3x`).
