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
- core algorithm is [pessmistic sequentialized
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
