import {Choice, Player} from './player';

export type Random = (min?: number, max?: number) => number;

export namespace RandomPlayer {
  export interface Config {
    'switch'?: {choose: number} | {consider: number};
    mega?: {choose: number} | {consider: number};
    zmove?: {choose: number} | {consider: number};
    dynamax?: {choose: number} | {consider: number};
    terastallize?: {choose: number} | {consider: number};
  }
}

export class RandomPlayer extends Player {
  private readonly random: Random;
  private readonly config: RandomPlayer.Config;

  constructor(random: Random, config?: RandomPlayer.Config) {
    super();
    this.random = random;
    this.config = config ?? {};
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  choose(choices: Choice[][]): Choice[] {
    throw new Error('Method not implemented.');
  }
}
