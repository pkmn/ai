# Notes

## Technical Machine

- supports Generation 1-9 non-random formats
- [fixed teams](https://github.com/davidstone/technical-machine/tree/e0315af7/teams), though can
  also [generate
  teams](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/clients/get_team_impl.cpp#L32)
  using its team prediction algorithm
- supports [parsing
  teams](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/clients/load_team_from_file.cpp)
  from a past suported simulators [Pokémon
  Online](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/clients/pokemon_online/read_team_file.cpp),
  [Pokémon
  Lab](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/clients/pokemon_lab/read_team_file_impl.cppb),
  [Shoddy
  Battle](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/clients/shoddy_battle/read_team_file_impl.cpp),
  and [Pokémon
  NetBattle](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/clients/netbattle/read_team_file.cpp)
- [damage
  calculator](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/move/calculate_damage.cpp)
- [parses](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/clients/pokemon_showdown/battle_manager.cpp)
  [Pokémon
  Showdown](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/clients/pokemon_showdown/battle_message_handler_impl.cpp)
  messages, [handling
  events](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/clients/pokemon_showdown/event_block.cpp)
  and producinga [client battle
  representation](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/clients/make_client_battle_impl.cpp)
- differentiates [known vs. seen
  Pokémon](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/pokemon/seen_pokemon.cpp)
- reverse stats
  - [stat to
    ev](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/stat/stat_to_ev.cpp)
  - [reverse ivs and evs from
    stat](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/stat/calculate_ivs_and_evs.cpp)
    - [possible dvs/ivs based on hidden
      power](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/stat/possible_dvs_or_ivs.cpp)
- [team
  predictor](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/team_predictor/team_predictor_impl.cpp)
  - uses [usage
    stat](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/team_predictor/usage_stats.cpp)
  - can do [random or most
    likely](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/team_predictor/estimate.cpp)
  - [optimizes
    spreads](https://github.com/davidstone/technical-machine/tree/e0315af7/source/tm/team_predictor/ev_optimizer)
- [custom usage
  stats](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/ps_usage_stats/usage_stats.cpp)
  - [binary
    format](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/ps_usage_stats/serialize.cpp)
  - derivative [speed
    distribution](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/ps_usage_stats/usage_stats.cpp#L115)
  - ["correlations"](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/ps_usage_stats/usage_stats.cpp#L200)
- [make
  decision](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/clients/determine_selection.cpp)
  - base on [most likely opponent's
    team](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/clients/determine_selection.cpp#L89)
    (single determinization)
- [expectimimax](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/evaluate/expectiminimax.cpp)
- [evaluation](https://github.com/davidstone/technical-machine/tree/e0315af7/source/tm/evaluate)
  - [predict
    selection](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/evaluate/predict_selection_impl.cpp)
  - [transposition
    table](https:`//github.com/davidstone/technical-machine/blob/e0315af7/source/tm/evaluate/transposition.cpp)
- [general vs. single
  depth](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/evaluate/depth.cpp)
  - default [depth (2,
    0)](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/ai/parse_args.cpp#L16)
- [HCE](https://github.com/davidstone/technical-machine/blob/e0315af7/source/tm/evaluate/evaluate.cpp)
  is weighted linear combination with [per-generation
  weighted](https://github.com/davidstone/technical-machine/tree/e0315af7/settings) considering HP,
  hidden pokemon, and hazards

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
- gets replays for [all names on top of the
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
  pessimistic sequentialized
  [minimax](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/bots/minimaxbot.js) with
  alpha-beta pruning and [move
  ordering](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/bots/minimaxbot.js#L339-343)
  with a [hand-crafted
  eval](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/bots/minimaxbot.js#L263) function
  based on an early version of [Technical Machine](/projects/#TechnicalMachine)'s
  [features](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/bots/minimaxbot.js#20-L57) and
  [weights](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/weights.js)
  - simplifies action space by [always mega
    evolving](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/battleroom.js#L749) when
    available as a form of forward pruning
  - [move order
    heuristics](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/bots/greedybot.js) include
    eg. prefer super effective or status before not very effective
  - [hardcoded special cases for certain
    moves](https://github.com/rameshvarun/showdownbot/blob/00dcfcca/bots/minimaxbot.js#L352-366)
- unable to use expectiminimax due to being built around an unmodified copy of Pokémon Showdown
- mostly deterministic but simulations (`getDamage` etc) aren't fixed so can still exist
  non-determinism
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
  state was a limiting factor on depth, as even with pruning turns could frequently take in excess
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
- planned algorithm: SM-MCTS for stacked matrix games ([Tak 2014](/research/#Tak:2014)) and/or LP
   solutions for Nash equilibria with learned valuation functions
- [custom engine](/battle/battleengine.py), clean implementation, does implement random for
   accuracy, damage roll
- [RandomPlayer](https://github.com/sobolews/BillsPC/blob/d1e2fd8c/AI/randomagent.py) baseline
- determines known and possible moves, [computes damage
  ranges](https://github.com/sobolews/BillsPC/blob/d1e2fd8c/bot/battlecalculator.py) (also [assumes
  average damage, no
  crits](https://github.com/sobolews/BillsPC/blob/d1e2fd8c/AI/matrixtree.py#L54-L60))
  - reuses engine as damage calculator
- [client representation](https://github.com/sobolews/BillsPC/blob/d1e2fd8c/bot/battleclient.py)
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
  - [rules-based](https://github.com/TwitchPlaysPokemon/deepred/blob/350fe081/oldai/AI.py#L678)
  - "[combos](https://github.com/TwitchPlaysPokemon/deepred/blob/350fe081/oldai/AI.py#L1201)" with
    [limited look-ahead](https://github.com/TwitchPlaysPokemon/deepred/blob/350fe081/oldai/AI.py#L34)
  - [killer-move
    heuristic](https://github.com/TwitchPlaysPokemon/deepred/blob/350fe081/oldai/AI.py#L1921) and
    [changes behavior when low
    HP](https://github.com/TwitchPlaysPokemon/deepred/blob/350fe081/oldai/AI.py#L1733)

## `Synedh/showdown-battle-bot`

- [rule-based agent](https://github.com/Synedh/showdown-battle-bot/blob/52db93cb/src/ai.py) for
  [Generation 6-8 random
  formats](https://github.com/Synedh/showdown-battle-bot/blob/52db93cb/src/io_process.py#L18-L23)
- limited state tracking, augments Pokémon Showdown's [request
  JSON](https://github.com/Synedh/showdown-battle-bot/blob/52db93cb/src/battle.py#L40) with [simple
  battle log
  parsing](https://github.com/Synedh/showdown-battle-bot/blob/52db93cb/src/battlelog_parsing.py#L26)
- evaluation scores actions in terms of speed and [expected
  damage](https://github.com/Synedh/showdown-battle-bot/blob/52db93cb/src/move_efficiency.py#L204-L216)
  computed by a [basic damage
  calculator](https://github.com/Synedh/showdown-battle-bot/blob/52db93cb/src/move_efficiency.py#L136),
  special handling for [boosting
  moves](https://github.com/Synedh/showdown-battle-bot/blob/52db93cb/src/move_efficiency.py#L157-L173)
  and moves which inflict
  [status](https://github.com/Synedh/showdown-battle-bot/blob/52db93cb/src/move_efficiency.py#L175-L201)
- prefers attacking but [will
  switch](https://github.com/Synedh/showdown-battle-bot/blob/52db93cbd4aaca3bbc9f13399268b76785f23e5c/src/ai.py#L128-L133)
  if no sufficiently good options for moves

## Showdown AI Competition

- [variant of Generation 6 Random Battle with Ubers and Pokémon below NU
  banned](https://github.com/scotchkorean27/showdownaiclient/blob/c6cb71a9ff8e484fb99e12670df7ffe2af2f3b04/zarel/data/scripts.js#L2097),
  20 seconds per decision with 500 turn hard limit
- [2xBO3 matches with team swap to reduce
  variance](https://github.com/scotchkorean27/showdownaiclient/blob/c6cb71a9/OfflineGame.js#L32-L75)
- compared numerous agents
  - non-adversarial [breadth-first
    search](https://github.com/scotchkorean27/showdownaiclient/blob/c6cb71a9/agents/BFSAgent.js)
    that greedily assumes an opponent does nothing and a
    [variant](https://github.com/scotchkorean27/showdownaiclient/blob/c6cb71a9/agents/PBFS.js) that
    prunes evaluating moves that are resisted / switches into poor type matchups and assumes the
    opponent is a one-turn look-ahead agent instead
  - [pure pessimistic
    minimax](https://github.com/scotchkorean27/showdownaiclient/blob/c6cb71a9/agents/MinimaxAgent.js)
    with an [evaluation
    function](https://github.com/scotchkorean27/showdownaiclient/blob/c6cb71a9/agents/MinimaxAgent.js#L30-L34)
    that favors dealing damage while rewarding survival and a depth penalty to promote exploration
    and limit depth
  - both
    [single-layer](https://github.com/scotchkorean27/showdownaiclient/blob/c6cb71a9/agents/QLearner.js)
    and
    [multi-layer](https://github.com/scotchkorean27/showdownaiclient/blob/c6cb71a9/agents/MLQLearner.js)
    Q-learning networks
  - [one-turn
    look-ahead](https://github.com/scotchkorean27/showdownaiclient/blob/c6cb71a9/agents/OTLAgent.js)
    that computes [estimated
    damage](https://github.com/scotchkorean27/showdownaiclient/blob/c6cb71a9/agents/OTLAgent.js#L27)
    and uses the max-damaging move or switches to the Pokémon that has the max-damaging move and a
    [variant](https://github.com/scotchkorean27/showdownaiclient/blob/c6cb71a9/agents/TypeSelector.js)
    that includes a [killer move
    heuristic](https://github.com/scotchkorean27/showdownaiclient/blob/c6cb71a9/agents/TypeSelector.js#L42)
    as well as additional rules and heuristics around type matchups and switching
- every agent beat $`RandomPlayer(switch=\widetilde{0\%})`, OTL ended up with best results and
  minimax and pruned BFS also significantly outperformed alternatives
- cites high simulation cost of Pokémon Showdown as problematic

## CynthiAI

- Generation 7 Random Battle
- [depth 1](https://github.com/Sisyphus25/CynthiAI/blob/37dd2e41/CynthiAgent.js#L769) [pure
  optimistic minimax](https://github.com/Sisyphus25/CynthiAI/blob/37dd2e41/CynthiAgent.js#L577-L742)
  search with [hand-crafted
  eval](https://github.com/Sisyphus25/CynthiAI/blob/37dd2e41/CynthiAgent.js#L187-575)
- checks [known moves](https://github.com/Sisyphus25/CynthiAI/blob/37dd2e41/CynthiAgent.js#L123) if
  enough are known otherwise entire move pool
- [deterministically uses the highest accuracy move that
  KOs](https://github.com/Sisyphus25/CynthiAI/blob/37dd2e41/CynthiAgent.js#L163-L182) (killer move
  heuristic) otherwise most damaging move (ignoring accuracy)
- [hardcoded
  modifiers](https://github.com/Sisyphus25/CynthiAI/blob/37dd2e41/CynthiAgent.js#L777-L794) to the
  minimax result to better account for game mechanics

## SutadasutoIA

- Generation 6 BSS, simplified state space by eliminating status moves, EVs, and items
- not a general-purpose AI, intended for repeated battles against the same opponent akin to [Battle
  Maison](https://bulbapedia.bulbagarden.net/wiki/Battle_Maison) and uses a [hill-climbing
  algorithm](https://github.com/Sutadasuto/SutadasutoIA/blob/b8a5dfd2/battleControl.py#L298) to
  optimize team selection from a [pool of
  Pokémon](https://github.com/Sutadasuto/SutadasutoIA/blob/b8a5dfd2/pool.txt) between battles
- like [`vasumv/pokemon_ai`](#vasumv/pokemon_ai) uses a
  [webdriver](https://github.com/Sutadasuto/SutadasutoIA/blob/b8a5dfd2/webControl.py)
  ([Selenium](https://www.selenium.dev/)) as opposed to communicating directly via the
  [WebSocket](https://en.wikipedia.org/wiki/WebSocket) API
- [hand-crafted
  evaluation](https://github.com/Sutadasuto/SutadasutoIA/blob/b8a5dfd2/battleControl.py#L4-L295)
  function uses a combination of rules and [a scoring
  system](https://github.com/Sutadasuto/SutadasutoIA/blob/b8a5dfd2/battleControl.py#L209-L254) to
  determine actions
  - focuses on classifying Pokémon by their role ("Special Sweeper") and choosing suitable courses of
    action based on this

## _Rill-García_

- Generation 6 BSS, same simplified format supported by [SutadasutoIA](#SutadasutoIA) which was the
  baseline agent used for comparison
- computed own usage stats from 500 high-ranked replays
- learning initially supervised based on replays then via a Q-learning approach with self-play and a
  threshold-greedy policy
- rewarded actions based on whether they resulted in an OHKO, KO, the percentage damage they caused
  their opponent or whether their opponent was unable to act
- experimental setup was matches of 10 battles with the same team where learning and adapting teams
  between games is possible
- online learning model did well with a single team but was worse when playing with different teams

## `DanielAlcocerSoto/Pokemon-Python`

- [custom engine](https://github.com/DanielAlcocerSoto/Pokemon-Python/tree/aa9defc6/Game/engine) and
  accompanying [`pygame`](www.pygame.org)-based
  [UI](https://github.com/DanielAlcocerSoto/Pokemon-Python/tree/aa9defc6/Game/display) supporting
  Generation 4 Double Battles
  - engine is simplified, lacking support for switching, effects, or move accuracy
- [RL model](https://github.com/DanielAlcocerSoto/Pokemon-Python/blob/aa9defc6/Agent/model.py) built
  with Keras and Tensorflow
- Q-learning to train a small neural network on a fairly [minimal
  embedding](https://github.com/DanielAlcocerSoto/Pokemon-Python/blob/aa9defc6/Agent/encoder.py#L48)
  - architecture supports an MLP [layers of 24, 24, 8 with ReLU activation between layers and linear
    output](https://github.com/DanielAlcocerSoto/Pokemon-Python/blob/aa9defc6/Configuration/RL_config.json#L6)
  - trains against a [random
    agent](https://github.com/DanielAlcocerSoto/Pokemon-Python/blob/aa9defc6/run.py#L110-L113)
    following [ε-greedy
    policy](https://github.com/DanielAlcocerSoto/Pokemon-Python/blob/aa9defc6/Agent/agent_to_train.py#L41)
    using
    [mini-batch](https://github.com/DanielAlcocerSoto/Pokemon-Python/blob/aa9defc6/Agent/model.py#L114-L134)
    gradient descent
  - [reward
    function](https://github.com/DanielAlcocerSoto/Pokemon-Python/blob/aa9defc6/Agent/model.py#L80)
    favors maximum damage

## PokeML

- several Generation 7 example agents
- [can simulate
  battles](https://github.com/pokeml/pokemon-agents/blob/318b7d3d/src/core/team-aware-simulation-agent.js#L42)
  via Pokémon Showdown
- client representation tracks state using an [extraction from the Pokémon Showdown
  client](https://github.com/pokeml/pokemon-agents/blob/318b7d3d/src/tracking)
- agents:
  - [`RandomAgent`](https://github.com/pokeml/pokemon-agents/blob/318b7d3d/src/agents/random-agent.js)
   and
   [`SemiRandomAgent`](https://github.com/pokeml/pokemon-agents/blob/318b7d3d/src/agents/random-agent.js)
   ($`RandomPlayer(switch=\widetilde{0\%}, mega=100\%)`)
  - [`MaxDamageAgent`](https://github.com/pokeml/pokemon-agents/blob/318b7d3d/src/agents/max-damage-agent.js)
   and
   [`MaxBasePowerAgent`](https://github.com/pokeml/pokemon-agents/blob/318b7d3d/src/agents/max-base-power-agent.js)
  - [`SimAgent`](https://github.com/pokeml/pokemon-agents/blob/318b7d3d/src/agents/sim-agent.js)
    relying on OTL
    - [`lrsnash` to solve the computed payoff
      matrix](https://github.com/pokeml/pokemon-agents/blob/318b7d3d/src/agents/sim-agent.js#L91)
    - [weighted random sample from
      policy](https://github.com/pokeml/pokemon-agents/blob/318b7d3d/src/agents/sim-agent.js#L129)
    - [eval function is purely the sum of % HP of Pokémon on each
      side](https://github.com/pokeml/pokemon-agents/blob/318b7d3d/src/agents/sim-agent.js#L311-L336)
  - [`ChecksSwitchAgent`](https://github.com/pokeml/pokemon-agents/blob/318b7d3d/src/agents/checksswitch-agent.js)
    chooses actions based on hard-coded [checks and counters
    table](https://github.com/pokeml/pokemon-agents/blob/318b7d3d/data/compTest.json) and the
    typechart
  - [`TestAgent`](https://github.com/pokeml/pokemon-agents/blob/318b7d3d/src/agents/test-agent.js)
    WIP agent for machine learning based on the features
    - [conmeta](https://github.com/pokeml/pokemon-agents/blob/318b7d3d/src/agents/test-agent.js#L11-L37)
      reduced feature space
    - [converts](https://github.com/pokeml/pokemon-agents/blob/318b7d3d/src/core/encoder.js) game
      states to fixed-size numeric vectors.

## `kvchen/showdown-rl`

- agent using proximal policy optimization (PPO) which was expected to be superior to Q-learning for
  scenarios with complex value functions like Pokémon because it operates directly in the policy
  space
- trained on Generation 1 Random Battle format, though the approach generalizes to arbitrary formats
- uses Tensorflow, the [PPO implementation from
  OpenAI](https://github.com/kvchen/showdown-rl/blob/8cb4fd90/ppo/ppo.py) and a custom [OpenAI
  Gym](https://github.com/openai/gym) environment
  [implementation](https://github.com/kvchen/gym-showdown/blob/c5cdcf84/gym_showdown/envs/showdown_env.py)
  that works with a modified Pokémon Showdown server
- server is relaxed to provide additional information about
  [features](https://github.com/kvchen/showdown-rl-server/blob/f31875ee/src/battle/getFeatures.js)
  and to [determine valid
  actions](https://github.com/kvchen/showdown-rl-server/blob/f31875ee/src/battle/getValidActions.js#L19)
  ahead of time which are used to mask off the output from the RL network to force the logits of
  invalid actions to negative infinity before applying the softmax
- the paper discusses using the `node2vec` algorithm to [create embeddings for various
  species](https://github.com/kvchen/showdown-rl-notebooks/blob/85c266d4/embeddings/Pokemon%20Embeddings%20Using%20Node2Vec.ipynb),
  though ultimately it seems that a basic one-hot encoding for each Pokémon's attributes was
  [actually
  used](https://github.com/kvchen/gym-showdown/blob/c5cdcf84/gym_showdown/envs/showdown_env.py#LL141-L179)
- network architecture is 3 fully-connected layers each with 512 units and a ReLU activation and
  only terminal states were rewarded
- trained against $`RandomPlayer(\widetilde{100\%})`, $`RandomPlayer(0%)` and a depth 1 [minimax
  agent](https://github.com/kvchen/showdown-rl/blob/8cb4fd90/agents/minimax.py) with alpha-beta
  pruning with an evaluation function that compares the difference in the sum of HP percentages for
  the full team of each side
- agent learned a policy which preferentially chose the move in the 4th moveslot
  - resulted in a winning record compared to the random agents but almost always lost vs. minimax.
- largely bottlenecked by computational resources, in particular repeatedly
  [cloning](https://github.com/kvchen/showdown-rl-server/blob/f31875ee/src/battle/clone.js) the
  simulator state
- ideas for future work include self-play and improved visualization to enhance tuning and debugging

## `hsahovic/reinforcement-learning-pokemon-bot`

- Generation 7 Random Battle
- inspired by [`Synedh/showdown-battle-bot`](#Synedh/showdown-battle-bot`), precursor to
  [poke-env](#poke-env)
- [origin](https://github.com/hsahovic/reinforcement-learning-pokemon-bot/tree/25a04789/showdown-improvements)
  of [various patches](https://github.com/smogon/pokemon-showdown/pull/7618) to Pokémon Showdown to
  make it more suitable for RL
- Keras / Tensorflow
- [client representation](
https://github.com/hsahovic/reinforcement-learning-pokemon-bot/blob/25a04789/src/environment/battle.py)
used to produce a [description of the
state](https://github.com/hsahovic/reinforcement-learning-pokemon-bot/blob/25a04789/src/environment/battle.py#L445)
to be fed into models
- features support for
  [self-play](https://github.com/hsahovic/reinforcement-learning-pokemon-bot/blob/25a04789/src/players/base_classes/model_manager.py#L269)
  and concurrent training
- two fully-connected MLPs:
  - incomplete [larger
    model](https://github.com/hsahovic/reinforcement-learning-pokemon-bot/blob/25a04789/src/players/fully_connected_random_model.py)
    that utilizes the full feature set
  - a [functional
    model](https://github.com/hsahovic/reinforcement-learning-pokemon-bot/blob/25a04789/src/players/policy_network.py)
    that uses the Actor-Critic method with a pruned number of features
    - [reward](https://github.com/hsahovic/reinforcement-learning-pokemon-bot/blob/25a04789/src/players/policy_network.py#L238C8-L238C63)
      depends on the difference in respective total party hit points

## Showdown AI Bot

- [custom engine](https://github.com/JJonahJson/Showdown-AI-Bot/blob/3038f927/src/model) with [basic
  damage calculator](https://github.com/JJonahJson/Showdown-AI-Bot/blob/3038f927/src/model/damage_calculator.py)
- [scraped data](https://github.com/JJonahJson/Showdown-AI-Bot/tree/3038f927/src/scraper) inserted
  into [MySQL
  database](https://github.com/JJonahJson/Showdown-AI-Bot/blob/3038f927/src/protocol/data_source.py)
  - [random
    sets](https://github.com/JJonahJson/Showdown-AI-Bot/blob/3038f927/src/scraper/randomsets.json)
- [client
  representation](https://github.com/JJonahJson/Showdown-AI-Bot/blob/3038f927/src/protocol/game_control.py)
  features [request
  parsing](https://github.com/JJonahJson/Showdown-AI-Bot/blob/3038f927/src/ai/chooser.py#L199-230)
  and differentiates [possible vs. actual
  moves](https://github.com/JJonahJson/Showdown-AI-Bot/blob/3038f927/src/protocol/enemy_updater.py)
- Generation 1-7 Random Battle, three different modes:
  - [Easy](https://github.com/JJonahJson/Showdown-AI-Bot/blob/3038f927/src/ai/chooser.py#L44-L97):
    max damage for move, switches when forced considering type matchup
  - [Normal](https://github.com/JJonahJson/Showdown-AI-Bot/blob/3038f927/src/ai/chooser.py#L100-L286):
    moves decisions also have hardcoded logic for status and more nuanced game mechanics and
    [look-ahead](https://github.com/JJonahJson/Showdown-AI-Bot/blob/3038f927/src/ai/chooser.py#L199-230)
    to avoid being knocked out by an opponent, switches consider type matchup and move type matchup
  - [Hard](https://github.com/JJonahJson/Showdown-AI-Bot/blob/3038f927/src/ai/chooser.py#244-L298):
    uses Normal logic for switching but move decisions were based on a [max depth
    2](https://github.com/JJonahJson/Showdown-AI-Bot/blob/3038f927/src/ai/iterative_search.py#L82)
    [iterative deepening pure pessimistic
    minimax search](https://github.com/JJonahJson/Showdown-AI-Bot/blob/3038f927/src/ai/iterative_search.py)
    with a [complicated hand-crafted evaluation
    function](https://github.com/JJonahJson/Showdown-AI-Bot/blob/3038f927/src/ai/chooser.py#L305)

## `pmariglia/showdown`

- Generation 3-8 singles random and non-random formats.
  - partial support for Generation 9 (missing _The Indigo Disk_ DLC and Terastallization [is still
  in progress](https://github.com/pmariglia/showdown/commit/1a6dfb7d))
- [bespoke _reversible_ engine](https://github.com/pmariglia/showdown/blob/6102ea13/ENGINE.md)
  optimized for the needs of the agent, explicitly trading off perfect fidelity
  - [move](https://github.com/pmariglia/showdown/blob/6102ea13/data/moves.json) and
  [species](https://github.com/pmariglia/showdown/blob/6102ea13/data/pokedex.json) data
  [generated](https://github.com/pmariglia/showdown/blob/6102ea13/data/scripts/update_moves.py)
  [from](https://github.com/pmariglia/showdown/blob/6102ea13/data/scripts/update_pokedex.py) Pokémon
  Showdown, [modified](https://github.com/pmariglia/showdown/blob/6102ea13/data/mods/apply_mods.py)
  to then work in the custom engine and [patched for past
  generations](https://github.com/pmariglia/showdown/tree/6102ea13/data/mods)
  - mechanics reflect current generation and generational differences simply reflected in data =
    "good enough"
  - unlike almost all other engines that necessitate a Copy Make approach (used by earlier versions
    of the `pmariglia/showdown`), the engine's
    [`StateMutator`](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/engine/objects.py#L482-L749)
    allows for "applying" and "reversing" instructions that get
    [generated](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/engine/instruction_generator.py)
    by handlers
  - speed is still a concern, undergoing rewrite in Rust
  - has an [$`transitions` function that is
    reversible](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/engine/find_state_instructions.py#L471-L497)
- standard Pokémon Showdown
  [protocol](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/battle_modifier.py#L1175)
  and [team]( https://github.com/pmariglia/showdown/blob/6102ea13/teams/team_converter.py) parsing
- sophisticated client representation [makes use of log ordering to bound speed
  ranges](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/battle_modifier.py#L811), and
  attempts to deduce not just the presence but also the _absence_ of [Choice
  Scarf](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/battle_modifier.py#L902),
  [Choice Band or Choice
  Specs](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/battle_modifier.py#L978),
  [Heavy Duty
  Boots](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/battle_modifier.py#L1063),
  [Assault
  Vest](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/battle_modifier.py#L333), and
  [Life Orb](
  https://github.com/pmariglia/showdown/blob/6102ea13/showdown/battle_modifier.py#L353-L357).
    - Choice Band and Choice Specs inference also leverages [damage
      calculation](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/battle_modifier.py#L1023)
- true [$`MaxDamagePlayer`
  baseline](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/battle_bots/most_damage/main.py)
  which uses the [damage
  calculator](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/engine/damage_calculator.py)
  - damage calculator supports [different
types](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/engine/damage_calculator.py#L194-L231)
of roll abstraction
- bot mods "safest" depth-2 [simultaneous
  expectiminimax](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/engine/select_best_move.py#L98)
  with [pruning and move
  ordering](https://GitHub.com/pmariglia/showdown/blob/6102ea13/showdown/engine/select_best_move.py#L126)
  & weighted decision, experimental Nash equilibrium, team datasets, and most damage
    - [experimented with a dynamic search
      depth](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/battle_bots/helpers.py#L76)
      of 3 or 4 depending on the number of joint actions which requires
      [PyPy](https://www.pypy.org/) for performance
    - shows a weakness for closing out battles
- [nash
  equilibrium](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/battle_bots/nash_equilibrium/main.py)
  is the only non-deterministic mode and is the weakest
  - does better when [can't see opponents killing
    moves](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/engine/select_best_move.py#L13-L41)
  - uses [Gambit](http://www.gambit-project.org/) in a
    [subprocess](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/battle_bots/nash_equilibrium/main.py#L88)
- [evaluation](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/engine/evaluate.py)
  works off of [many different determinizations for unknowns of opponent's active
  Pokémon](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/battle.py#L124-L197)
  - [possible
    spreads/items/abilities/moves](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/battle.py#L596-L678
    ) for _revealed_ Pokémon only based on usage staff with cutoff plus knowledge applied (not fast
    enough to also work with possible team determinization)
  - sets produced need to ["make
    sense"](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/engine/helpers.py#L121) =
    heuristic
  - [bucketing applied to
    spreads](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/engine/helpers.py#L127)
- [usage stats
  parser](https://github.com/pmariglia/showdown/blob/6102ea13/data/parse_smogon_stats.py) which
  uniquely makes use of a notion of effectiveness [calculated from checks and
  counters](https://github.com/pmariglia/showdown/blob/6102ea13/data/parse_smogon_stats.py#L76) used
  in the evaluation function
- [hand-crafted evaluation
  function](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/engine/evaluate.py)
  features a diminishing return on boosts and does not place value on preserving hidden information
  or scouting (the agent does not consider hidden information at all)
    - future work includes explicitly identifying win conditions and giving bonuses during
      evaluation to guide towards a sweep
- uses [preconfigured teams](https://github.com/pmariglia/showdown/tree/6102ea13/teams/teams)
- [parse random
  sets](https://github.com/pmariglia/showdown/blob/6102ea13/data/scripts/parse_random_battle_raw_sets.py)
  and [computes
  statistics](https://github.com/pmariglia/showdown/blob/6102ea13/data/random_battle_sets.json)
  - random battles [slightly tweak the scoring of Pokémon that have not been
    fainted](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/run_battle.py#L169) during
    evaluation
- the [`team-datasets` version of the
  agent](https://github.com/pmariglia/showdown/blob/6102ea13/showdown/battle_bots/team_datasets/main.py)
  augments the `safest` expectiminimax agent with a team scouting
  [dataset](https://github.com/pmariglia/showdown/blob/6102ea13/data/team_datasets.json) gleaned
  from scraping Smogon University's forums. Given a comprehensive enough database, [team
  prediction](https://github.com/pmariglia/showdown/blob/6102ea13/data/team_datasets.py#L140) and
  thus overall playing performance is improved considerably.

## poke-env

- Generation 4-9 framework with
  [documentation](https://poke-env.readthedocs.io/en/stable/index.html) and
  [examples](https://github.com/hsahovic/poke-env/tree/46fa2b01/examples)
- supports both singles & doubles battles and random & non-random battles
- environment is [client
  representation](https://github.com/hsahovic/poke-env/tree/46fa2b01/src/poke_env/environment)
- doesn't embed Pokémon Showdown so can't easily perform simulations, simply a client
- [data](https://github.com/hsahovic/poke-env/tree/46fa2b01/src/poke_env/data/static)
  [extracted](https://github.com/hsahovic/poke-env/tree/46fa2b01/scripts) from Pokémon Showdown
- provides [team parsing and
  packing](https://github.com/hsahovic/poke-env/blob/46fa2b01/src/poke_env/teambuilder/teambuilder.py)
  logic
- main features are training agents
  [concurrently](https://github.com/hsahovic/poke-env/blob/46fa2b01/src/poke_env/concurrency.py) and
  [utilities for evaluating agent
  performance](https://github.com/hsahovic/poke-env/blob/46fa2b01/src/poke_env/player/utils.py) eg.
  cross evaluation
- provides example agents for training:
  [`MaxBasePowerPlayer`](https://github.com/hsahovic/poke-env/blob/46fa2b01/src/poke_env/player/baselines.py#L11),
  [`SimpleHeuristicsPlayer`](https://github.com/hsahovic/poke-env/blob/46fa2b01/src/poke_env/player/baselines.py#L19)
  crudely approximates a `MaxDamagePlayer` but no damage calculator or simulation available, working
  to [add self-play
  support](https://github.com/hsahovic/poke-env/blob/46fa2b01/examples/experimental-self-play.py)
- [Open AI Gym](https://github.com/openai/gym) [environment
  implementation](https://github.com/hsahovic/poke-env/blob/46fa2b01/src/poke_env/player/openai_api.py)
  and
  [helpers](https://github.com/hsahovic/poke-env/blob/46fa2b01/src/poke_env/player/env_player.py#L106)
  including a [reward
  helper](https://github.com/hsahovic/poke-env/blob/46fa2b01/src/poke_env/player/env_player.py#L106)

## Simplified Pokemon Environment

- incredibly restricted toy [OpenAI Gym](https://github.com/openai/gym)
  [environment](https://gitlab.com/DracoStriker/simplified-pokemon-environment/-/blob/028f4595/Environment/SimplePkmEnv.py)
  that reduces Pokémon to simply type matchups and damaging moves proposed as a
  baseline for evaluating agents
- [GIGA-WolF](https://gitlab.com/DracoStriker/simplified-pokemon-environment/-/blob/028f4595/Trainer/Deep/Learning/Distributed/DistributedDeepGIGAWoLF.py)
  and
  [DistributedDeepWPL](https://gitlab.com/DracoStriker/simplified-pokemon-environment/-/blob/028f4595/Trainer/Deep/Learning/Distributed/DistributedDeepWPL.py)
- 100% win rate against `RandomPlayer(\widetilde{100\%})`

## VGC AI Framework

TODO aab68037

## Athena

- Generation 7 Random Battle (author considers "more challenging than OU")
- Pokémon requires a different approach than Go or chess and isn't solvable with an off-the-shelf
  approach
- identifies speed statistic, ability, and move as most important Pokémon properties
- considers for ML:
  - complicated game mechanics and massive state space mean hard for NNs to infer patterns unlike in
    Chess/Go where rules are comparatively much simpler
  - every Pokémon battle is almost a unique environment = likely to have zero samples in training.
    _Important to train on past turns of ongoing battle and possibly weight these higher_
  - high variance in Pokémon means RL agent can get rewards from playing poorly - need to account
    for matchup and hax
- game tree pathology present in _all_ game trees due to hidden info/stochasiticy yet not looking
  ahead is not an option
- "keeping a balanced team" key insight = at every point players need to be sure that they have at
  least one way of beating all of an opponent's Pokémon without losing all of their own Pokémon
  - contends that MCTS and minimax cannot achieve this
- Athena agent uses distributed transposition table, 2 turn look-ahead, then attempts to determine
  which side's team is stronger by doing pairwise comparisons between the matchups using 1-2 turn
  look-ahead in the individual 1v1s and score based on the difference in HP with a bonus for not
  fainting and then combines by looking at the average (weighting scores by probability thr matchup
  would actually occur), then constructs a payoff matrix
- dominated strategies are removed iteratively using heuristic rules
- three different types of uncertainty: simultaneity, hidden information, stochasticity
- ML used to predict opponents policy based on current payoff matrix and full history of opponent
  moves and payoff matrices
  - while best move doesnt actually depend on history, history is a workaround for imperfect info -
    implicitly demonstrates opponents decision making with respect to what they know and what they
    think about the player
- fills in most probable values for revealed Pokémon from usage statistics otherwise uses the [IBM®
  ILOG® CPLEX®
  Optimizer](https://www.ibm.com/products/ilog-cplex-optimization-studio/cplex-optimizer) to solve a
  mixed integer linear programming problem that figure out which Pokémon will best approximate the
  possibilities
    - relies on precomputed Species vs. Species 2-turn matchup matrix, similar to the evaluation
      function
- doesn't use determinization due too too many states and doesn't use Monte Carlo sampling due to
  performance so instead overrides the RNG for the first turn of look-ahead to only a single number
  per side from a reduced random and to alwaus return an average value for further turns of
  look-ahead
- proposes an approach to teambuilding via self-play and a genetic algorithm

## `blue-sky-sea/Pokemon-MCTS-AI-Master`

- [UCT](https://github.com/blue-sky-sea/Pokemon-MCTS-AI-Master/blob/4fb425e1/AI/mcts.py) for Gen 4
  Singles
  ([adapted](https://github.com/blue-sky-sea/Pokemon-MCTS-AI-Master/blob/4fb425e1/Game/engine/single_battle.py)
  from Pokemon-Python)

## Pokemon Battle Predictor

- model-free (supervised learning), impressive accuracy
- [Pokemon Battle Predictor](https://www.smogon.com/forums/threads/3666009/) browser extension
  trained on 10,000 battles (10 days of `gen8ou` replay data 1250 Elo or greater) predicting value
  - 4 prediction models: win%, opponent switch%, opponent move policy, opponent switch policy
    (learned separately as opposed to one policy)
    - switch policy applies mask to account for Pokémon that cant be switched to
- runs at the start of every turn
- extension can leverage Pokémon Showdown's client representation
- [neural networks](https://www.smogon.com/forums/posts/8578872)
- input feature vector is 6815 features derived from the battle state as well as a "switch
  coefficient" tracking "How often one Pokemon switches out when then the opposing Pokemon is also
  in"
  - notably doesn't track item, ability, type = those can be treated as innate to a specific Pokémon
    in the metagame
- chance of move/switch trained on an equal number of samples of both outcomes
  -  switch % requires another model that outputs the list of all Pokémon where the Pokémon that
    switched in, then passed through another layer that can learn similar Pokémon that can fulfill
    the same role
  -  move learning is just about learning the chance of moves occuring at any point and applying a
    mask for each Pokémon derived from moveset usage statistics to determine which are actually
    possible
- winning chance also trained on an even sample though only for turns more than 20% of the way
  through the battle
- [updated](https://www.smogon.com/forums/threads/posts/8577932) to support most other non-random
  formats after receiving a data grant
- [second large update](https://www.smogon.com/forums/posts/8776635)
  - overhaul to the models which made them much larger, moved to cloud housing and anonymizing the
    battles using `pkmn/anon` and sending them to the server
  - tuned with replay data automatically every two weeks
-  "Those battles are then split into groups to represent different segments of player ratings as to
  accommodate for players of different skill levels playing differently." = considers player skill
  level

## Future Sight

TODO

- uses [Puppeteer](https://github.com/puppeteer/puppeteer) to leverage Pokémon Showdown's client
  representation
- double battles were not possible to support efficiently necessitating the creation of the
  [PokeSim](https://github.com/aed3/poke-sim) engine
- models' accuracy plateau after ~10,000 battles in the training set
- AI depends on having a notion of the player's skill and changes behavior based on whether battling
  someone perceived to be good or bad
  - builds ratings database by scrapes all public replays and looks up ratings for each user in each
    replay
  - player psychology is different at different skill levels, and behaviors learned from top players
    won't necessarily translate well to lower-rank play
- two stages of pruning - one before current's turns options are explored which covers  (i.e. move
  accuracy simplification, squashing rolls, etc) and a second one that does the bulk of the work
  which takes place before going to the next level
- "Basically, it looks at all the options both it and the opponent has, evaluates which options are
  best for it and the opponent, then uses Showdown simulator to see the result of those option
  combinations, then picks the move that usually produces the best outcome It will also do some tree
  search through future turns, but no more than three turns deep"
- "I tend to agree with assuming your opponent has perfect info." to cut the amount of work

## Youngster Joey

- Generation 1
- perfect information
- effectively a slightly more sophisticated MDP
- explicitly eschewed minimax + expectiminax due to the expectation that they would play opponents
  who would not play optimally and the large size of the game tree even with alpha-beta pruning
- greedy policy deterministically chooses move maximizing
  [heuristic](https://github.com/alex-shen1/Youngster-Joey/blob/85e7f63d/bot.js#L226-310)
- lookeahead considered as future work

## _Kalose, Kaya, Kim_

- Generation 1 Challenge Cup
- custom deterministic simulator
- Q-learning trained with self-play
  - feature vector just active player and opponent's types and "HP buckets" (10
    buckets)
  - deliberately avoided tracking number of Pokémon left per side
  - large terminal reward + smaller intermediate reward for how much HP player
    and opponent had left
  - softmax exploration strategy with information from previous games (superior to ε-greedy)
- limited training (20k games) = 70% win rate vs. random which is substantially
  lower than the 90% achieved by minimax
- future work suggestions include eligibility traces and larger feature vector

## _Ihara, Imai, Oyama, Kurihara_

- Generation 6 Pokémon BSS format
- combined usage statistics from [Pokémon Global
  Link](https://bulbapedia.bulbagarden.net/wiki/Pok%C3%A9mon_Global_Link) and heuristics fill in
  missing information
- ISMCTS
  - single observer (treats unobservable actions as observable), single observer w/ partially
    observable moves (assumes opponent chooses their own actions randomly), multiple observer
    (separate tree per player)
  - modification to UCB `n` required to differentiate between total number of trials vs. total
    number of times a node was available in an information set
- compared to "cheating" (perfect-information) MCTS, a cheating ensemble variant, and determinized
  MCTS with fixed number of iterations
    - used a fixed pool of 6 Pokémon = reduced conmeta
    - potentially undervalues determinized MCTS because ISMCTS takes more resources

## _Tse_

- uses poke-env, targets Generation 7 VGC
- trained on 700k + 30k Pokémon Showdown battle logs acquired via data grant from top 20% of players
  to learn embedding for battle states (supervised learning)
  - used categorical encodings for embedding instead of one-hot key to shrink size, still had 4186
    features
  - SL network is 6-layer NN with two softmax output layer outpuing action and value
- first layer of SL network not fully connected, idea is to use this layer to create an embedding to
  reduce input feature size (4186 -> 254) and prevent overfitting
- RL network is deep Q-learning with ε-greedy policy to learn action selection (on MCTS?) with the
  SL network serving as a proxy for the true optimal Q-value
  - reward based on outcome of simulated game, %HP of both sides, and value function from SL model
    scaled by hyperparameters
- cites battle simulation as the bottleneck

## Pokemon Trainer AI

- Generation 1 3v3 Lv50
- [custom engine](https://github.com/FredodaFred/pokemon-battle-ai/blob/af1446df/classes.py#L462)
  - not optimized for AI - also features UI elements
  - quirks like Gen 2+ freeze mechanics and ignores accuracy but includes random factor in damage
- evaluating 3 different models
  - [rule-based expert
    system](https://github.com/FredodaFred/pokemon-battle-ai/blob/af1446df/RBES.png)
    [(code)](https://github.com/FredodaFred/pokemon-battle-ai/blob/af1446df/InferenceEngine.py)
  - [decision tree](https://github.com/FredodaFred/pokemon-battle-ai/blob/af1446df/DT.png)
    [(code)](https://github.com/FredodaFred/pokemon-battle-ai/blob/af1446df/pokemon_DT_solution.ipynb)
  - [RL Q-Learning](https://github.com/FredodaFred/pokemon-battle-ai/blob/af1446df/RL.png)
    [(code)](https://github.com/FredodaFred/pokemon-battle-ai/blob/af1446df/RL_train.py)

## Pokémon Simulator Environment

- environment for running a large number of Pokémon Showdown battle simulations, though features a
  [rules-based heuristic
  AI](https://github.com/cRz-Shadows/pokemon-showdown/blob/5932a450/sim/examples/Simulation-test-1.ts)
  for any generation of singles battles that depends on several
  [modifications](https://github.com/cRz-Shadows/Pokemon_Trainer_Tournament_Simulator/blob/5932a450/README.md#modifications-to-pok%C3%A9mon-showdown)
  to the simulator to reveal additional information
- [matchups](https://github.com/cRz-Shadows/pokemon-showdown/blob/5932a450/sim/examples/Simulation-test-1.ts#L263-L287)
  depend on type advantage, speed, and HP percentage
- considers [switching
  out](https://github.com/cRz-Shadows/pokemon-showdown/blob/5932a450/sim/examples/Simulation-test-1.ts#L373-L400)
- contains hardcodes for specific game mechanics like Protect or Explosion or hazards

## `alexzhang13/reward-shaping-rl`

- Generation 8 Ubers, PyTorch and poke-env
- [utilizes LLM for rewarding
  shaping](https://github.com/alexzhang13/reward-shaping-rl/blob/964ea1bc/pokeagent/utils/reward.py)
  using 3 different methods: [sequential
  feedback](https://github.com/alexzhang13/reward-shaping-rl/blob/964ea1bc/pokeagent/environments/pokeenv.py#L19-L83),
  [tree-based
  feedback](https://github.com/alexzhang13/reward-shaping-rl/blob/964ea1bc/pokeagent/environments/pokeenv.py#L85-L210)
  and [moving target
  feedback](https://github.com/alexzhang13/reward-shaping-rl/blob/964ea1bc/pokeagent/environments/pokeenv_PPO.py#L155)
  to proximal policy optimization ([PPO1 from
  stable_baselines](https://stable-baselines.readthedocs.io/en/master/modules/ppo1.html) and [deep
  Q-learning with experience
  replay](https://github.com/alexzhang13/reward-shaping-rl/blob/964ea1bc/pokeagent/models/dqn.py)
  - DQN is input, 512x512x256, output w/ ReLU activations
- always uses the [same team](https://github.com/alexzhang13/reward-shaping-rl/tree/964ea1bc/data),
  allows to ignore abilities and items because instead can simply be treated as properties of the
  Pokémon holding them
- [embedding](
  https://github.com/alexzhang13/reward-shaping-rl/blob/964ea1bc/pokeagent/agents/pokegym.py#L84)
  includes active moves and (unboosted) stats, HP and status for both sides
  - contrained by resources otherwise would use larger input vector
- 10k battles, experimented with changing the reward shaping function at different intervals over
  the course of training
- superior to $`RandomPlayer(\widetilde{100\%})`, roughly on par with $`RandomPlayer(0%)`,
  significantly worse than [base-power
  variant](https://github.com/alexzhang13/reward-shaping-rl/blob/964ea1bc/pokeagent/agents/max_damage.py#L8)
  of $`MaxDamagePlayer`

## PokéLLMon

- Generation 8 Random Battle
- implement environment to translate and parse [battle state into
  text](https://github.com/git-disl/PokeLLMon/blob/bf3fa25c/poke_env/player/gpt_player.py#L224-L551)
  description
- combats halluciniation with in-context reinforcement learning to allow it to
  refine its policy as well as a knowledge base
  - ICRL uses change in HP, effectiveness of attacking moves, priority of move
    execution, and actual effecs of executed moves
  - knowledge augmented generation (KAG) by providing [expected type
    effectiveness](https://github.com/git-disl/PokeLLMon/blob/bf3fa25c/poke_env/player/gpt_player.py#L18-L97)
    and explaination of move effect ahead of time
- supports
  [One-shot](https://github.com/git-disl/PokeLLMon/blob/bf3fa25c/poke_env/player/gpt_player.py#L709),
  [Self-consistency
  (SC)](https://github.com/git-disl/PokeLLMon/blob/bf3fa25c/poke_env/player/gpt_player.py#L737),
  [Chain-of-thought
  (COT)](https://github.com/git-disl/PokeLLMon/blob/bf3fa25c/poke_env/player/gpt_player.py#L810),
  [Tree-of-thought
  (TOT)](https://github.com/git-disl/PokeLLMon/blob/bf3fa25c/poke_env/player/gpt_player.py#L838)
  prompting approaches
- combats "panic switching" that happens with chain-of-thought agents with
  voting to ensure consistent action generation
  - self-consistency generates 3 answers and relies on most popular
  - chain-of-thought and tree-of-thought not as effective
- description to LLM includes battle state and [historical turn log including
  actions taken by both
  side](https://github.com/git-disl/PokeLLMon/blob/bf3fa25c/poke_env/player/gpt_player.py#L228-L241)
- training against poke-env's `SimpleHeuristicsPlayer`
- weakeness: tends to act greedily
- [falls back on being max base power
  player](https://github.com/git-disl/PokeLLMon/blob/bf3fa25c/poke_env/player/gpt_player.py#L958-L962)
- [rule-based decision to
  Dynamax](https://github.com/git-disl/PokeLLMon/blob/bf3fa25c/poke_env/player/gpt_player.py#L197-L221)
