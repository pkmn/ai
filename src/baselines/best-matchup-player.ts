import {Generations} from '@pkmn/data';

import {MaxDamagePlayer} from './max-damage-player';
import {Choice} from './player';

// "switch if can take expected hit and KO faster than can be KOed"
// Requires usage statistics to know what the opponent can do!

export namespace BestMatchupPlayer {
  export interface Config extends MaxDamagePlayer.Config {
    TODO: number;
  }
}

export class BestMatchupPlayer extends MaxDamagePlayer {
  readonly config: BestMatchupPlayer.Config;

  static CONFIG: BestMatchupPlayer.Config = {
    ...MaxDamagePlayer.CONFIG,
    TODO: 0,
  };

  constructor(gens: Generations, config: Partial<BestMatchupPlayer.Config> = {}) {
    super(gens);
    this.config = {...BestMatchupPlayer.CONFIG, ...config};
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  choose<C extends Choice>(choices: C[]): C {
    throw new Error('Method not implemented');
  }
}
