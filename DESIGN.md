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
  + CCRL & TCEC & CPW

TODO need some way to let users register releases AND link log fetching data

controller = component on the docker server, sends heartbeat requests to sim and if disconnected for 15
minutes sim and/or helper sends message to discord server

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

sim decides next round (always play 1 then kill then play swapped)
tells controller to kill old participants and start next round with new pairing
round robins participants attempting to ensure balanced number of battles = naive
alternatively, matchmake based on (a) most uncertainity of rating (want balanced) and then number of battles (cant have one person have too many battles)
dont want glicko because decay doesnt make sense

**NEED BAYESELO WRAPPER**

### `/leaderboard`

Leaderboard/Tournament
Open/Controlled
Generation N

History
= games per month (links to github) = 7z each days worth of logs and tar the formats and months


click bot = has same summary info from projects.md (need to share rendering logic… in server! = prerender snippet)
show matchup vs other bots
show matchups vs past versions
links to all replays

only show dominant version of each bot (might not be most recent)
keep dominant and most recent in the pool, other bots retired

append to csv file with a record from each game, can use this to compute bots rating after each day as well. looks a lot like a database…
= technically an index, can also use to figure out next battle ID. can be restored from battles (pre write tool to do this)

need to prerender rating graphs?? how much of tables can be prerendered?

problem = replays need to be obfsucated into spectator replays because otherwise leaks teams (teams effectively get leaked anyway because k anonymity cant be enforced over so many battles) = can only share replays between “seasons” (and still want pruned version)
- log @pkmn/sim version so recreatable

want everyone to play at least a round with the same team, = need to then track who used what from teams DB. instead can just assure each team gets used twice then moved on (limits data and lets us upload spectator replays more quickly. need large team pool to remove possibility of dupes)

OPTION = just always generate all tables statically (what happens if fuck up?) = uses disk space, but if need to precompute anyway also uses disk.
- index needs updating, pages for both bots needs updating
nginx does all serving (and set up aliases there), no need for polka

  <script async src="https://unpkg.com/mathjax@3.2.2/es5/tex-mml-chtml.js"></script>

TESTING LEVELS

1. server itself populates leaderboard from random procedure
2. watchdog randomly decides W/L/T result, doesnt bother launching bots
3. watchdog starts up RandomPlayer(N) for various N to get lots of quick battles

“tables”
- users (read in config with agents/names/IPs etc)
- matchmaking (matrix of name-version vs. name-version num battles)
- ratings table of everyones ratings and total battles?

---

start needs to start websocket server (which also periodically builds files) as well so remove http-server

static src/tools/seed (simulate - flag to determine at what level to prosuce) produce leaderboaed info after every battle
- run job to preseed https://github.com/pkmn/PKMN/blob/main/src/db/seed.ts

need to render replays on the fly
- strip data
- provide option of html/json/.log txt

use polka for this (and static if NODE-ENV is not prod = add node env is development to bashrc)