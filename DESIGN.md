TODO

- motivation/goals
- isolation/system details (gpu, cpu, readonly etc)
- design of sim server
- design of site
- access to grabbing data
  - teams (test data as opposed to training data)
  - stats
- reasoning behind rules
- link to alternative tournament software (leftovers, pokeenv, vgc, showdown ai)
  + CCRL & TCEC & CPW https://aipokertutorial.com/

TODO need some way to let users register releases AND link log fetching data

controller = component on the docker server, sends heartbeat requests to sim and if disconnected for
15 minutes sim and/or helper sends message to discord server

```
docker run
—expose 8000
—read-only
—memory 8 —memory-swap 8
—cpuset-cpus 

0,1,2,3,24,25,26,27
4,5,6,7,28,29,30,31
—-
8,9,10,11,32,33,34,35
12,13,14,15,36,37,38,39
16,17,18,19,40,41,42,43
20,21,22,23,44,45,46,47
```

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

```
arena
watcher
helper
scheduler
manager
controller ——— best because environemnt is called "Controlled"
referee
judge
watchdog
launcher
monitor 
matchmaker
```

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
