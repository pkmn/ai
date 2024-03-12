import {Generations} from '@pkmn/data';

import {Choice, Player} from './player';
import {Option, Random, RandomPlayer} from './random-player';

export namespace RandomMaxDamagePlayer {
  export type Config = RandomPlayer.Config & {
    max: Option;
    killer: Option;
  };
}

// TODO RMDP = MDP subclass that borrows functions from RP. If move is overkill
// or within some percent of others then sample. Decide between moves and switch
// how? Possibly if no existing move is very good? Also add killer move
// heuristic?
export class RandomMaxDamagePlayer extends Player {
  private readonly random: Random;
  private readonly config: RandomPlayer.Config;
  private readonly threshold: number;

  static CONFIG: RandomMaxDamagePlayer.Config = {
    ...RandomPlayer.CONFIG,
    max: {choose: 1},
    killer: {choose: 1},
  };

  constructor(
    gens: Generations,
    random: Random,
    config: Partial<RandomMaxDamagePlayer.Config> = {},
    threshold = 0.05,
  ) {
    super(gens);
    this.random = random;
    this.config = {...RandomPlayer.CONFIG, ...config};
    this.threshold = threshold;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  choose<C extends Choice>(choices: C[]): C {
    throw new Error('Method not implemented');
  }
}
