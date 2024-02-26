
import {Battle} from '@pkmn/client';
import {Generations} from '@pkmn/data';
import {Request} from '@pkmn/protocol';

export namespace Choice {
  export interface Team {
    type: 'team';
    slot: number;
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
    // BUG: technically more permutations are relevant for Illusion
      const choices: Choice.Team[] = [];
      for (let slot = 1; slot < request.side.pokemon.length; slot++) {
        choices.push({type: 'team', slot});
      }
      return `team ${this.choose(choices).slot}`;
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
