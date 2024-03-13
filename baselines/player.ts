import {Battle} from '@pkmn/client';
import {Generations} from '@pkmn/data';
import {Request} from '@pkmn/protocol';

export namespace Choice {
  export interface Team {
    type: 'team';
    slots: number[];
  }

  export interface Switch {
    type: 'switch';
    slot: number;
  }

  export interface Move {
    type: 'move';
    slot: number;
    event?: 'mega' | 'zmove' | 'ultra' | 'dynamax' | 'terastallize';
  }
}

export type Choice = Choice.Move | Choice.Switch | Choice.Team;

export type Random = (min?: number, max?: number) => number;

export abstract class Player {
  battle: Battle;

  choice: string;

  constructor(gens: Generations) {
    this.battle = new Battle(gens);
    this.choice = 'pass';
  }

  accept(chunk: string) {
    let request = false;
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('|')) continue;
      const index = line.indexOf('|', 1);
      const cmd = line.slice(1, index);
      const rest = line.slice(index + 1);
      if (cmd === 'request') request = true;
      if (cmd === 'error') return this.onError(new Error(rest)); // FIXME
      this.battle.add(line);
    }
    this.battle.update();
    if (request) this.choice = this.onRequest(this.battle.request!);
  }

  onRequest(request: Request) {
    // WaitRequest
    if (request.requestType === 'wait') return '';

    // TeamRequest
    if (request.requestType === 'team') {
      let illusion = false;
      for (const pokemon of request.side.pokemon) {
        if (pokemon.ability === 'illusion') {
          illusion = true;
          break;
        }
      }

      // Optimize the standard case, otherwise fall back on slow permutation logic
      const choices: Choice.Team[] = request.side.pokemon.length === 6
        ? illusion ? ILLUSION : this.battle.teamPreviewCount === 4 ? DOUBLES : SINGLES
        : shrink(
          permutations(SLOTS.slice(0, request.side.pokemon.length)),
          this.battle.teamPreviewCount
        );
      return `team ${this.choose(choices).slots.join('')}`;
    }

    const pokemon = request.side.pokemon;

    // SwitchRequest
    if (request.requestType === 'switch') {
      const choices: Choice.Switch[] = [];
      for (let slot = 2; slot <= pokemon.length; slot++) {
        if (!pokemon[slot - 1]) continue;
        // not fainted or fainted and using Revival Blessing
        if (!(+!!pokemon[0].reviving ^ +!pokemon[slot - 1].condition.endsWith(' fnt'))) continue;
        choices.push({type: 'switch', slot});
      }
      return choices.length === 0 ? 'pass' : `switch ${this.choose(choices).slot}`;
    }

    // MoveRequest
    const active = request.active[0]!;
    const choices: (Choice.Switch | Choice.Move)[] = [];

    if (!active.trapped) {
      for (let slot = 2; slot <= pokemon.length; slot++) {
        if (!pokemon[slot - 1] || pokemon[slot - 1].active) continue;
        if (pokemon[slot - 1].condition.endsWith(' fnt')) continue;
        choices.push({type: 'switch', slot});
      }
    }

    const event = active.canMegaEvo ? 'mega'
      : active.canUltraBurst ? 'ultra'
      : active.canDynamax ? 'dynamax'
      : active.canTerastallize ? 'terastallize'
      : undefined;

    // not allowed to use regular moves if already dynamaxed
    const dynamaxed = !active.canDynamax && active.maxMoves;
    if (!dynamaxed) {
      for (let slot = 1; slot <= active.moves.length; slot++) {
        if (active.moves[slot - 1].disabled) continue;
        choices.push({type: 'move', slot});
        if (event) choices.push({type: 'move', slot, event});
      }
    }
    if (active.zMoves) {
      for (let slot = 1; slot <= active.zMoves.length; slot++) {
        choices.push({type: 'move', slot, event: 'zmove'});
      }
    }
    if (active.maxMoves) {
      for (let slot = 1; slot <= active.maxMoves.length; slot++) {
        choices.push({type: 'move', slot});
        if (event) choices.push({type: 'move', slot, event});
      }
    }

    const choice = this.choose(choices);
    if (choice.type === 'switch') return `switch ${choice.slot}`;
    return choice.event ? `move ${choice.slot} ${choice.event}` : `move ${choice.slot}`;
  }

  onError(error: Error) {
    if (error.message.startsWith('[Unavailable choice]')) return;
    throw error;
  }

  abstract choose<C extends Choice>(choices: C[]): C;
}

const SLOTS = [1, 2, 3, 4, 5, 6];
const PERMUTATIONS = permutations(SLOTS.slice());
const ILLUSION: Choice.Team[] = PERMUTATIONS.map(slots => ({type: 'team', slots}));
const DOUBLES: Choice.Team[] = shrink(PERMUTATIONS, 4);
const SINGLES: Choice.Team[] = SLOTS.map(order => ({type: 'team', slots: [order]}));

function permutations<T>(xs: T[]) {
  const length = xs.length;
  const result = [xs.slice()];
  const c: number[] = new Array(length).fill(0);

  let i = 1, k: number, p: T;
  while (i < length) {
    if (c[i] < i) {
      k = i % 2 && c[i];
      p = xs[i];
      xs[i] = xs[k];
      xs[k] = p;
      ++c[i];
      i = 1;
      result.push(xs.slice());
    } else {
      c[i] = 0;
      ++i;
    }
  }
  return result;
}

// Terrible approach, but not worth optimizing
function shrink(ps: number[][], n: number) {
  const m = new Map<string, Choice.Team>();
  for (const p of ps) {
    const slots = p.slice(0, n);
    m.set(slots.join(), {type: 'team', slots});
  }
  return Array.from(m.values());
}
