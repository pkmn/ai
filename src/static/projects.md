# Notes

## shanai

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