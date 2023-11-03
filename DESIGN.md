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

monitor = component on the docker server, sends heartbeat requests to sim and if disconnected for 15
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
controller
referee
judge
watchdog
launcher
monitor ——— best?
matchmaker
```

sim decides next round (always play 1 then kill then play swapped)
tells monitor to kill old participants and start next round with new pairing
round robins participants attempting to ensure balanced number of battles = naive
alternatively, matchmake based on (a) most uncertainity of rating (want balanced) and then number of battles (cant have one person have too many battles)
dont want glicko because decay doesnt make sense

**NEED BAYESELO WRAPPER**