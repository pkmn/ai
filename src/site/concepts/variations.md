TODO polish

Competitive Pokémon is a two-player
[simulataneous](https://en.wikipedia.org/wiki/Simultaneous_game), [imperfect
information](https://en.wikipedia.org/wiki/Perfect_information),
[constant-sum](https://en.wikipedia.org/wiki/Zero-sum_game),
[stochastic](https://en.wikipedia.org/wiki/Stochastic_game) game with both an [offline and
online](#offline-vs-online) component with a extremely [high branching
factor](https://en.wikipedia.org/wiki/Branching_factor). In order to simplify things and make the
game more tractable to solve, various relaxations can be made.

## "Offline" vs. "Online"

The game of Pokémon involves a **team-building** component and a **piloting** (or "playing", though
this second name is somewhat confusing as it involves only playing one aspect of the broader game)
component. The team-building component can be done ahead-of-time/completely offline and usually
involves constructing a team to beat an entire [metagame](https://en.wikipedia.org/wiki/Metagame),
whereas the piloting of the team by the player against a specific opponent takes place in
real-time/online. While the success of a Competitive Pokémon player depends on both components, the
components can also be treated as orthogonal without loss of generality and so developers most often
focus on only the piloting part.

## Information

Outside of more general modifications that can be made to almost any game to decrease the difficulty
(e.g. increasing the amount of time available per decision), most of the remaining simplifications
made to Pokémon involve reducing the number of "unknowns", either by tweaking the amount of
information that is revealed to players or by restricting the amount of possible options players'
have during team-building:

- knowledge of **available choices** (e.g. whether the player's active Pokémon is trapped or
  disabled) is one of the most minimal modifications that can be made to the game, and mostly exists
  as a development convenience (allows you to be fully aware of the available choices without having
  to deal with uncertainty) and has relatively minor implications to actual playing strength or
  realism
- knowledge of an **opponent's HP** (either exact HP or increased accuracy via the `HP Percentage
  Clause Mod`) is helpful for being able to perform reverse damage calculation and more quickly
  infer the opponent's sets, but is still minor enough to not have dramatic gameplay implication
  (most standard play in Smogon University's metagames between human players already leverages this)
- knowledge of an **opponent's team** makeup and configuration is significantly more artificial as
  it removes the aspect of information gathering/hiding and provides a significant advantage to the
  player, but as the battle progresses well developed team prediction will eventually determine this
  information anyway. This is the most common simplication and [many different options
  exist](#team-restrictions) in this area
- knowledge of further **hidden information** known only to the engine (e.g. remaining sleep turns)
  beyond what is covered above but while still retaining some stochastic aspects without revealing
  the RNG seed is difficult to pin down, as exactly what information should be revealed is rather
  arbitrary
- knowledge of the  **RNG seed** (which both provides full information on existing unknown
  information such as duration of various statuses and limited knowledge of immediate future
  outcomes) helps *determinize* the game tree by effectively removing stochasticity, though the
  amount of unknowns revealed means that game play starts to get too artificial
- knowledge of the **opponent's upcoming move** during the current turn is interesting in that it
  [*sequentializes*](https://en.wikipedia.org/wiki/Sequential_game) the game (thus removing the
  complications of dealing with simultaneity), but obviously dramatically changes how the game is
  played

Note that the options above are not necessarily always mutually exclusive - modifications can be
combined to produce different potentially interesting gameplay variants.

## Team Restrictions

Some of the biggest reductions in [information
set](https://en.wikipedia.org/wiki/Information_set_(game_theory)) size can be obtained through
restrictions on the rules involved with team-building:

- game options can be restricted to a **predefined subset** of Pokémon
  Species/Moves/Abilities/Items. Almost all Competitive Pokémon formats restrict options to some
  extent (e.g. from banning "mythical" Pokémon in Nintendo formats or Pokémon which are highly used
  in Smogon University's to a combination of limitations such as those found in [Little
  Cup](https://www.smogon.com/dex/ss/formats/lc/)), though this can be taken to extremes (e.g. the
  ["Shanai
  Cup"](https://web.archive.org/web/20110706011535/http://pokemon-online.eu/forums/showthread.php?6273))
- players can be forced build teams only from a pool of specific Pokémon species that were
  previously selected in a **draft** phase by the player with knowledge of their opponent's pool of
  allowed Pokémon species (e.g. Smogon Unversity's [Draft
  Leagues](https://www.smogon.com/articles/beginners-guide-draft)). This change reduces the number
  of possible movesets for both players, but also changes team-building due to being able to cater
  one's team through exploiting knowledge of an opponent's options (it also introduces as "drafting"
  component to "team-building" and "piloting")
- allowing players to only choose teams from a fixed pool of **sample teams** as opposed to building
  ones from scratch. This simplifies the team-building component (rendering it a "team-selection"
  component) and also greatly reduces information set size during play provided the pool only
  consists of a limited number of teams
- requiring Pokémon on teams be drawn from a specific pool of possible sets, similar to how
  [**Battle Factory**](https://bulbapedia.bulbagarden.net/wiki/Battle_Factory_(Generation_IV))
  rental Pokémon work on the cartridge games
- allowing for Pokémon sets to vary, but **restricting set variation** by limiting the pool of
  possible choices for each field. e.g. [Pokémon Showdown's Random
  Battle](https://www.smogon.com/articles/random-formats-overview) formats
- providing a **preview** of the opponent's team before the battle and introducing a phase before
  the battle takes place where players can select their team order (eg. most formats post Generation
  V).
- reducing a team's maximum size from the standard default of 6 vs.6 to either a strict **$N vs.
  N$** before the battle, or through a **bring $M$ choose $N$** mechanic where players must select a
  subset of their original team to actually battle with (e.g. [Battle Stadium
  Singles](https://www.smogon.com/dex/ss/formats/battle-stadium-singles/) or Smogon University's
  [1v1](https://www.smogon.com/dex/ss/formats/1v1/) format)
- requiring players to share information about their team with their opponent before the match via
  **open team sheets** (e.g. [Nintendo's Pokémon Video Game Championship ruleset in
  2023](https://www.pokemon.com/static-assets/content-assets/cms2/pdf/play-pokemon/rules/play-pokemon-vg-team-list-2023.pdf))

Similar to above, some of these restrictions can be combined to arbitrarily bound the size of the
information set (e.g. [obi's 1v1 thought
experiment](https://www.smogon.com/forums/threads/pokemon-rankings-wobbuffet-is-503.61246/) which
combines maximum team size restrictions and aspects of drafting).