import {PokemonSet} from '@pkmn/types';

import {Choice, Player} from './player';

export class MaxDamagePlayer extends Player {
  private readonly team?: PokemonSet[];

  constructor(team?: PokemonSet[]) {
    super();
    this.team = team;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  choose<C extends Choice>(choices: C[]): C {
    throw new Error('Method not implemented');
  }
}
