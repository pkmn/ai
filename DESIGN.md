# Design

Despite competitive Pokémon artificial intelligence projects having existed for close to 15 years,
no AI has yet acheived superhuman performance, and the field as a whole is still incredibly
undeveloped compared to those of computer chess or poker. The complexity of Pokémon and lack of
sufficient infrastructure/resources/guidance means that most developers are unable to explore ideas
in depth as everyone ends up continually reinventing the wheel and then fizzling out. 

**pkmn.ai** aims to solve this problem and advance the field by becoming the **home of competitive
Pokémon artificial intelligence**. Ultimately, pkmn.ai aims to provide:

  - an authorative ranking of all active competitive Pokémon battling agents
  - a hub for any and all Pokémon AI research, articles, tournaments/events
  - a community of loosely coupled collaborating researchers and developers

pkmn.ai ambitiously hopes to fulfill the same role the [Chess Programming
Wiki](https://www.chessprogramming.org/Main_Page), the [Computer Chess Rating
Lists](https://www.computerchess.org.uk/ccrl/), and the [Top Chess Engine
Championship](https://tcec-chess.com/) do for computer chess, or [AI Poker
Tutorial](https://aipokertutorial.com/) and the [Annual Computer Poker
Competition](http://www.computerpokercompetition.org/) do for computer poker.

Others have attempted to create platforms for hosting Pokémon AI competitions and streamlining the
creation of agents:

  - [poke-env ](https://github.com/hsahovic/poke-env)
  - [dramamine/leftovers-again](https://github.com/dramamine/leftovers-again)
  - [pokemon-env](https://github.com/pokeml/pokemon-env)
  - [Simplified Pokemon Environment](https://gitlab.com/DracoStriker/simplified-pokemon-environment)
  - [VGC AI Framework](https://gitlab.com/DracoStriker/pokemon-vgc-engine)

While these seem valuable for getting developers up and running quickly and certainly provide value,
ultimately they do not seem to have captured the mindshare of the broader community - most of the
strongest agents have not been built utilizing these frameworks. pkmn.ai does not seek to supplant
these efforts - ideally agents built for these platforms would also be able to compete in the 
pkmn.ai leaderboards and the respective communities will be able to help each other improve.

## Competition

### Resources

- isolation/system details (gpu, cpu, readonly etc)

```
TCEC is CPU: 2x Xeon 6230R (52 cores/104 threads)
GPU: 2xA100-PCIE-40GB
RAM: 256GiB (~96GiB/engine)
Storage: 2TiB SSD + Starting from S23 VVLTC: 12TiB (4 drives) NVMe SSD for Syzygy3-7 (total 14TB) + 15TiB (2 drives raid1 (30TiB)) HDD for Syzygy7 DTZ

CCC is CPUs | 2 x AMD EPYC 7H12
GPU | 2x A100 (40 GB GPU memory)
Cores | 256 cores (128 physical)
RAM | 512GB DIMM DDR4 2933 MHz (0.3 ns)
SSD | 2x Micron 5210 MTFD (2TB) in RAID1
```

### Data 

- access to grabbing data
  - teams (test data as opposed to training data)
  - stats

TODO need some way to let users register releases AND link log fetching data

---

Accurately ranking competitive Pokémon AIs comes with several challenges:

  - Developers often target a small number of formats which do not overlap with competitors
  - Team-building is a difficult orthogonal problem to piloting that has a large influence on an AIs
    ultimate performance
  - Pokémon is stochastic and matchup dependent, making concrete ratings difficult

### Isolation

Controlling the environment that agents run on is crucial for obtaining fair and consistent results.
Furthermore, each agent would ideally have sufficient resources to be able to perform at a
reasonable level. However, 

For optimal isolation the individual agents should run on separate identical machines, however, due
to resource contraints it is more cost effective to have the agents share the same larger server (an
`n2d-standard-48` Google Cloud Compute Engine machine with 192 GB of memory and an AMD EPYC 7B12 CPU
running 64-bit x86 Linux).

<details><summary>CPU Details</summary><pre>
Architecture:            x86_64
  CPU op-mode(s):        32-bit, 64-bit
  Address sizes:         48 bits physical, 48 bits virtual
  Byte Order:            Little Endian
CPU(s):                  48
  On-line CPU(s) list:   0-47
Vendor ID:               AuthenticAMD
  Model name:            AMD EPYC 7B12
    CPU family:          23
    Model:               49
    Thread(s) per core:  2
    Core(s) per socket:  12
    Socket(s):           2
    Stepping:            0◊
    BogoMIPS:            4499.99
    Flags:               fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ht syscall nx mmxext fxsr_opt pdpe1gb rdtscp lm constant_tsc rep_good nopl nonstop_tsc cp
                         uid extd_apicid tsc_known_freq pni pclmulqdq ssse3 fma cx16 sse4_1 sse4_2 movbe popcnt aes xsave avx f16c rdrand hypervisor lahf_lm cmp_legacy cr8_legacy abm sse4a misalignsse 3dnowprefet
                         ch osvw topoext ssbd ibrs ibpb stibp vmmcall fsgsbase tsc_adjust bmi1 avx2 smep bmi2 rdseed adx smap clflushopt clwb sha_ni xsaveopt xsavec xgetbv1 clzero xsaveerptr arat npt nrip_save um
                         ip rdpid
Virtualization features:
  Hypervisor vendor:     KVM
  Virtualization type:   full
Caches (sum of all):
  L1d:                   768 KiB (24 instances)
  L1i:                   768 KiB (24 instances)
  L2:                    12 MiB (24 instances)
  L3:                    96 MiB (6 instances)
NUMA:
  NUMA node(s):          2
  NUMA node0 CPU(s):     0-11,24-35
  NUMA node1 CPU(s):     12-23,36-47
Vulnerabilities:
  Itlb multihit:         Not affected
  L1tf:                  Not affected
  Mds:                   Not affected
  Meltdown:              Not affected
  Spec store bypass:     Mitigation; Speculative Store Bypass disabled via prctl
  Spectre v1:            Mitigation; usercopy/swapgs barriers and __user pointer sanitization
  Spectre v2:            Mitigation; Retpolines, IBPB conditional, IBRS_FW, STIBP conditional, RSB filling
  Srbds:                 Not affected
  Tsx async abort:       Not affected
</pre></details>

2/3 of the system can be used to run battles, and splitting up these resources 4 ways means that we
can run two battles simultaneously, with each agent being given 32 GB of RAM and 8 cores. 

```
docker run
—expose 8000
—read-only
—memory 32 —memory-swap 32
—cpuset-cpus 

0,1,2,3,24,25,26,27
4,5,6,7,28,29,30,31
—-
8,9,10,11,32,33,34,35
12,13,14,15,36,37,38,39
16,17,18,19,40,41,42,43
20,21,22,23,44,45,46,47
```
### Rules

TODO reasoning behind rules


## Architecture

pkmn.ai is built around two servers - one minimally provisioned (1CPU/2GB) Digital Ocean droplet
which exists to serve the https://pkmn.ai [site](#site), run the [sim server](#sim), handle
[matchmaking](#matchmaking) and coordinate with the [controller](#controller) on the [competition
server](#competition). The competition server is a donated `n2d-standard-48` Google Cloud Compute
Engine machine with 192 GB of memory and an AMD EPYC 7B12 CPU running 64-bit x86 Linux, though is on
a virtual network and cannot serve public traffic, necessitating this hybrid design.

### Sim

pkmn.ai does not need to run a full blown Pokémon Showdown sim and login server due to its unique
requirements (most importantly, a fixed pool of predefined users) which is helpful, as running the
entire Pokémon Showdown stack usually has higher resource demands than pkmn.ai would like to incur.
Instead, a small socket server will be built around the
[`@pkmn/sim`](https://www.npmjs.com/package/@pkmn/sim) package. TODO

### Site

In order to scale in spite of the resource constraints, https://pkmn.ai is designed to be served
statically by Nginx and cached by Cloudflare wherever possible - the vast majority of content is
written in [Djot](https://djot.net/) and built into minimized HTML at compile time by a
[build](src/static/build.ts) tool, with the leaderboard pages being rewritten after each battle
completes. Replays of individual battles are the only content that gets served dynamically (though
access to these should be rate-limited), as it is expected that most will not ever be retrieved and
the battles are already stored as JSON that simply needs to be wrapped with a bit of boilerplate to
render as a replay.

---

controller = component on the docker server, sends heartbeat requests to sim and if disconnected for
15 minutes sim and/or helper sends message to discord server

Battle logs are source of truth, need backup + archive service (upload archives to GitHub) + restore
~~Can have custom ID~~ PS approach is more flexible/future proof

```
gen1ou-20231104175601 # datetime
/1/Athena-TechnicalMachine-5
Athena-vs-TechnicalMachine
/gen1ou/FutureSight-vs-0ERROR/10
``````

TODO how to update watchdog? needs to be manual

TODO `/motivation`` (/challenge? - what makes Pokemon an interesting research problem. link to intro
to competitive Pokemon which covers base mechanics required)


sim decides next round (always play 1 then kill then play swapped) tells controller to kill old
participants and start next round with new pairing round robins participants attempting to ensure
balanced number of battles = naive alternatively, matchmake based on (a) most uncertainity of rating
(want balanced) and then number of battles (cant have one person have too many battles) dont want
glicko because decay doesnt make sense

**NEED BAYESELO WRAPPER**

### `/leaderboard`

Leaderboard/Tournament Open/Controlled Generation N

History = games per month (links to github) = 7z each days worth of logs and tar the formats and
months


click bot = has same summary info from projects.md (need to share rendering logic… in server! =
prerender snippet) show matchup vs other bots show matchups vs past versions links to all replays

only show dominant version of each bot (might not be most recent) keep dominant and most recent in
the pool, other bots retired

append to csv file with a record from each game, can use this to compute bots rating after each day
as well. looks a lot like a database… = technically an index, can also use to figure out next battle
ID. can be restored from battles (pre write tool to do this)

need to prerender rating graphs?? how much of tables can be prerendered?

problem = replays need to be obfsucated into spectator replays because otherwise leaks teams (teams
effectively get leaked anyway because k anonymity cant be enforced over so many battles) = can only
share replays between “seasons” (and still want pruned version)
- log @pkmn/sim version so recreatable

want everyone to play at least a round with the same team, = need to then track who used what from
teams DB. instead can just assure each team gets used twice then moved on (limits data and lets us
upload spectator replays more quickly. need large team pool to remove possibility of dupes)

OPTION = just always generate all tables statically (what happens if fuck up?) = uses disk space,
but if need to precompute anyway also uses disk.
- index needs updating, pages for both bots needs updating nginx does all serving (and set up
aliases there), no need for polka

  <script async src="https://unpkg.com/mathjax@3.2.2/es5/tex-mml-chtml.js"></script>

TESTING LEVELS

1. server itself populates leaderboard from random procedure
2. watchdog randomly decides W/L/T result, doesnt bother launching bots
3. watchdog starts up RandomPlayer(N) for various N to get lots of quick battles

"tables"
- users (read in config with agents/names/IPs etc)
- matchmaking (matrix of name-version vs. name-version num battles)
- ratings table of everyones ratings and total battles?

---

start needs to start websocket server (which also periodically builds files) as well so remove
http-server

static src/tools/seed (simulate - flag to determine at what level to prosuce) produce leaderboaed
info after every battle
- run job to preseed https://github.com/pkmn/PKMN/blob/main/src/db/seed.ts

need to render replays on the fly
- strip data
- provide option of html/json/.log txt

use polka for this (and static if NODE-ENV is not prod = add node env is development to bashrc)

---

takes N battles, runs N battles and writes the log files (need socket server setup?)
- after each battle in background queue / threadpool or process write for update (dont block normal
  serving) HOWEVER need to avoid starting new battle until previous battle is fully written to
  minimize dataloss? alternatively queue and make sure each gets writte n sequentially, though
  unglamour shutdown could lose data
- 

make something which generates data for leaderboard/games (tools:seed?) = npm test:integration, do
not run init if not CI/development?/make sure to delete data in posttest!

u16 bot u16 version ? start at byte for each. need one for each player, their rating at the the time
and then result? = INDEX file

- needs some datastructure that stores history of ratings Chart:
https://css-tricks.com/how-to-make-charts-with-svg


battle logs = source of truth ID = next battle id RESULTS history = index used for building various
things (battles page is full list of battles), also used for all battles by particular person =
requires looking in either p1 or p2 RATINGS = most recent rating for everyone RATINGS HISTORY =
every day a snapsot of the ratings file gets added per row, used for building chart PLAYERS = login
details. avatar, name, id etc. just a config JSON file

problem, what about efficient scan?

taylorhansen/pokemonshowdown-ai #353 #354 #357 #362 #363 #364 #176 #326 #323

How to keep up to date on "Latest Release" in projects.yml? needs test = write something which
queries GH/pip/npm for latest?

Open comp = regular ladder, can have multiple battles at once, matchmaker is different than PS
though (try to get N battles which each bot etc) Also needs to be unversioned.

Server can restart between decisions = save state and timers and reinit on startup then clients
reconnect (ensure reconnect to correct battle) = max 5-10 minutes for a restart. Still would prefer
to be able to restart without killing sockets though?

protocol - port of relevant bits of PS doc + much stricter



3. add comments to player/MDP/RP
4. write tests for all
5. add code to let it login


```sql
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,

  name TEXT NOT NULL,
  ip TEXT
);

CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY,

  agent INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY(agent) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS formats (
  id INTEGER PRIMARY KEY,

  name TEXT NOT NULL,
);

-- FIXME ratings?
CREATE TABLE IF NOT EXISTS battles (
  id INTEGER PRIMARY KEY,

  controlled BOOLEAN NOT NULL,
  format INTEGER NOT NULL,
  p1 INTEGER NOT NULL,
  p2 INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  result INTEGER NOT NULL, -- -1 0 1
  rating BLOB NOT NULL, -- TODO ???

  FOREIGN KEY(p1) REFERENCES versions(id),
  FOREIGN KEY(p2) REFERENCES versions(id),
  FOREIGN KEY(format) REFERENCES formats(id),
);

-- TODO does # of games vs. each even matter, as opposed to determining what
-- will reduce deviation in rating? 
CREATE TABLE IF NOT EXISTS matchmaking (
  -- NB: guaranteee p1 < p2
  p1 INTEGER NOT NULL,
  p2 INTEGER NOT NULL,

  battles INTEGER NOT NULL,

  PRIMARY KEY (p1, p2),
  FOREIGN KEY(p1) REFERENCES versions(id),
  FOREIGN KEY(p2) REFERENCES versions(id)
);

-- historical ratings
CREATE TABLE IF NOT EXISTS ratings (
  date DATETIME NOT NULL,
  version INTEGER NOT NULL,
  rating BLOB NOT NULL, -- TODO

  PRIMARY KEY (date, version),
  FOREIGN KEY(version) REFERENCES versions(id),
);
```

CSPRNG random number stored in battles table = links games in a match, also determines team
selection (used to index into teams DB file stored on the controller box). Number given to agents
who can use it to consistently seed their PRNG if desired (how to get reproducible results - need to
make sure they can't infer battle seed from CSPRNG number)

P1 P2 in a match always initially determined by sort order of version id = if P1 < P2 then you know
it's game one as opposed to game 2

Game 2 uses exact same seed as game 1, so in theory if the players play identical it will be a draw
for the match

can run sim in controller for controlled (but not open) games = reduced load on server, but then
need to send logs etc so simpler to just do on server

---

goals of pokemon ai 
- present to smart person not involved in pokemon/ai why its interesting
- make it easy for players to be able to play against existing bots (all nicely packaged etc)
- make ranking bots easier/possible
- make people focus on specific problems

—-

disable pondering (time slicing = faux sequentializing the game = just takes twice as long)

only evaluate glicko period after both games in match accounted for glicko-2 with 10 games per
rating period to each
- need a table of just ratings period results, every day not long enough problem = ratings periods
then grow too large, ideal = ratings period after each each match (2 games for 2 players), problem =
all other players “decay”. worst case table is O(10*N versions), still pretty small, just do naive
solution. elo with fixed k = 20, no decary

Ratings period = when AVERAGE games for each player >= 10?

games (Not matches)

P1 P2 Result Seed = dont need ratings at all, link to replays

——

Leaderboard

Rank Name Elo Glicko-2 W L T (only ever updated after matches so will always be multiple of 2)

-> drill into agent = for each version show wlt against each opponent

**dual level table**

Rank NameANDVersion Elo Glicko-2 W L T
  - Opponent W L T + can click link to see games filtered to all though between this version and
    opponent

Chart Rank for each version over time (or over matches?) Rating for each version over time (or over
matches)

CAP at N = 30? 50? games per pair in order to not over test and heavily weight on early starting
conditions. when new bot gets added, round robin with each existing bot until has enough games (ie.
10) to be considered rated, then try to get another bot to N games, BUT want to avoid making others
decay from not being played!

bot with least games does round robin with other bots… BUT favor better bots. what is tradeoff
between exploitation and exploration?

goal = trending towards AVERAGE N (account for earlier versions having more games), also want min N.
two numbers = N0 is total number of games vs each and N1 is minimum number of games vs. any given
opponent, favor improving these numbers for the highest rated opponent first.


100 games A vs B C comes in, average games is (100+100+0)/3 = 66.6 min games is (100+0)/2 = 50 and 0

C needs games to improve its average N, should first play against stronger of A and B since theyre
tied on matchmaking metrics.

next = 204/3 = 68 is average but 102, 100, 2 so match up 2 and 100

***how to balance averages and min?***

Prioritize min first, so new bot will always play against best bot. Need some weighting of rating
and how far away from min (make exponentially bigger the further away from min), then just
prioritize less battles than average (but also weight by rating)
- at this point will be playing highest elo THAT IS STILL UNDER AVERAGE

——

Open = N games round robin for each player, top WLT record determines final tour winner

Rank Name (Version) W L T

how big should N (number of games between each player) be? 10? (aim for X <= 1 week, 24 hours? CPU
hours)

"generation 8"
- not guaranteed OU
- guaranteed = singles, species clause, 1000 turn limit, tours timer, sleep/freeze/desync/switch
  priority , evasion OHKO invulnerability