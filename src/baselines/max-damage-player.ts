import {Choice, Player} from './player';

// TODO MDP needs a "foe" variable it tracks, need a dummy method on Player for
// cmds
export class MaxDamagePlayer extends Player {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  choose<C extends Choice>(choices: C[]): C {
    throw new Error('Method not implemented');
  }
}
