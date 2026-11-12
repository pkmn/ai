# Design

Despite competitive Pokémon artificial intelligence projects having existed for
close to 15 years, AI is only just now beginning to achieve superhuman
performance, and the field as a whole is still incredibly underdeveloped
compared to those of computer chess or poker. The complexity of Pokémon and lack
of sufficient infrastructure / resources / guidance means that most developers
are unable to explore ideas in depth as everyone ends up continually reinventing
the wheel and then fizzling out.

**pkmn.ai** aims to solve this problem and advance the field by becoming the
**home of competitive Pokémon artificial intelligence**. Ultimately, pkmn.ai
aims to provide:

  - an authorative ranking of all active competitive Pokémon battling agents
  - a hub for any and all Pokémon AI research, articles, tournaments / events
  - a community of loosely coupled collaborating researchers and developers

pkmn.ai ambitiously hopes to fulfill the same role the [Chess Programming
Wiki](https://www.chessprogramming.org/Main_Page), the [Computer Chess Rating
Lists](https://www.computerchess.org.uk/ccrl/) (CCRL), and the [Top Chess Engine
Championship](https://tcec-chess.com/) (TCEC) do for computer chess, or [AI
Poker Tutorial](https://aipokertutorial.com/) and the [Annual Computer Poker
Competition](http://www.computerpokercompetition.org/) do for computer poker.

Others have attempted to create platforms for hosting Pokémon AI competitions
and streamlining the creation of agents:

  - [poke-env ](https://github.com/hsahovic/poke-env)
  - [dramamine/leftovers-again](https://github.com/dramamine/leftovers-again)
  - [pokemon-env](https://github.com/pokeml/pokemon-env)
  - [Simplified Pokemon
    Environment](https://gitlab.com/DracoStriker/simplified-pokemon-environment)
  - [VGC AI Framework](https://gitlab.com/DracoStriker/pokemon-vgc-engine)

While these seem valuable for getting developers up and running quickly and
certainly provide value, ultimately they do not seem to have captured the
mindshare of the broader community - most of the strongest agents have not been
built utilizing these frameworks. pkmn.ai does not seek to supplant these
efforts - ideally agents built for these platforms would also be able to compete
in the pkmn.ai leaderboards and the respective communities will be able to help
each other improve.

## Competition

Historically, developers have measured their agent's strength via [Pokémon
Showdown's ladder](https://pokemonshowdown.com/ladder). This has always been a
relatively poor way of measuring performance between various projects (projects
target different formats, run at different times where the quality of a ladder
for a format may vary widely, possibly are using weak teams or experiencing poor
team matchups, often only report the strongest of their ladder runs) and is no
longer a realistic option due to [policy
changes](https://www.smogon.com/forums/threads/initial-policy-on-bots.3789528/)
following community backlash around the influx of bots. Furthermore, given that
AI is quickly overtaking humans at competitive Pokémon battling, evaluating
against humans is ultimately not going to be a useful measure of performance
going forward.

Projects like the [PokéAgent Challenge](https://pokeagent.github.io/) or
[vgc.bot](https://vgc.bot) are better attempts at hosting arenas for AI agents
to battle, though pkmn.ai aims to go further and provide **hosted sandboxes for
stable long-term evaluation of Pokémon agents**.

### Hardware

All current ladders require developers to run their models on their own hardware
and queue to play against other competitors. There are several issues that arise
from this approach:

- competitors are potentialy handicapped by access to hardware to run their
  agent: some are only able to run on a single thread on their laptop and may be
  asked to compete against something like
  [Athena](https://pkmn.ai/projects#Athena) which was able to leverage multiple
  large servers
- agents may be taken offline arbitrarily (or because the author needs the
  hardware for other means / has lost interest). Many bots only exist on the
  ladder for the short period of time its owner is attempting to quantify its
  performance before being taken offline
- versioning is muddied: developers are likely to find it easier to simply
  update their agent in place which makes it more difficult to track the exact
  performance delta of their changes
- team-building is a difficult orthogonal problem to piloting that has a large
  influence on an AIs ultimate performance and variance-elimination approaches
  such as blind-pair matches are impossible to enforce

Two issues related to providing a hosted solution are:

1. cost
2. competitors must be willing to trust the organizer with their code & weights

pkmn.ai plans to tackle the cost aspect similar to how computer chess handles
things with a hybrid approach:

- a **ladder** for a restricted set of formats will hosted continuously on more
  modest hardware (like CCRL)
- regular **tournaments** will be hosted over the course of a weekend on more
  expensive hardware for select formats (like TCEC or CCC)

pkmn.ai has close ties with Smogon and Pokémon Showdown and has hopefully helped
establish a patten of competence and good faith that will ease concerns of
competitors regarding sharing their agents for the purposes of evaluation.

#### Specifications

##### Ladder

CCRL currently runs chess engines on the [equivalent of a Intel Core i7-4770K on
either 4 or 8 cores](https://computerchess.org.uk/4040/about.html). While
attractive for cost purposes, such constrained hardware for competitive Pokémon
would ultimately limit the utility of this ladder. In 2026, multithreaded
systems are the norm and large neural networks that require GPU access for
inference are an important component of game playing agents.

pkmn.ai has chosen an **Apple M6 Mac mini** with 32 GB of unified memory,
12-core CPU (8 Performance + 4 Efficiency), 12-core Apple Silicon GPU, Dual
16-core Neural Engine as the hardware for the ladder sandbox (roughly 3x better
single-threaded and 5x better multi-threaded performance than the baseline used
by CCRL, plus access to a GPU). A system running Linux and with an NVIDIA GPU
would be preferable, but the M6 Mac mini has excellent single-threaded speed, a
functional GPU, and excellent energy efficiency which makes it a good value
choice. By serializing play and implementing time slicing (at the cost of
eliminating pondering), agents will get to use almost the entirety of the
hardware, allowing for ample hardware resources compared to what most projects
run on today.

If the ladder proves popular, additional hardware can be added to improve
throughput - if the hardware pool becomes heterogenous pkmn.ai will take the
same approach CCRL does and will modify the game timer to match the hardware the
games are taking place on to attempt to balance hardware differences (matches
between agents will always take place on the same hardware; accounting for
hardware differences is mostly relevant to eliminately skew compared to
historical models).

##### Tournaments

The large computer chess tournaments (TCEC & CCC) use substantially larger boxes to host engines:

<details><summary>TCEC Details</summary><pre>
CPU: 2x Xeon 6230R (52 cores/104 threads)
GPU: 2xA100-PCIE-40GB
RAM: 256GiB (~96GiB/engine)
Storage: 2TiB SSD + Starting from S23 VVLTC: 12TiB (4 drives) NVMe SSD for Syzygy3-7 (total 14TB) + 15TiB (2 drives raid1 (30TiB)) HDD for Syzygy7 DTZ
</pre></details>
<details><summary>CCC Details</summary><pre>
CPUs | 2 x AMD EPYC 7H12
GPU | 2x A100 (40 GB GPU memory)
Cores | 256 cores (128 physical)
RAM | 512GB DIMM DDR4 2933 MHz (0.3 ns)
SSD | 2x Micron 5210 MTFD (2TB) in RAID1
</pre></details>

These are almost certainly overkill for today's Pokémomn agents, but since
pkmn.ai plans to host these tournaments as one-off events, the hardware for the
event can be decided upon in the leadup to the event. For a tournament hosted at
the time of writing (October 2026), a fleet of Google Cloud `g2-custom-24-49152`
VM spot instances could be rented (1 NVIDIA L4, 24 vCPUs, 48 GB RAM) to run the
a full round robin (50 games for each head-to-head pairing) tournament for ~$50.

### Isolation

Players during a game will always run on the same hardware (either on the same
machine for the ladder or two identical VMs for tournaments). Competitors will
be given restricted read-only file system access and ephemeral read-write temp
space and will be unable to access the broader internet. When sharing a machine,
competitors will be paused after making their choices each turn to allow their
opponent to run ("time-slicing"). This approach provides the best isolation and
works around macOS not allowing partitioned access to the GPU/ANEa t the cost of
eliminating [pondering](https://pkmn.ai/terms#pondering) and less throughput
(games take longer and less games can take place simultaneously). CCRL also
disables pondering, and given that pondering is even less relevant in
competitive Pokémon and can also be enabled in the hosted tournaments, disabling
it for ladder play feels acceptable.

The need for isolation also contributes to the format of submitted entries into
the arena: the simplest format is to require an OCI container and to manage
these with Podman, however, this approach doesn't allow full native access to
the GPU/ANE. To workaround this, pkmn.ai will allow for competitors to either
submit OCI containers _or_ a native "bundle" (`.tar.{gz,xz,zst}`) which has its
isolation handled manually to allow it native access to the Apple Silicon.

### Formats

The format considerations for the sandbox are perhaps the most important
component - the "blessed" formats that are chosen will necessarily factor in to
what developers target and will have a large impact on the success of the arena
and the direction of the field.

The first decision regarding formats/rules is
that we should support **the minimum number of formats necessary** - supporting
too many formats splits the field (too few competitors playing in the same
format) and takes away from the more popular formats (everyone is competing for
the same hardware resources, and games played in less popular formats pins
resources that could be being used by popular ones).

Ladder formats should also be **stable and long-lived** - pkmn.ai's arena aims
to be able to compare bots over time throughout history, and flash-in-the-pan
formats which are only around for a few months and don't get played a year later
are not a great fit for the timelines of building and training a model and
iteratively trying to improve it. Furthermore, a constantly changing format
makes it impossible to run directly against past models / versions - the older
versions will not be aware of format shifts or mechanics changes and would be
artifically much weaker than updated models. These sorts of formats are much
better suited for the one-off tournament model proposed by pkmn.ai.

It is important to note that competitive Pokémon as a game is always somewhat of
a moving target (c.f. [pkmn.cc/changes](https://pkmn.cc/changes)) - bans and
simulator fixes or mods occur even to historical generations. However, these
shifts are (generally) much smaller than those that occur with the short-lived
VGC formats or changes due to DLC or early-Generation ban waves. An agent
trained on a historical meta from a few years ago will likely be relatively
straightforward to make similarly strong on the meta as it is today compared to
agents trained for more volatile formats which might not generalize as well.

Formats should also be **as close to those that human's play as possible** -
while we expect agents to be much better than humans in the future, we still
ultimately want to stay connected to what the competitive scene is today and
stay away from agents targeting something dramatically different than what is
player on human ladders.

pkmn.ai would like to **eventually host formats that feature teambuilding and
drafting**, but for the time being is focused on only the piloting aspects of
competitive Pokémon battling. Evaluating teambuilding and drafting is
signficantly more costly (presumably requires a lengthy and expensive pre-match
drafting / building phase) and the field currently appears to be too nascent to
really tackle these aspects of competitive Pokémon. The proposed periodic
tournament structure also seems well suited to trialing this in a year or so.

#### Teams

In order to eliminate team matchup variance, pkmn.ai will run all ladder games
as paired matches - competitors will face off twice in a row with their teams
swapped and their ratings will be calculated based on the match results, not
individual games. If player's bring their own teams this makes the second game
artificial as the player would then have full knowledge of their opponent's
team. As such, on the ladder, teams should be provided for the agents from a
fixed pool of preharvested strong teams. Matches of this sort will be
**blind-pairs**, where neither player has special knowledge of what their
opponent is playing, nor do they have particular experience of their own team
(papers like [Metagrok](https://pkmn.ai/papers#Metagrok) demonstrate training on
a specific team results in stronger play) which will force developers to make
their bots more general.

Blind-pair matches constrain formats to be historical - a format needs to be
well-established enough that there exists a strong set of teams to draw from.
This sort of evaluation also removes the teambuilding aspect of Pokémon - to
counter this, pkmn.ai's tournaments will be bring-your-own-team (BYOT), meaning
that while ladder play is solely focused on piloting, developers that feel they
can get an edge through teambuilding or training on specific teams can still
express themselves and have an opportunity to succeed.

#### Proposal

> [!NOTE]
> This section is a proposal and subject to change based on feedback
> from the Pokémon AI community.

At launch, pkmn.ai's ladder will support:

- `gen1singles`: effectively what Pokémon Showdown's `gen1ou` was, fixed to
  specific recent TBD era. The [PokéAgent
  Challenge](https://pokeagent.github.io/leaderboard.html) already featured a
  number of Generation I agents demonstrating a reasonably large base of
  potential competitors. Additionally, RBY is the simplest and most "solvable"
  format which makes it an interesting area of research.
- `gen3singles`: similar to above, Pokémon Showdown's `gen3ou`, fixed to a
  specific TBD era. Generation III has the advantage of being a bridge between
  modern formats and the older generations, serving as the simplest environment
  that is a stepping stone to the recent game.
- `gen9singles`: Pokémon Showdown's `gen9ou` fixed to a recent era. While still
  a contemporary and technically more volatile format, Generation IX has both a
  significant base of developers targeting it and is effectively stable after
  such a long duration as the most-recent Generation.
- `gen9randoms`: Pokémon Showdown's Random Battles formats have been
  historically targeted by developers due to the large playerbase and the
  simplification of not having to provide teams. While this latter constraint is
  obviated for the other formats already under this proposal (see above), Random
  Battles also has a more simplified information set for an opponent's Pokémon
  which is attractive. Like the others, this format's rules will be fixed to a
  recent era (likely Nov 2026).

All formats will use the exact same timer rules as Pokémon Showdown (with the
except of pondering being disabled) - while many bots currently rely strictly on
policy and can move in <1s, pkmn.ai wishes to enable the possibility for models
to search during play and explore timer management strategies.

#### Doubles

Double Battles are an important category of competitive Pokémon battling, yet
the most popular variant of doubles, VGC, presents a challenge for pkmn.ai's
ladder needs. VGC's constantly shifting ruleset (and mechanics changes, with the
advent of Pokémon Champions) means permanent ladders for these ephemeral formats
are misguided. pkmn.ai's tournament option is an excellent match for VGC, and
provided sufficient interest and sign-ups, **pkmn.ai plans to host a standrd VGC
OTS Bo3 tournament at the conclusion of every VGC season**.

While guaranteed tournaments are nice, not offering a permanent ladder for
doubles feels inadequate given the demonstrated interest of the community.
pkmn.ai could provide a ladder for a frozen `gen9doublesou` or
`gen9randomdoubles` format, but these formats differ from VGC (different timer,
bring-6-pick-6, not Champions, not level 50, etc) perhaps too substantially for
a VGC model to translate well to this style of gameplay. The community could
decide on a specific VGC format to freeze and target for a ladder, but this also
feels unlikely to be sufficient as the VGC rulesets are large shakeups which
limits the applicability of old models to new VGC formats.

Some sort of **"seasonal" ladder** concept could be explored where the pkmn.ai
VGC ladder only lives for a shorter period of time (the VGC season plus however
long it takes for the ratings of the submitted agents to settle post-season) and
then gets archived to make way for a new season. While this is the most logical
in practice, a different structure would need to be explored for teams as it
would not be possible to acquire the historical highly rated team data in the
same way it would be for other formats. The best option would be to require bots
to submit X (= 20?) teams along with their container/bundle that can be added to
the team pool to faciliate "semi-blind" team pairing (players should only have
full knowledge of their opponent's teams 1/Nth of the time, where N is the
number of competitors on the ladder).

##### Zoroark

Zoroark's Illusion ability and other complicated Pokémon mechanics (e.g., Dragon
Darts, Ditto/Imposter, Trace, Unburden, Dancer) are worth considering for a ban
in the formats where they feature. In many cases the mechanic is niche and not
fundamental to the format yet adds substantial complexity and development
overhead. The main argument for keeping them is that they are a part of the game
and provide a way for models to eke out an advantage over their competitors by
handling these better, though depending on community sentiment it would be
reasonable to exclude a subset of these mechanics / effects from a format.

##### Expansion

While pkmn.ai hopes to help focus the field, proven demand for additional
formats for other ladders will result in expanding offerings. As a general rule,
a stable format which has some minimum number of participants (e.g. 5 different
developers with completed agents) or more prospective participants than the
current least popular ladder will be eligible.

If ladders prove to be unpopular, matchmaking parameters can be modified to
further deemphasize ladders to save resources for the more popular ones, though
this should already happen automatically as matchmaking (see below) is set up in
a way which will already favor the ladder that has the most activity in the form
of developer submissions.

### Ranking / Matchmaking

TODO


### Participation

TODO

#### Registration

github form, required naming + pictures + contats, fill out projects.yml
responsible release, access to models for moderation + laddering (consent)

#### Rules

no cirumvention

#### Submissions

packaing
models
quarantine

#### Data

access to randbats data, access to usage stats

---

## Architecture

pkmn.ai is built around two servers - one minimally provisioned (1CPU/2GB) Digital Ocean droplet
which exists to serve the https://pkmn.ai [site](#site), run the [sim server](#sim), handle
[matchmaking](#matchmaking) and coordinate with the [controller](#controller) on the [competition
server](#competition). The competition/area server is a donated `n2d-standard-48` Google Cloud Compute
Engine machine with 192 GB of memory and an AMD EPYC 7B12 CPU running 64-bit x86 Linux, though is on
a virtual network and cannot serve public traffic, necessitating this hybrid design.

### Sim

pkmn.ai does not need to run a full blown Pokémon Showdown sim and login server
due to its unique requirements (most importantly, a fixed pool of predefined
users) which is helpful, as running the entire Pokémon Showdown stack usually
has higher resource demands than pkmn.ai would like to incur. Instead, the arena
will simply call the `@pkmn/sim` directly and competitors will interface with it
over stdin/stdout.

### Site

In order to scale in spite of the resource constraints, https://pkmn.ai is designed to be served
statically by Nginx and cached by Cloudflare wherever possible - the vast majority of content is
written in [Djot](https://djot.net/) and built into minimized HTML at compile time by a
[build](src/static/build.ts) tool, with the leaderboard pages being rewritten after each battle
completes.





