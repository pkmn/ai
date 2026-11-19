import type * as sim from '@pkmn/sim';

import {toID} from '../static/util';

export const STARTING_BANK_SECONDS = 150;
export const STARTING_GRACE_SECONDS = 60;
export const MAX_TURN_SECONDS = 150;
export const MID_TURN_INCREMENT_SECONDS = 5;
export const SINGLES_INCREMENT_SECONDS = 10;
export const DOUBLES_INCREMENT_SECONDS = 25;
export const VGC_STARTING_BANK_SECONDS = 420;
export const VGC_GRACE_SECONDS = 90;
export const VGC_MAX_TURN_SECONDS = 55;
export const VGC_MAX_FIRST_TURN_SECONDS = 90;

export interface TimerSettings {
  startingSeconds: number;
  graceSeconds: number;
  addPerTurnSeconds: number;
  midTurnIncrementSeconds: number;
  maxPerTurnSeconds: number;
  maxFirstTurnSeconds: number;
  timeoutAutoChoose: boolean;
  accelerate: boolean;
}

type FormatListArg = Parameters<typeof sim.Dex.formats.extend>[0];

export function configureSimMod(
  simMod: typeof sim,
  mods: {
    champions?: unknown;
    championsregmb?: unknown;
    teamGenerators?: unknown;
  }
) {
  for (const modName of ['champions', 'championsregmb'] as const) {
    const mod = mods[modName];
    if (!mod) continue;
    simMod.Dex.mod(modName, mod);
    const withFormats = mod as {Formats?: FormatListArg};
    if (withFormats.Formats) {
      simMod.Dex.formats.extend(withFormats.Formats);
    }
  }
  if (mods.teamGenerators) {
    simMod.Teams.setGeneratorFactory(
      mods.teamGenerators as Parameters<typeof simMod.Teams.setGeneratorFactory>[0]
    );
  }
}

// Resolves a format ID and optional custom rules for headless Arena/Tournament play:
//   - By default (VGC ladder and Closed Team Sheets tournaments), removes upstream's interactive
//     `Open Team Sheets` rule (`!Open Team Sheets`) so `|showteam|` is not broadcast and
//     `|uhtml|otsrequest|` is not emitted.
//   - When a tournament explicitly requests `Open Team Sheets` or `Force Open Team Sheets` via
//     `customRules` (or inline `@@@` rules), maps `Open Team Sheets` to `Force Open Team Sheets`
//     so `@pkmn/sim` broadcasts `|showteam|p1|` and `|showteam|p2|` automatically at Team Preview.
export function resolveArenaFormatIdWithSim(
  simMod: typeof sim,
  format: string
): string {
  const [baseFormat, inlineRaw] = format.split('@@@');
  const inlineRules = inlineRaw
    ? inlineRaw.split(',').map(r => r.trim()).filter(Boolean)
    : [];
  const rules = inlineRules.map(r => {
    const id = toID(r);
    if (!r.startsWith('!')) {
      if (id === 'openteamsheets') return 'Force Open Team Sheets';
      if (id === 'bestof3' || id === 'bo3') return 'Best of = 3';
    }
    return r;
  });

  const wantsOts = rules.some(r => {
    const id = toID(r);
    return !r.startsWith('!') && (id === 'openteamsheets' || id === 'forceopenteamsheets');
  });

  if (wantsOts) {
    return `${baseFormat}@@@${rules.join(',')}`;
  }

  const resolved = simMod.Dex.formats.get(baseFormat);
  const baseHasInteractiveOts =
    resolved.exists &&
    Array.isArray(resolved.ruleset) &&
    resolved.ruleset.some(r => toID(r) === 'openteamsheets') &&
    !resolved.ruleset.some(r => toID(r) === 'forceopenteamsheets');

  if (baseHasInteractiveOts && !rules.some(r => toID(r) === 'openteamsheets')) {
    rules.push('!Open Team Sheets');
  }

  return rules.length > 0 ? `${baseFormat}@@@${rules.join(',')}` : baseFormat;
}

export function sampleRandomPairWithSim(
  simMod: typeof sim,
  format: string,
  seed1: sim.PRNGSeed,
  seed2: sim.PRNGSeed
): {t1Packed: string; t2Packed: string} {
  const cleanFormat = toID(format);
  const t1 = simMod.Teams.generate(cleanFormat, {seed: seed1});
  const t2 = simMod.Teams.generate(cleanFormat, {seed: seed2});
  return {
    t1Packed: simMod.Teams.pack(t1),
    t2Packed: simMod.Teams.pack(t2),
  };
}

// Matches Pokémon Showdown's `RoomBattleTimer` defaults + `RuleTable.timer` overrides
// (`server/room-battle.ts`), omitting WebSocket disconnect timers (`dcTimer`/`dcTimerBank`).
export function resolveTimerSettingsWithSim(
  simMod: typeof sim,
  format: string
): TimerSettings {
  const resolved = simMod.Dex.formats.get(format);
  const ruleTable = simMod.Dex.formats.getRuleTable(resolved);
  const raw = ruleTable.timer?.[0];
  const hasLongTurns = resolved.exists && resolved.gameType !== 'singles';
  const addPerTurnSeconds =
    raw?.addPerTurn ?? (hasLongTurns ? DOUBLES_INCREMENT_SECONDS : SINGLES_INCREMENT_SECONDS);
  const maxPerTurnRaw = raw?.maxPerTurn ?? MAX_TURN_SECONDS;
  const maxPerTurnSeconds = maxPerTurnRaw > 0 ? maxPerTurnRaw : Infinity;
  const maxFirstTurnRaw = raw?.maxFirstTurn ?? MAX_TURN_SECONDS;
  const maxFirstTurnSeconds = maxFirstTurnRaw > 0 ? maxFirstTurnRaw : maxPerTurnSeconds;
  return {
    startingSeconds: raw?.starting ?? STARTING_BANK_SECONDS,
    graceSeconds: raw?.grace ?? STARTING_GRACE_SECONDS,
    addPerTurnSeconds,
    midTurnIncrementSeconds: Math.min(Math.max(0, addPerTurnSeconds), MID_TURN_INCREMENT_SECONDS),
    maxPerTurnSeconds,
    maxFirstTurnSeconds,
    timeoutAutoChoose: raw?.timeoutAutoChoose ?? false,
    accelerate: raw?.accelerate ?? !raw,
  };
}
