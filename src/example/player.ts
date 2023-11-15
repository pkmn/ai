import {MoveName, PokemonDetails, PokemonHPStatus, PokemonIdent} from '@pkmn/protocol';
import {ID, MoveTarget, SideID, StatsTable, TypeName} from '@pkmn/types';

export type Request = MoveRequest | SwitchRequest | TeamRequest | WaitRequest;

export interface MoveRequest {
  side: Request.SideInfo;
  active: Array<Request.ActivePokemon | null>;
  noCancel?: boolean;
}

export interface SwitchRequest {
  side: Request.SideInfo;
  forceSwitch: [true] & boolean[];
  noCancel?: boolean;
}

export interface TeamRequest {
  teamPreview: true;
  side: Request.SideInfo;
  maxTeamSize?: number;
  noCancel?: boolean;
}

export interface WaitRequest {
  wait: true;
  side: undefined;
  noCancel?: boolean;
}

export namespace Request {
  export interface SideInfo {
    name: string;
    id: SideID;
    pokemon: Pokemon[];
  }

  export interface ActivePokemon {
    moves: Array<{
      move: MoveName;
      pp: number;
      maxpp: number;
      target: MoveTarget;
      disabled?: boolean;
    }>;
    maxMoves?: {
      gigantamax?: boolean;
      maxMoves: Array<{
        move: string;
        target: MoveTarget;
        disabled?: boolean;
      }>;
    };
    canZMove?: Array<{
      move: MoveName;
      target: MoveTarget;
    } | null>;
    canDynamax?: boolean;
    canMegaEvo?: boolean;
    canUltraBurst?: boolean;
    canTerastallize?: string;
    trapped?: boolean;
    maybeTrapped?: boolean;
    maybeDisabled?: boolean;
    fainted?: boolean;
  }

  export interface Pokemon {
    active?: boolean;
    details: PokemonDetails;
    ident: PokemonIdent;
    pokeball: ID;
    ability?: ID;
    baseAbility?: ID;
    condition: PokemonHPStatus;
    item: ID;
    moves: ID[];
    stats: Omit<StatsTable, 'hp'>;
    commanding?: boolean;
    reviving?: boolean;
    teraType?: TypeName;
  }
}

export namespace Choice {
  export interface Team{
    type: 'team';
    slot: number;
  }

  export interface Switch {
    type: 'switch';
    slot: number;
  }

  export interface Move{
    type: 'move';
    slot: number;
    event?: 'mega' | 'zmove' | 'ultra' | 'dynamax' | 'terastallize';
  }
}
export type Choice = Choice.Move | Choice.Switch| Choice.Team;

export abstract class Player {
  accept(chunk: string) {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('|')) continue;
      const index = line.indexOf('|', 1);
      const cmd = line.slice(1, index);
      const rest = line.slice(index + 1);
      if (cmd === 'request') return this.onRequest(JSON.parse(rest));
      if (cmd === 'error') return this.onError(new Error(rest));
    }
  }

  onRequest(request: Request) {
    // WaitRequest
    if ('wait' in request) return [];

    // TeamRequest
    if ('teamPreview' in request) {
    // BUG: technically more permutations are relevant for Illusion
      const choices: Choice.Team[] = [];
      for (let slot = 1; slot < request.side.pokemon.length; slot++) {
        choices.push({type: 'team', slot});
      }
      return `team ${this.choose(choices).slot}`;
    }

    const pokemon = request.side.pokemon;

    // SwitchRequest
    if ('forceSwitch' in request) {
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
    if (active.canZMove) {
      for (let slot = 1; slot <= active.canZMove.length; slot++) {
        choices.push({type: 'move', slot, event: 'zmove'});
      }
    }
    if (active.maxMoves) {
      for (let slot = 1; slot <= active.maxMoves.maxMoves.length; slot++) {
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
