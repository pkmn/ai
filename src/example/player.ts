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

export type Choice = MoveChoice | SwitchChoice | TeamChoice;

interface MoveChoice {
  type: 'move';
  choice: string;
  extra?: boolean;
}

interface SwitchChoice {
  type: 'switch';
  slot: number;
}

interface TeamChoice {
  type: 'team';
  slot: number;
}

export abstract class Player {
  accept(chunk: string) {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('|')) continue;
      const [cmd, rest] = splitFirst(line.slice(1), '|');
      if (cmd === 'request') return this.onRequest(JSON.parse(rest));
      if (cmd === 'error') return this.onError(new Error(rest));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onRequest(request: Request) {
    throw new Error('Method not implemented.');
  }

  onError(error: Error) {
    if (error.message.startsWith('[Unavailable choice]')) return;
    throw error;
  }

  abstract choose(choices: Choice[][]): Choice[];
}

function splitFirst(str: string, delimiter: string, limit = 1) {
  const splitStr: string[] = [];
  while (splitStr.length < limit) {
    const delimiterIndex = str.indexOf(delimiter);
    if (delimiterIndex >= 0) {
      splitStr.push(str.slice(0, delimiterIndex));
      str = str.slice(delimiterIndex + delimiter.length);
    } else {
      splitStr.push(str);
      str = '';
    }
  }
  splitStr.push(str);
  return splitStr;
}
