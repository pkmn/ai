import {Generations} from '@pkmn/data';

import {Choice, Player, Random} from './player';

export type Option = {choose: number} | {consider: number};
const options = ['switch', 'mega', 'ultra', 'zmove', 'dynamax', 'terastallize'] as const;

export namespace RandomPlayer {
  export type Config = {[option in typeof options[number]]: Option};
}

export class RandomPlayer extends Player {
  private readonly random: Random;
  private readonly config: RandomPlayer.Config;

  static CONFIG: RandomPlayer.Config = {
    switch: {consider: 0},
    mega: {choose: 1},
    ultra: {choose: 1},
    zmove: {consider: 1},
    dynamax: {consider: 1},
    terastallize: {consider: 1},
  };

  constructor(gens: Generations, random: Random, config: Partial<RandomPlayer.Config> = {}) {
    super(gens);
    this.random = random;
    this.config = {...RandomPlayer.CONFIG, ...config};
  }

  choose<C extends Choice>(choices: C[]): C {
    return this.sample(this.filter(choices)) as C;
  }

  filter<C extends Choice>(choices: C[]) {
    const partitioned = {
      team: [] as Choice.Team[],
      switch: [] as Choice.Switch[],
      move: [] as Choice.Move[],
      mega: [] as Choice.Move[],
      ultra: [] as Choice.Move[],
      zmove: [] as Choice.Move[],
      dynamax: [] as Choice.Move[],
      terastallize: [] as Choice.Move[],
    };

    let moves = false;
    for (const choice of choices) {
      if (choice.type !== 'move') {
        (partitioned[choice.type] as (Choice.Team | Choice.Switch)[]).push(choice);
      } else if (choice.event) {
        moves = true;
        partitioned[choice.event].push(choice);
      } else {
        moves = true;
        partitioned.move.push(choice);
      }
    }

    if (partitioned.team.length) return partitioned.team as C[];
    if (!moves) return partitioned.switch as C[];

    const consider: Choice[] = partitioned.move;
    for (const option of options) {
      if (partitioned[option].length) continue;
      const config = this.config[option];
      if ('consider' in config) {
        if (this.select(config.consider)) consider.push(...partitioned[option]);
      } else if (partitioned[option].length) {
        if (this.select(config.choose)) return partitioned[option] as C[];
      }
    }

    return consider;
  }

  select(n: number) {
    return n === 0 ? false : n === 1 ? true : this.random() < n;
  }

  sample<T>(xs: T[]) {
    if (!xs.length) throw new RangeError('Attempt to sample from empty list');
    return xs.length === 1 ? xs[0] : xs[this.random(xs.length)];
  }
}
