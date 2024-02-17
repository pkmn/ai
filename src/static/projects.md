# Notes

## Technical Machine

TODO

## Shanai

- notable for the conmeta
- leverages PO for data directly, not just a client
- ostensibly supports Generation 1-5
- beginnings of [reverse damage
  calc](https://github.com/nixeagle/shanai/blob/20f11841/Pokemon/formulas.lisp) with [min/max
  ranges](https://github.com/nixeagle/shanai/blob/20f11841/Pokemon/pokemon.lisp#L139)
- [`handle-battle-choice`](https://github.com/nixeagle/shanai/blob/20f11841/PO/Client/client.lisp#L370)
  - [`compute-move-scores-by-position`](https://github.com/nixeagle/shanai/blob/20f11841/PO/Client/client.lisp#L258)
  - [`compute-next-pokemon-switch-scores-by-position`](https://github.com/nixeagle/shanai/blob/20f11841/PO/Client/client.lisp#L272)

## `vasumv/pokemon_ai`

- Generation 6 OU with [predefined teams](https://github.com/vasumv/pokemon_ai/tree/0adbf47d/teams)
- core algorithm is pessimistic sequentialized
  minimax](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/showdownai/agent.py) of [depth
  2](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/showdownai/game.py#L25) with [hand crafted
  eval](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/showdownai/gamestate.py#L46)
  - pessimistic (opponent sees move) vs. optimistic (see opponent's move)
- scriptable headless browser, PhantomJS instead of WebSocket
  - [connects](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/showdown_ai/browser.py), [parsing
    the human-readable formatted
    logs](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/showdownai/log.py), needs to [patch
    game state](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/showdownai/showdown.py#L149)
- custom engine for [simulating
  actions](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/showdownai/simulator.py#L228)
  - simplified [move
    handlers](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/showdownai/handlers.py)
  - basic [damage calc](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/showdownai/moves.py#L63)
- [scrapes](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/smogon/smogon.py) Smogon [set
  data](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/data/poke3.json), falling back to
  Generation 5 data if missing
- defaults to Smogon set data but overwrites moves with predicted moves
- gets replays for [all names on top of
  ladder](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/log_scraper/log_scraper.py) and puts
  them in [replay
  database](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/log_scraper/database.py)
- uses [`P(Move | Move)`](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/data/graph_move.json)
  and [`P(Move | Species &
  Move)`](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/data/graph_poke3.json) correlations to
  [predict](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/showdownai/move_predict.py) via
  Bayes' rule
    - alternatively uses uniform distribution of moves
      [scraped](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/smogon/smogon_moves.py) from
      [learnset](https://github.com/vasumv/pokemon_ai/blob/0adbf47d/data/poke_moves.json)

## Percymon

- Generation 6 Random Battle
- pure [depth 2](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/bots/minimaxbot.js#L286)
  pessimistic [minimax](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/bots/minimaxbot.js)
  with alpha-beta pruning and [move
  ordering](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/bots/minimaxbot.js#L339-343)
  with a [hand crafted
  eval](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/bots/minimaxbot.js#L263) function
  based on an early verison of [Technical Machine](/projects/#TechnicalMachine)'s
  [features](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/bots/minimaxbot.js#20-L57) and
  [weights](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/weights.js)
  - simplifies action space by [always mega
    evolving](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/battleroom.js#L749) when
    available
  - [move order
    heuristics](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/bots/greedybot.js) include
    eg. prefer super effective or status before not very effective
  - [hardcoded special cases for certain
    moves](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/bots/minimaxbot.js#L352-366)
- unable to use expectiminimax due to being built around an unmodified copy of Pokémon Showdown
- chose to simplify the question of imperfect information by [assuming an opponent has all possible
  moves](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/battleroom.js#L129) from their
  [random move pool](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/formats-data.js) until
  [all of their moves have been
  revealed](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/battleroom.js#L185-L204) and
  that an [opponent's unrevealed Pokémon do not
  exist](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/battleroom.js#L125) (as opposed to
  leveraging usage stats)
    - due to increased move action space the search [only looks at the top
      10](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/bots/minimaxbot.js#438) opponent
      choices (forward pruning via beam search)
- [cloning](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/clone.js) Pokémon Showdown
  state was a limiting factor on depth, as even with pruning turns could frequently take in access
  of 40s
- planned to use
  [TD-learning](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/bots/minimaxbot.js#60-L136)
  for the evaluation function weights and considered supporting non-random formats by adding in a
  usage statistics-backed Bayesian network for team prediction and a CSP solver to build robust
  teams

## `dramamine/leftovers-again`

- framework optimized for ease of use for beginners
- RandomPlayer
  [randumb](https://github.com/dramamine/leftovers-again/blob/ddcbdbaa/src/bots/randumb/index.js)
  and MaxDamagePlayer
  [stabby](https://github.com/dramamine/leftovers-again/blob/ddcbdbaa/src/bots/stabby/stabby.js)
- Generation 7 (random or not)
- replay [scraping from
  index](https://github.com/dramamine/leftovers-again/blob/ddcbdbaa/scripts/replay-saver.js) and
  [processing](https://github.com/dramamine/leftovers-again/blob/ddcbdbaa/scripts/replay-processor.mongo.js)
  into bigrams `P(Move | Species & Move)`
- contains [fork](https://github.com/dramamine/leftovers-again/blob/ddcbdbaa/src/game) of
  `smogon/damage-calc`
- supports [RR
  tournament](https://github.com/dramamine/leftovers-again/blob/ddcbdbaa/scripts/roundrobin.js)
- bundles various [sample bots](https://github.com/dramamine/leftovers-again/blob/ddcbdbaa/src/bots)

## Bill's PC

- high-quality code, extensive test coverage, contemporary techniques, mostly overlooked
- initial version in Python targeting Gen 6 random battle eventual planned C++ rewrite and Gen 7
  support
- [random battle statistic
  miner](https://github.com/sobolews/BillsPC/blob/d1e2fd8c/showdowndata/miner.py): produced
  equivalent to regular usage stats but from [teams
  generated](https://github.com/sobolews/BillsPC/blob/d1e2fd8c/showdowndata/js/getNRandomTeams.js)
  for random battles, offering more info than pkmn/smogon and 5+ years prior
- planned algorithm: SM-MCTS for stacked matrix games ([Tak
   2014](/research/#Tak:2014)) and/or LP solutions for Nash equilibria
   with learned valuation functions
- [custom
   engine](/battle/battleengine.py),
   clean implementation, does implement random for accuracy, damage roll
- [RandomPlayer](https://github.com/sobolews/BillsPC/blob/d1e2fd8c/AI/randomagent.py)
  baseline
- determines known and possible moves, [computes damage
  ranges](https://github.com/sobolews/BillsPC/blob/d1e2fd8c/bot/battlecalculator.py)
  (also [assumes average damage, no
  crits](https://github.com/sobolews/BillsPC/blob/d1e2fd8c/AI/matrixtree.py#L54-L60))
  - reuses engine as damage calculator
- [client
  representation](https://github.com/sobolews/BillsPC/blob/d1e2fd8c/bot/battleclient.py)
  with distinct [opponent
  representation](https://github.com/sobolews/BillsPC/blob/d1e2fd8c/bot/foeside.py)
  - [`deduce_hiddenpower`](https://github.com/sobolews/BillsPC/blob/d1e2fd8c/bot/battleclient.py#L226)
  - [`fill_in_unrevealed_attrs`](https://github.com/sobolews/BillsPC/blob/d1e2fd8c/AI/rollout.py#L53)
    uses maxes, doesn't sample
  - [`get_balancing_pokemon`](https://github.com/sobolews/BillsPC/blob/d1e2fd8c/AI/rollout.py#L191)
    tries to ensure balanced type distribution among team

## Deep Red

- perfect information, also handles in-game items
- limited nondeterminism
- some more advanced techniques
  - [damage
    calculator](https://github.com/TwitchPlaysPokemon/deepred/blob/350fe081/oldai/AI.py#L283)
    computes *expected* damage
  - [rules based](https://github.com/TwitchPlaysPokemon/deepred/blob/350fe081/oldai/AI.py#L678)
  - "[combos](https://github.com/TwitchPlaysPokemon/deepred/blob/350fe081/oldai/AI.py#L1201)" with
    [limited lookahead](https://github.com/TwitchPlaysPokemon/deepred/blob/350fe081/oldai/AI.py#L34)
  - [killer-move
    heuristic](https://github.com/TwitchPlaysPokemon/deepred/blob/350fe081/oldai/AI.py#L1921) and
    [changes behavior when low
    HP](https://github.com/TwitchPlaysPokemon/deepred/blob/350fe081/oldai/AI.py#L1733)

## `Synedh/showdown-battle-bot`

TODO

## Showdown AI competition

TODO

## PokéAI

TODO

## CynthiAI

TODO

## PokeML

TODO
