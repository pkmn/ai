// Per-turn policy logging specification, choice canonicalizer, chat elision filter, and smoke-test
// verifier for pkmn.ai Arena agents.
//
// Why this exists:
//   1. Moderation & cheating detection: Recording every Arena agent's full action-probability
//      distribution (`Record<CanonicalChoice, Probability>`) at each decision point lets Smogon /
//      Pokémon Showdown moderators compare a suspected human cheater's move sequence against the
//      exact per-turn posteriors of strong reference agents.
//   2. Post-retirement debugging: When a seasonal `pools` ladder retires (or a tournament finishes)
//      and full battle logs are published, authors can inspect `|c|` policy lines alongside turns.
//   3. Zero covert communication: All chat/HTML/join lines (`|c|`, `|c:|`, `|chat|`, `|raw|`,
//      `|html|`, `|uhtml|`) are stripped from player `stdin` streams so agents can never exchange
//      signals during a game; plain chat lines are written exclusively to the omniscient log.

export const POLICY_SUM_TOLERANCE = 1e-3;

export interface SidePokemonRequest {
  ident: string;
  details: string;
  condition: string;
  active?: boolean;
  stats?: Record<string, number>;
  moves?: string[];
  baseAbility?: string;
  item?: string;
  pokeball?: string;
  ability?: string;
  commanding?: boolean;
  reviving?: boolean;
  teraType?: string;
  terastallized?: string;
}

export interface MoveSlotRequest {
  move: string;
  id: string;
  pp?: number;
  maxpp?: number;
  target?: string;
  disabled?: boolean | string;
}

export interface ActivePokemonRequest {
  moves: MoveSlotRequest[];
  trapped?: boolean;
  maybeTrapped?: boolean;
  maybeDisabled?: boolean;
  maybeLocked?: boolean;
  canMegaEvo?: boolean;
  canMegaEvoX?: boolean;
  canMegaEvoY?: boolean;
  canUltraBurst?: boolean;
  canZMove?: Array<{move: string; target?: string} | null>;
  canDynamax?: boolean;
  maxMoves?: {
    maxMoves: Array<{move: string; target?: string; disabled?: boolean}>;
    gigantamax?: string;
  };
  canTerastallize?: string;
}

export interface BattleRequest {
  wait?: boolean;
  teamPreview?: boolean;
  maxChosenTeamSize?: number;
  forceSwitch?: boolean[];
  active?: Array<ActivePokemonRequest | null>;
  noCancel?: boolean;
  update?: boolean;
  side: {
    name: string;
    id: 'p1' | 'p2' | 'p3' | 'p4';
    pokemon: SidePokemonRequest[];
  };
}

export interface LegalChoiceSets {
  // Core choices expected to be covered by any compliant agent on this `|request|`.
  core: string[];
  // Superset of all syntactically & rules-legal canonical choices (e.g. including targeting one's
  // own ally with a `'normal'`-target move in Doubles).
  all: string[];
}

export type ParsedAgentStdout = {kind: 'chat'; message: string} | {kind: 'choice'; choice: string};

export interface PolicyValidationResult {
  ok: boolean;
  error?: string;
  // Normalized map from canonical choice string -> probability in [0, 1].
  normalized?: Record<string, number>;
  compactJson?: string;
}

const CHOOSABLE_TARGETS = new Set([
  'normal',
  'any',
  'adjacentAlly',
  'adjacentAllyOrSelf',
  'adjacentFoe',
]);

const ELIDED_PLAYER_PREFIXES = [
  '|c|',
  '|c:|',
  '|chat|',
  '|raw|',
  '|html|',
  '|uhtml|',
  '|uhtmlchange|',
  '|debug|',
  '|j|',
  '|J|',
  '|l|',
  '|L|',
  '|n|',
  '|N|',
];

const GIMMICK_ALIASES: Record<string, string> = {
  mega: 'mega',
  megaevo: 'mega',
  megax: 'megax',
  megay: 'megay',
  ultra: 'ultra',
  ultraburst: 'ultra',
  zmove: 'zmove',
  dynamax: 'dynamax',
  gigantamax: 'dynamax',
  max: 'dynamax',
  terastallize: 'terastallize',
  terastal: 'terastallize',
};

const BARE_CHOICE_KEYWORDS = new Set([
  'pass',
  'skip',
  'shift',
  'default',
  'auto',
  'recharge',
  'undo',
]);

const toChoiceId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

function isFainted(p: SidePokemonRequest | undefined): boolean {
  if (!p) return true;
  return p.condition === '0 fnt' || p.condition.endsWith(' fnt') || p.condition.startsWith('0/');
}

function isMoveDisabled(m: MoveSlotRequest): boolean {
  if (m.pp === 0) return true;
  if (m.disabled === true) return true;
  if (typeof m.disabled === 'string' && m.disabled !== '') return true;
  return false;
}

function isBareSimulatorChoice(body: string): boolean {
  if (body.startsWith('{') || body.startsWith('[')) return false;
  if (/^[1-9][0-9,\s]*$/.test(body)) return true;
  const parts = body.split(',');
  if (parts.length === 0 || parts.length > 3) return false;
  for (const rawPart of parts) {
    const part = rawPart.trim().toLowerCase();
    if (!part) return false;
    if (BARE_CHOICE_KEYWORDS.has(part)) continue;
    if (/^(?:move|switch)\s+\S/.test(part)) continue;
    if (/^team(?:\s+\S|[1-9])/.test(part)) continue;
    return false;
  }
  return true;
}

// Parses a single stdout line from an Arena agent into either a Showdown simulator choice string
// or a plain unprefixed chat line (matching Pokémon Showdown's room protocol where unprefixed text
// is chat and `/choose ...` or bare `move`/`switch`/`team` commands are simulator actions).
export function parseAgentStdoutLine(rawLine: string): ParsedAgentStdout | undefined {
  const trimmed = rawLine.replace(/\r$/, '').trim();
  if (!trimmed) return undefined;

  // Strip optional leading room prefix `|<room>|` or `|` for agents reusing a PS client adapter.
  let body = trimmed;
  if (body.startsWith('|')) {
    const secondPipe = body.indexOf('|', 1);
    body = secondPipe >= 0 && body.slice(1, secondPipe).startsWith('battle-')
      ? body.slice(secondPipe + 1).trim()
      : body.slice(1).trim();
  }
  if (!body) return undefined;

  if (body.startsWith('/choose ')) {
    const choice = body.slice(8).trim();
    return choice ? {kind: 'choice', choice} : undefined;
  }
  if (body.startsWith('/team ')) {
    const rest = body.slice(6).trim();
    return rest ? {kind: 'choice', choice: `team ${rest}`} : undefined;
  }
  if (body.startsWith('/switch ')) {
    const rest = body.slice(8).trim();
    return rest ? {kind: 'choice', choice: `switch ${rest}`} : undefined;
  }
  if (body.startsWith('/move ')) {
    const rest = body.slice(6).trim();
    return rest ? {kind: 'choice', choice: `move ${rest}`} : undefined;
  }
  if (
    body === '/pass' ||
    body === '/skip' ||
    body === '/shift' ||
    body === '/default' ||
    body === '/auto' ||
    body === '/undo'
  ) {
    return {kind: 'choice', choice: body.slice(1)};
  }

  if (isBareSimulatorChoice(body)) {
    return {kind: 'choice', choice: body};
  }

  return {kind: 'chat', message: body};
}

// Returns true when a Showdown protocol line must be stripped before reaching any player's `stdin`
// (sealing chat, custom HTML, and room join/rename channels between competing agents).
export function shouldElideFromPlayerStream(line: string): boolean {
  for (const prefix of ELIDED_PLAYER_PREFIXES) {
    if (line.startsWith(prefix)) return true;
  }
  return false;
}

export function filterPlayerProtocolChunk(chunk: string): string {
  if (!chunk) return chunk;
  const lines = chunk.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (!shouldElideFromPlayerStream(line)) {
      kept.push(line);
    }
  }
  return kept.join('\n');
}

export function formatOmniscientPolicyChat(
  playerName: string,
  compactJson: string,
  timestampSec?: number
): string {
  const safeName = playerName.replace(/[|\r\n]+/g, ' ').trim();
  const safeJson = compactJson.replace(/[\r\n]+/g, ' ').trim();
  if (timestampSec !== undefined) {
    return `|c:|${Math.floor(timestampSec)}|☆${safeName}|${safeJson}`;
  }
  return `|c|☆${safeName}|${safeJson}`;
}

export function isDecisionRequest(request: BattleRequest): boolean {
  if (!request || request.wait) return false;
  return Boolean(request.teamPreview || request.forceSwitch || request.active);
}

function getTargetsForMove(
  targetType: string | undefined,
  slotIdx: number,
  numActive: number
): {core: string[]; all: string[]} {
  if (numActive <= 1 || !targetType || !CHOOSABLE_TARGETS.has(targetType)) {
    return {core: [''], all: ['']};
  }
  const allyTarget = slotIdx === 0 ? '-2' : '-1';
  switch (targetType) {
    case 'adjacentFoe':
      return {core: ['+1', '+2'], all: ['+1', '+2']};
    case 'adjacentAlly':
      return {core: [allyTarget], all: [allyTarget]};
    case 'adjacentAllyOrSelf':
      return {core: ['-1', '-2'], all: ['-1', '-2']};
    case 'normal':
    case 'any':
    default:
      // In Doubles, `'normal'` and `'any'` moves can technically target one's own partner (`-2` /
      // `-1`), though many VGC search trees prune self-ally attacks on standard offensive moves.
      // Including `+1`/`+2` in `core` and `+1`/`+2`/ally in `all` accepts both conventions.
      return {core: ['+1', '+2'], all: ['+1', '+2', allyTarget]};
  }
}

interface SlotOption {
  choice: string;
  core: boolean;
  switchSlot?: number;
  usesGimmick: boolean;
}

function enumerateActiveSlotOptions(
  request: BattleRequest,
  slotIdx: number,
  numActive: number,
  benchSlots: number[]
): SlotOption[] {
  const pokemon = request.side.pokemon[slotIdx];
  const activeSlot = request.active?.[slotIdx] ?? null;
  if (!activeSlot || isFainted(pokemon) || pokemon?.commanding) {
    return [{choice: 'pass', core: true, usesGimmick: false}];
  }

  const out: SlotOption[] = [];
  const moves = activeSlot.moves ?? [];
  let moveOptionCount = 0;
  for (let i = 0; i < moves.length; i++) {
    const mv = moves[i];
    const idx = i + 1;
    const baseMoveDisabled = isMoveDisabled(mv);

    // Base (non-gimmick) move targets. Note: when already Dynamaxed (`!canDynamax && maxMoves`),
    // `@pkmn/sim` uses `maxMoves.maxMoves[i]` targets/disabled flags without a `dynamax` suffix
    // (and Dynamax ignores Choice-item `mv.disabled` flags on the underlying base move).
    const alreadyDynamaxed = !activeSlot.canDynamax && Boolean(activeSlot.maxMoves);
    const baseTargetType = alreadyDynamaxed
      ? activeSlot.maxMoves?.maxMoves[i]?.target ?? mv.target
      : mv.target;
    const baseDisabled = alreadyDynamaxed
      ? Boolean(activeSlot.maxMoves?.maxMoves[i]?.disabled)
      : baseMoveDisabled;

    if (!baseDisabled) {
      const targets = getTargetsForMove(baseTargetType, slotIdx, numActive);
      const coreSet = new Set(targets.core);
      for (const t of targets.all) {
        const suffix = t ? ` ${t}` : '';
        out.push({
          choice: `move ${idx}${suffix}`,
          core: coreSet.has(t),
          usesGimmick: false,
        });
        moveOptionCount++;
      }
    }

    if (!baseMoveDisabled) {
      const simpleGimmicks: string[] = [];
      if (activeSlot.canMegaEvo) simpleGimmicks.push('mega');
      if (activeSlot.canMegaEvoX) simpleGimmicks.push('megax');
      if (activeSlot.canMegaEvoY) simpleGimmicks.push('megay');
      if (activeSlot.canUltraBurst) simpleGimmicks.push('ultra');
      if (activeSlot.canTerastallize) simpleGimmicks.push('terastallize');

      for (const gim of simpleGimmicks) {
        const targets = getTargetsForMove(mv.target, slotIdx, numActive);
        const coreSet = new Set(targets.core);
        for (const t of targets.all) {
          const suffix = t ? ` ${t}` : '';
          out.push({
            choice: `move ${idx}${suffix} ${gim}`,
            core: coreSet.has(t),
            usesGimmick: true,
          });
          moveOptionCount++;
        }
      }
    }

    // Z-Moves and Dynamax Max Moves remain selectable even when the base move is Choice/Taunt
    // disabled (`@pkmn/sim` already nulls `canZMove[i]` or sets `maxMoves[i].disabled` on 0 PP).
    const zSlot = activeSlot.canZMove?.[i];
    if (zSlot) {
      const zTargets = getTargetsForMove(zSlot.target ?? mv.target, slotIdx, numActive);
      const coreSet = new Set(zTargets.core);
      for (const t of zTargets.all) {
        const suffix = t ? ` ${t}` : '';
        out.push({
          choice: `move ${idx}${suffix} zmove`,
          core: coreSet.has(t),
          usesGimmick: true,
        });
        moveOptionCount++;
      }
    }

    if (activeSlot.canDynamax && activeSlot.maxMoves?.maxMoves[i]) {
      const maxSlot = activeSlot.maxMoves.maxMoves[i];
      if (!maxSlot.disabled) {
        const dTargets = getTargetsForMove(maxSlot.target ?? mv.target, slotIdx, numActive);
        const coreSet = new Set(dTargets.core);
        for (const t of dTargets.all) {
          const suffix = t ? ` ${t}` : '';
          out.push({
            choice: `move ${idx}${suffix} dynamax`,
            core: coreSet.has(t),
            usesGimmick: true,
          });
          moveOptionCount++;
        }
      }
    }
  }

  // When an updated `maybeDisabled` request marks every remaining move `disabled: true` in place,
  // `@pkmn/sim` treats `move 1` as Struggle (untargeted `randomNormal`).
  if (moveOptionCount === 0) {
    out.push({choice: 'move 1', core: true, usesGimmick: false});
  }

  if (!activeSlot.trapped) {
    for (const b of benchSlots) {
      out.push({
        choice: `switch ${b}`,
        core: true,
        switchSlot: b,
        usesGimmick: false,
      });
    }
  }

  return out;
}

// Enumerates the canonical legal choices available to a player purely from the `|request|` JSON
// received on `stdin` (never inspecting omniscient opponent state such as unrevealed Shadow Tag).
export function enumerateRequestChoices(request: BattleRequest): LegalChoiceSets {
  if (!isDecisionRequest(request)) return {core: [], all: []};

  const party = request.side.pokemon ?? [];
  const n = party.length;

  if (request.teamPreview) {
    if (request.maxChosenTeamSize === undefined) {
      const leads: string[] = [];
      for (let i = 1; i <= n; i++) leads.push(`team ${i}`);
      return {core: leads, all: leads};
    }
    const pick = Math.min(request.maxChosenTeamSize, n);
    if (pick <= 1) {
      const leads: string[] = [];
      for (let i = 1; i <= n; i++) leads.push(`team ${i}`);
      return {core: leads, all: leads};
    }
    // Doubles / VGC Bring-6-Pick-4: ordered leads `(l1, l2)` + sorted bench indices `b1 < b2`.
    const configs: string[] = [];
    const chooseBench = (
      leads: number[],
      startIdx: number,
      bench: number[],
      needed: number
    ) => {
      if (bench.length === needed) {
        configs.push(`team ${leads.join('')}${bench.join('')}`);
        return;
      }
      for (let s = startIdx; s <= n; s++) {
        if (leads.includes(s)) continue;
        bench.push(s);
        chooseBench(leads, s + 1, bench, needed);
        bench.pop();
      }
    };
    for (let l1 = 1; l1 <= n; l1++) {
      for (let l2 = 1; l2 <= n; l2++) {
        if (l1 === l2) continue;
        chooseBench([l1, l2], 1, [], pick - 2);
      }
    }
    return {core: configs, all: configs};
  }

  if (request.forceSwitch) {
    const slots = request.forceSwitch.length;
    const reviving = party.some((p, i) => i < slots && Boolean(p.reviving));
    const candidates: number[] = [];
    if (reviving) {
      for (let i = 0; i < n; i++) {
        if (isFainted(party[i])) candidates.push(i + 1);
      }
    } else {
      for (let i = slots; i < n; i++) {
        if (!isFainted(party[i]) && !party[i].active) candidates.push(i + 1);
      }
    }

    if (slots === 1) {
      const list = candidates.length > 0 ? candidates.map(s => `switch ${s}`) : ['pass'];
      return {core: list, all: list};
    }

    const [f0, f1] = request.forceSwitch;
    if (f0 && !f1) {
      const list = candidates.length > 0
        ? candidates.map(s => `switch ${s}, pass`)
        : ['pass, pass'];
      return {core: list, all: list};
    }
    if (!f0 && f1) {
      const list = candidates.length > 0
        ? candidates.map(s => `pass, switch ${s}`)
        : ['pass, pass'];
      return {core: list, all: list};
    }
    if (f0 && f1) {
      if (candidates.length >= 2) {
        const pairs: string[] = [];
        for (const a of candidates) {
          for (const b of candidates) {
            if (a !== b) pairs.push(`switch ${a}, switch ${b}`);
          }
        }
        return {core: pairs, all: pairs};
      }
      if (candidates.length === 1) {
        const s = candidates[0];
        const single = [`switch ${s}, pass`, `pass, switch ${s}`];
        return {core: single, all: single};
      }
      return {core: ['pass, pass'], all: ['pass, pass']};
    }
    return {core: ['pass, pass'], all: ['pass, pass']};
  }

  if (request.active) {
    const numActive = request.active.length;
    const benchSlots: number[] = [];
    for (let i = numActive; i < n; i++) {
      if (!isFainted(party[i]) && !party[i].active) benchSlots.push(i + 1);
    }

    if (numActive === 1) {
      const opts = enumerateActiveSlotOptions(request, 0, 1, benchSlots);
      return {
        core: opts.filter(o => o.core).map(o => o.choice),
        all: opts.map(o => o.choice),
      };
    }

    const leftOpts = enumerateActiveSlotOptions(request, 0, 2, benchSlots);
    const rightOpts = enumerateActiveSlotOptions(request, 1, 2, benchSlots);
    const core: string[] = [];
    const all: string[] = [];
    for (const l of leftOpts) {
      for (const r of rightOpts) {
        if (l.switchSlot !== undefined && l.switchSlot === r.switchSlot) continue;
        if (l.usesGimmick && r.usesGimmick) continue;
        const joint = `${l.choice}, ${r.choice}`;
        all.push(joint);
        if (l.core && r.core) core.push(joint);
      }
    }
    return {core, all};
  }

  return {core: [], all: []};
}

function canonicalizeSingleSlotAction(
  rawPart: string,
  request: BattleRequest,
  slotIdx: number,
  numActive: number
): string | undefined {
  const cleaned = rawPart.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!cleaned) return undefined;
  if (cleaned === 'pass' || cleaned === 'skip') return 'pass';

  if (cleaned.startsWith('switch ')) {
    const arg = cleaned.slice(7).trim();
    const party = request.side.pokemon ?? [];
    const asNum = Number(arg);
    if (Number.isInteger(asNum) && asNum >= 1 && asNum <= party.length) {
      return `switch ${asNum}`;
    }
    const targetId = toChoiceId(arg);
    for (let i = numActive; i < party.length; i++) {
      const p = party[i];
      const identName = p.ident.includes(':') ? p.ident.slice(p.ident.indexOf(':') + 1) : p.ident;
      const speciesName = p.details.split(',')[0];
      if (toChoiceId(identName) === targetId || toChoiceId(speciesName) === targetId) {
        return `switch ${i + 1}`;
      }
    }
    return undefined;
  }

  if (cleaned.startsWith('move ')) {
    const tokens = cleaned.slice(5).trim().split(' ').filter(Boolean);
    if (!tokens.length) return undefined;

    let gimmick: string | undefined;
    let target: string | undefined;

    while (tokens.length > 1) {
      const last = tokens[tokens.length - 1];
      if (GIMMICK_ALIASES[last]) {
        if (gimmick) return undefined;
        gimmick = GIMMICK_ALIASES[last];
        tokens.pop();
        continue;
      }
      if (/^[+-]?[12]$/.test(last)) {
        if (target) return undefined;
        const n = Number(last);
        target = n > 0 ? `+${n}` : `${n}`;
        tokens.pop();
        continue;
      }
      break;
    }

    const moveSpec = tokens.join(' ');
    const activeSlot = request.active?.[slotIdx];
    if (!activeSlot) return undefined;
    let moveIndex: number | undefined;
    const asNum = Number(moveSpec);
    if (Number.isInteger(asNum) && asNum >= 1 && asNum <= activeSlot.moves.length) {
      moveIndex = asNum;
    } else {
      const specId = toChoiceId(moveSpec);
      for (let i = 0; i < activeSlot.moves.length; i++) {
        const mv = activeSlot.moves[i];
        if (toChoiceId(mv.id) === specId || toChoiceId(mv.move) === specId) {
          moveIndex = i + 1;
          break;
        }
      }
    }
    if (!moveIndex) return undefined;

    // Strip `dynamax` suffix when the active Pokémon is already Dynamaxed (`!canDynamax`).
    if (gimmick === 'dynamax' && !activeSlot.canDynamax && activeSlot.maxMoves) {
      gimmick = undefined;
    }

    const targetSuffix = numActive > 1 && target ? ` ${target}` : '';
    const gimmickSuffix = gimmick ? ` ${gimmick}` : '';
    return `move ${moveIndex}${targetSuffix}${gimmickSuffix}`;
  }

  return undefined;
}

// Normalizes any Showdown choice string (`move earthquake`, `move 1 2 terastal`, `team 1,2,4,3`,
// single-slot Doubles `switch 3` when the partner slot auto-passes, etc.) into the canonical choice
// key produced by `enumerateRequestChoices`.
export function canonicalizeChoice(
  request: BattleRequest,
  rawChoice: string
): string | undefined {
  const trimmed = rawChoice.trim();
  if (!trimmed) return undefined;

  const party = request.side.pokemon ?? [];
  const n = party.length;

  if (request.teamPreview) {
    let body = trimmed.toLowerCase();
    if (body.startsWith('team ')) body = body.slice(5).trim();
    const digits = body.includes(',') || body.includes(' ')
      ? body.split(/[\s,]+/).filter(Boolean).map(Number)
      : body.split('').map(Number);
    if (!digits.length || digits.some(d => !Number.isInteger(d) || d < 1 || d > n)) {
      return undefined;
    }
    const seen = new Set<number>();
    const unique: number[] = [];
    for (const d of digits) {
      if (seen.has(d)) return undefined;
      seen.add(d);
      unique.push(d);
    }
    if (request.maxChosenTeamSize === undefined) {
      return `team ${unique[0]}`;
    }
    const pick = Math.min(request.maxChosenTeamSize, n);
    for (let i = 1; i <= n && unique.length < pick; i++) {
      if (!seen.has(i)) {
        seen.add(i);
        unique.push(i);
      }
    }
    const chosen = unique.slice(0, pick);
    if (pick <= 2) return `team ${chosen.join('')}`;
    const leads = chosen.slice(0, 2);
    const bench = chosen.slice(2).sort((a, b) => a - b);
    return `team ${leads.join('')}${bench.join('')}`;
  }

  if (request.forceSwitch) {
    const slots = request.forceSwitch.length;
    const rawParts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
    if (slots === 1) {
      if (rawParts.length !== 1) return undefined;
      return canonicalizeSingleSlotAction(rawParts[0], request, 0, 1);
    }
    let parts = rawParts;
    if (rawParts.length === 1) {
      const [f0, f1] = request.forceSwitch;
      if (f0 && !f1) parts = [rawParts[0], 'pass'];
      else if (!f0 && f1) parts = ['pass', rawParts[0]];
      else return undefined;
    }
    if (parts.length !== 2) return undefined;
    const c0 = canonicalizeSingleSlotAction(parts[0], request, 0, 2);
    const c1 = canonicalizeSingleSlotAction(parts[1], request, 1, 2);
    if (!c0 || !c1) return undefined;
    return `${c0}, ${c1}`;
  }

  if (request.active) {
    const numActive = request.active.length;
    const rawParts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
    if (numActive === 1) {
      if (rawParts.length !== 1) return undefined;
      return canonicalizeSingleSlotAction(rawParts[0], request, 0, 1);
    }
    let parts = rawParts;
    if (rawParts.length === 1) {
      const leftInactive = !request.active[0] ||
        isFainted(party[0]) ||
        Boolean(party[0]?.commanding);
      const rightInactive = !request.active[1] ||
        isFainted(party[1]) ||
        Boolean(party[1]?.commanding);
      if (leftInactive && !rightInactive) parts = ['pass', rawParts[0]];
      else if (!leftInactive && rightInactive) parts = [rawParts[0], 'pass'];
      else return undefined;
    }
    if (parts.length !== 2) return undefined;
    const c0 = canonicalizeSingleSlotAction(parts[0], request, 0, 2);
    const c1 = canonicalizeSingleSlotAction(parts[1], request, 1, 2);
    if (!c0 || !c1) return undefined;
    return `${c0}, ${c1}`;
  }

  return undefined;
}

// Validates a competitor's plain-text JSON policy line for a single decision `|request|`:
//   - Single-line JSON object mapping every legal choice to a finite probability in `[0, 1]`.
//   - Probabilities sum to `1.0` within `±1e-3` (`POLICY_SUM_TOLERANCE`), explicitly flagging
//     `0..100` percentage scale mistakes and `/say` command prefixes.
//   - Zero illegal/unrecognized choices, full coverage of core legal choices, and strictly positive
//     (`> 0`) probability on the action actually chosen by the agent.
export function validatePolicyLog(
  request: BattleRequest,
  rawPolicyJson: string | undefined,
  chosenAction?: string
): PolicyValidationResult {
  if (!isDecisionRequest(request)) {
    return {ok: true, normalized: {}, compactJson: '{}'};
  }
  const trimmedRaw = rawPolicyJson?.trim();
  if (!trimmedRaw) {
    return {
      ok: false,
      error: 'Missing required policy JSON chat line before decision choice.',
    };
  }
  if (trimmedRaw.startsWith('/say ') || trimmedRaw === '/say') {
    return {
      ok: false,
      error:
        'Do not prefix policy JSON with `/say` — write the JSON object directly on stdout ' +
        'without a command prefix.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedRaw);
  } catch (err: any) {
    return {
      ok: false,
      error: `Invalid policy JSON line: ${err?.message ?? 'parse error'}`,
    };
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    return {
      ok: false,
      error: 'Policy payload must be a flat JSON object mapping choice strings to probabilities.',
    };
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    return {ok: false, error: 'Policy JSON object cannot be empty.'};
  }

  const legal = enumerateRequestChoices(request);
  const allLegalSet = new Set(legal.all);
  const normalized: Record<string, number> = {};
  let sum = 0;
  let maxVal = 0;

  for (const [rawKey, rawVal] of entries) {
    if (typeof rawVal !== 'number' || !Number.isFinite(rawVal)) {
      return {
        ok: false,
        error: `Policy value for "${rawKey}" must be a finite number in [0, 1].`,
      };
    }
    if (rawVal < 0) {
      return {
        ok: false,
        error: `Policy probability for "${rawKey}" (${rawVal}) must be between 0 and 1.`,
      };
    }
    const canon = canonicalizeChoice(request, rawKey);
    if (!canon || !allLegalSet.has(canon)) {
      return {
        ok: false,
        error: `Policy contains illegal or unrecognized choice "${rawKey}" for current request.`,
      };
    }
    normalized[canon] = (normalized[canon] ?? 0) + rawVal;
    sum += rawVal;
    if (rawVal > maxVal) maxVal = rawVal;
  }

  if (maxVal > 1) {
    if (maxVal <= 100 && Math.abs(sum - 100) <= 1) {
      return {
        ok: false,
        error:
          `Policy values sum to ${sum.toFixed(2)} — log probabilities in [0, 1] summing to ` +
          `1.0 (±${POLICY_SUM_TOLERANCE}), not 0..100 percentages.`,
      };
    }
    return {
      ok: false,
      error: `Policy probabilities must be in [0, 1] (found ${maxVal}).`,
    };
  }

  if (Math.abs(sum - 1) > POLICY_SUM_TOLERANCE) {
    return {
      ok: false,
      error:
        `Policy probabilities must sum to 1.0 (±${POLICY_SUM_TOLERANCE}); ` +
        `got ${sum.toFixed(6)}.`,
    };
  }

  const missing: string[] = [];
  for (const c of legal.core) {
    if (!Object.prototype.hasOwnProperty.call(normalized, c)) {
      missing.push(c);
    }
  }
  if (missing.length > 0) {
    const preview = missing.slice(0, 5).map(s => `"${s}"`).join(', ');
    const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
    return {
      ok: false,
      error: `Policy map is missing ${missing.length} legal choice(s): ${preview}${more}.`,
    };
  }

  if (chosenAction !== undefined) {
    const trimmedChoice = chosenAction.trim().toLowerCase();
    if (trimmedChoice === 'default' || trimmedChoice === 'auto') {
      return {
        ok: false,
        error: 'Agents must emit an explicit choice rather than `default`/`auto`.',
      };
    }
    const canonChosen = canonicalizeChoice(request, chosenAction);
    if (!canonChosen || !allLegalSet.has(canonChosen)) {
      return {
        ok: false,
        error: `Chosen action "${chosenAction}" is not a legal choice for current request.`,
      };
    }
    const prob = normalized[canonChosen] ?? 0;
    if (!(prob > 0)) {
      return {
        ok: false,
        error:
          `Chosen action "${canonChosen}" was assigned probability ${prob} in the logged policy ` +
          '(must be > 0).',
      };
    }
  }

  const rounded: Record<string, number> = {};
  for (const key of Object.keys(normalized).sort()) {
    const val = normalized[key];
    rounded[key] = val === 0 ? 0 : Number(val.toPrecision(12));
  }

  return {
    ok: true,
    normalized: rounded,
    compactJson: JSON.stringify(rounded),
  };
}
