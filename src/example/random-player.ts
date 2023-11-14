import {Choice, Player} from './player';

export type Random = (min?: number, max?: number) => number;

export namespace RandomPlayer {
  export interface Config {
    switch: {choose: number} | {consider: number};
    mega: {choose: number} | {consider: number};
    zmove: {choose: number} | {consider: number};
    dynamax: {choose: number} | {consider: number};
    terastallize: {choose: number} | {consider: number};
  }
}

export class RandomPlayer extends Player {
  private readonly random: Random;
  private readonly config: RandomPlayer.Config;

  static CONFIG: RandomPlayer.Config = {
    switch: {consider: 0},
    mega: {choose: 1},
    zmove: {consider: 1},
    dynamax: {consider: 1},
    terastallize: {consider: 1},
  };

  constructor(random: Random, config: Partial<RandomPlayer.Config> = {}) {
    super();
    this.random = random;
    this.config = {...RandomPlayer.CONFIG, ...config};
  }

  choose(choices: Choice[]): Choice {
    const partitioned = {
      team: [] as Choice[],
      switch: [] as Choice[],
      move: [] as Choice[],
      mega: [] as Choice[],
      zmove: [] as Choice[],
      dynamax: [] as Choice[],
      terastallize: [] as Choice[],
    };

    let moves = false;
    for (const choice of choices) {
      if (choice.type !== 'move') {
        partitioned[choice.type].push(choice);
      } else if (choice.extra) {
        moves = true;
        partitioned[choice.extra].push(choice);
      } else {
        moves = true;
        partitioned.move.push(choice);
      }
    }

    if (partitioned.team.length) {
      return partitioned.team[this.random(partitioned.team.length)];
    } else if (!moves) {
      return partitioned.switch[this.random(partitioned.switch.length)];
    }

    const consider: Choice[] = partitioned.move;
    for (const option of ['switch', 'mega', 'zmove', 'dynamax', 'terastallize'] as const) {
      if (partitioned[option].length) continue;
      const config = this.config[option];
      if ('consider' in config) {
        if (config.consider && (config.consider === 1 || this.random() < config.consider)) {
          consider.push(...partitioned[option]);
        }
      } else {
        if (config.choose && (config.choose === 1 || this.random() < config.choose)) {
          return partitioned[option][this.random(partitioned[option].length)];
        }
      }
    }

    return consider[this.random(consider.length)];
  }
}
