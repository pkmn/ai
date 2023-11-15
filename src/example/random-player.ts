import {Choice, Player} from './player';

type Option = {choose: number} | {consider: number};
const options = ['switch', 'mega', 'ultra', 'zmove', 'dynamax', 'terastallize'] as const;

export namespace RandomPlayer {
  export type Config = {[option in typeof options[number]]: Option};
}

export type Random = (min?: number, max?: number) => number;

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

  constructor(random: Random, config: Partial<RandomPlayer.Config> = {}) {
    super();
    this.random = random;
    this.config = {...RandomPlayer.CONFIG, ...config};
  }

  choose<C extends Choice>(choices: C[]): C {
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

    if (partitioned.team.length) {
      return partitioned.team[this.random(partitioned.team.length)] as C;
    } else if (!moves) {
      return partitioned.switch[this.random(partitioned.switch.length)] as C;
    }

    const consider: Choice[] = partitioned.move;
    for (const option of options) {
      if (partitioned[option].length) continue;
      const config = this.config[option];
      if ('consider' in config) {
        if (config.consider && (config.consider === 1 || this.random() < config.consider)) {
          consider.push(...partitioned[option]);
        }
      } else {
        if (config.choose && (config.choose === 1 || this.random() < config.choose)) {
          return partitioned[option][this.random(partitioned[option].length)] as C;
        }
      }
    }

    return consider[this.random(consider.length)] as C;
  }
}
