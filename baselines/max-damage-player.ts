import {Generations} from '@pkmn/data';

import {Choice, Player, Random} from './player';

// - If can move, sort moves based value where value is computed based on type_fn
// - z/ultra/mega are all simply applied as part of the type_fn
// - only uses status or switches if no other option (random or order if no random)
// - team preview based on average performance
// - force switch based on best overall value
// - types:
//  - base-power: JUST base power
//  - simplified: base power + type effectivness + boosts + damage formula
//  - calculated: average roll
//  - expected: average roll + accuracy + crit rate
//  - simulated: run simulation and inspect damage (could be miss etc)
export namespace MaxDamagePlayer {
  export interface Config {
    type: 'base-power' | 'simplified' | 'calculated' | 'simulated' | 'expected';
    random?: Random; // status and switch
  }
}

export class MaxDamagePlayer extends Player {
  readonly config: MaxDamagePlayer.Config;

  static CONFIG: MaxDamagePlayer.Config = {
    type: 'expected',
  };

  constructor(gens: Generations, config: Partial<MaxDamagePlayer.Config> = {}) {
    super(gens);
    this.config = {...MaxDamagePlayer.CONFIG, ...config};
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  choose<C extends Choice>(choices: C[]): C {
    throw new Error('Method not implemented');
  }
}
