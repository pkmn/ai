// Stdio protocol helpers and inter-agent covert-channel elision for pkmn.ai Arena agents.
//
// Why this exists:
//   Zero covert communication: All chat/HTML/join lines (`|c|`, `|c:|`, `|chat|`, `|raw|`,
//   `|html|`, `|uhtml|`, `|debug|`, `|j|`, `|l|`, `|n|`) are stripped from player `stdin` streams
//   and agent chat lines are never forwarded into `@pkmn/sim`, so competing agents cannot exchange
//   signals during a game.

export const MAX_INFO_LINE_CHARS = 2048;
export const MAX_INFO_POLICY_ENTRIES = 8;

export interface PublicAgentInfo {
  win?: number;
  depth?: number;
  seldepth?: number;
  nodes?: number;
  nps?: number;
}

export interface AgentInfo extends PublicAgentInfo {
  policy?: Record<string, number>;
}

export interface TurnAiTelemetry {
  turn: number;
  p1?: PublicAgentInfo;
  p2?: PublicAgentInfo;
}

export type ParsedAgentStdout =
  {kind: 'ready'} |
  {kind: 'info'; info: AgentInfo} |
  {kind: 'chat'; message: string} |
  {kind: 'choice'; choice: string};

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

const BARE_CHOICE_KEYWORDS = new Set([
  'pass',
  'skip',
  'shift',
  'default',
  'auto',
  'recharge',
]);

function containsUndoSubchoice(choice: string): boolean {
  for (const part of choice.split(',')) {
    if (part.trim().toLowerCase() === 'undo') return true;
  }
  return false;
}

function hasEmbeddedControlChars(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

function stripControlChars(line: string): string {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code === 0x09) out += ' ';
    else if (code >= 0x20 && code !== 0x7f) out += line[i];
  }
  return out;
}

function isBareSimulatorChoice(body: string): boolean {
  if (body.includes('|') || body.startsWith('{') || body.startsWith('[')) return false;
  if (/^[1-9][0-9,\s]*$/.test(body)) return true;
  if (/^team\s+[1-9](?:\s*,\s*[1-9]){0,5}$/i.test(body)) return true;
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

function normalizeSimulatorChoice(choice: string): string {
  const trimmed = choice.trim();
  if (/^team\b/i.test(trimmed)) {
    const rest = trimmed.slice(4).trim();
    return rest ? `team ${rest}` : 'team';
  }
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined;
  if (value > Number.MAX_SAFE_INTEGER) return undefined;
  return value;
}

function parseUnitProbability(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return undefined;
  }
  return value;
}

export function parseAgentInfoPayload(rawJson: string): AgentInfo | undefined {
  if (!rawJson || rawJson.length > MAX_INFO_LINE_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;

  const info: AgentInfo = {};
  let hasField = false;

  if (parsed.win !== undefined) {
    const win = parseUnitProbability(parsed.win);
    if (win === undefined) return undefined;
    info.win = win;
    hasField = true;
  }
  for (const key of ['depth', 'seldepth', 'nodes', 'nps'] as const) {
    if (parsed[key] !== undefined) {
      const val = parseNonNegativeInt(parsed[key]);
      if (val === undefined) return undefined;
      info[key] = val;
      hasField = true;
    }
  }
  if (parsed.policy !== undefined) {
    if (!isPlainObject(parsed.policy)) return undefined;
    const entries = Object.entries(parsed.policy);
    if (entries.length === 0 || entries.length > MAX_INFO_POLICY_ENTRIES) return undefined;
    const policy: Record<string, number> = {};
    for (const [rawKey, rawProb] of entries) {
      if (hasEmbeddedControlChars(rawKey)) return undefined;
      const choice = normalizeSimulatorChoice(rawKey);
      if (!choice || containsUndoSubchoice(choice) || !isBareSimulatorChoice(choice)) {
        return undefined;
      }
      const prob = parseUnitProbability(rawProb);
      if (prob === undefined) return undefined;
      policy[choice] = prob;
    }
    info.policy = policy;
    hasField = true;
  }

  return hasField ? info : undefined;
}

export function toPublicAgentInfo(info: AgentInfo): PublicAgentInfo | undefined {
  const pub: PublicAgentInfo = {};
  let hasField = false;
  if (info.win !== undefined) {
    pub.win = Math.round(info.win * 10_000) / 10_000;
    hasField = true;
  }
  if (info.depth !== undefined) {
    pub.depth = info.depth;
    hasField = true;
  }
  if (info.seldepth !== undefined) {
    pub.seldepth = info.seldepth;
    hasField = true;
  }
  if (info.nodes !== undefined) {
    pub.nodes = info.nodes;
    hasField = true;
  }
  if (info.nps !== undefined) {
    pub.nps = info.nps;
    hasField = true;
  }
  return hasField ? pub : undefined;
}

export function formatAiLogLine(slot: 'p1' | 'p2', info: PublicAgentInfo): string | undefined {
  const pub = toPublicAgentInfo(info);
  if (!pub) return undefined;
  return `|ai|${slot}|${JSON.stringify(pub)}`;
}

export function parseAiLogLine(
  line: string
): {slot: 'p1' | 'p2'; info: PublicAgentInfo} | undefined {
  if (!line.startsWith('|ai|')) return undefined;
  const slot = line.slice(4, 6);
  if ((slot !== 'p1' && slot !== 'p2') || line[6] !== '|') return undefined;
  const info = parseAgentInfoPayload(line.slice(7));
  if (!info) return undefined;
  const pub = toPublicAgentInfo(info);
  return pub ? {slot, info: pub} : undefined;
}

export function injectAiLogLines(
  rawLog: string,
  byTurn: ReadonlyMap<number, {p1?: PublicAgentInfo; p2?: PublicAgentInfo}>
): string {
  if (!rawLog || byTurn.size === 0) return rawLog;
  const emitTurn = (out: string[], turn: number) => {
    const entry = byTurn.get(turn);
    if (!entry) return;
    if (entry.p1) {
      const line = formatAiLogLine('p1', entry.p1);
      if (line) out.push(line);
    }
    if (entry.p2) {
      const line = formatAiLogLine('p2', entry.p2);
      if (line) out.push(line);
    }
  };

  const out: string[] = [];
  let flushedTurn0 = false;
  for (const line of rawLog.split('\n')) {
    if (
      !flushedTurn0 &&
      (line.startsWith('|turn|') || line.startsWith('|win|') || line === '|tie')
    ) {
      emitTurn(out, 0);
      flushedTurn0 = true;
    }
    out.push(line);
    if (line.startsWith('|turn|')) {
      const turn = parseInt(line.slice('|turn|'.length), 10);
      if (Number.isInteger(turn) && turn > 0) {
        emitTurn(out, turn);
      }
    }
  }
  if (!flushedTurn0) {
    emitTurn(out, 0);
  }
  return out.join('\n');
}

export function extractAiTelemetry(lines: readonly string[]): TurnAiTelemetry[] {
  const byTurn = new Map<number, TurnAiTelemetry>();
  let currentTurn = 0;
  for (const line of lines) {
    if (line.startsWith('|turn|')) {
      const turn = parseInt(line.slice('|turn|'.length), 10);
      if (Number.isInteger(turn) && turn >= 0) currentTurn = turn;
      continue;
    }
    if (!line.startsWith('|ai|')) continue;
    const parsed = parseAiLogLine(line);
    if (!parsed) continue;
    let entry = byTurn.get(currentTurn);
    if (!entry) {
      entry = {turn: currentTurn};
      byTurn.set(currentTurn, entry);
    }
    entry[parsed.slot] = parsed.info;
  }
  return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
}

function stripOptionalRoomPrefix(trimmed: string): string {
  if (!trimmed.startsWith('|')) return trimmed;
  const secondPipe = trimmed.indexOf('|', 1);
  return secondPipe >= 0 && trimmed.slice(1, secondPipe).startsWith('battle-')
    ? trimmed.slice(secondPipe + 1).trim()
    : trimmed.slice(1).trim();
}

export function isAgentInfoLine(rawLine: string): boolean {
  const withoutCr = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (hasEmbeddedControlChars(withoutCr)) return false;
  const body = stripOptionalRoomPrefix(withoutCr.trim()).toLowerCase();
  return body === '/info' || body.startsWith('/info ');
}

// Parses a single stdout line from an Arena agent into either a Showdown simulator choice string
// or a plain chat/text line (which callers discard so agents cannot message each other or inject
// protocol commands). Lines with embedded `\r` or control characters are always demoted to chat.
// Explicit forfeits (`forfeit`, `/forfeit`, `/choose forfeit`), tie offers (`/offertie`,
// `/accepttie`, `/rejecttie`, `/tie`), timer commands (`/timer`), and choice cancellation (`undo`,
// `/undo`, `/choose undo`) are intentionally rejected as chat so agents cannot forfeit, agree to
// ties, or manipulate battle state.
export function parseAgentStdoutLine(rawLine: string): ParsedAgentStdout | undefined {
  const withoutCr = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (hasEmbeddedControlChars(withoutCr)) {
    const cleaned = stripControlChars(withoutCr).trim();
    return cleaned ? {kind: 'chat', message: cleaned} : undefined;
  }
  const trimmed = withoutCr.trim();
  if (!trimmed) return undefined;

  // Strip optional leading room prefix `|<room>|` or `|` for agents reusing a PS client adapter.
  const body = stripOptionalRoomPrefix(trimmed);
  if (!body) return undefined;

  const lowerBody = body.toLowerCase();
  if (lowerBody === '/ready') {
    return {kind: 'ready'};
  }
  if (lowerBody === '/info' || lowerBody.startsWith('/info ')) {
    if (body.length > MAX_INFO_LINE_CHARS) return undefined;
    const info = parseAgentInfoPayload(body.slice(5).trim());
    return info ? {kind: 'info', info} : undefined;
  }
  if (lowerBody.startsWith('/choose ')) {
    const choice = normalizeSimulatorChoice(body.slice(8));
    if (!choice) return undefined;
    if (containsUndoSubchoice(choice) || !isBareSimulatorChoice(choice)) {
      return {kind: 'chat', message: body};
    }
    return {kind: 'choice', choice};
  }
  if (lowerBody.startsWith('/team ')) {
    const rest = body.slice(6).trim();
    if (!rest) return undefined;
    const choice = `team ${rest}`;
    if (containsUndoSubchoice(choice) || !isBareSimulatorChoice(choice)) {
      return {kind: 'chat', message: body};
    }
    return {kind: 'choice', choice};
  }
  if (lowerBody.startsWith('/switch ')) {
    const rest = body.slice(8).trim();
    if (!rest) return undefined;
    const choice = `switch ${rest}`;
    if (containsUndoSubchoice(choice) || !isBareSimulatorChoice(choice)) {
      return {kind: 'chat', message: body};
    }
    return {kind: 'choice', choice};
  }
  if (lowerBody.startsWith('/move ')) {
    const rest = body.slice(6).trim();
    if (!rest) return undefined;
    const choice = `move ${rest}`;
    if (containsUndoSubchoice(choice) || !isBareSimulatorChoice(choice)) {
      return {kind: 'chat', message: body};
    }
    return {kind: 'choice', choice};
  }
  if (
    lowerBody === '/pass' ||
    lowerBody === '/skip' ||
    lowerBody === '/shift' ||
    lowerBody === '/default' ||
    lowerBody === '/auto'
  ) {
    return {kind: 'choice', choice: lowerBody.slice(1)};
  }

  if (isBareSimulatorChoice(body)) {
    return {kind: 'choice', choice: normalizeSimulatorChoice(body)};
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

const SPLIT_LINE_RE = /^\|split\|p([1234])\n(.*)\n(.*)|.+/gm;

// Splits an omniscient Showdown battle log containing `|split|pN` directives into per-player
// perspective logs (matching `@pkmn/sim`'s stateless `extractChannelMessages(..., [1, 2])`).
export function extractPerspectiveLogs(
  lines: readonly string[]
): {p1Lines: string[]; p2Lines: string[]} {
  if (lines.length === 0) return {p1Lines: [], p2Lines: []};
  const p1Lines: string[] = [];
  const p2Lines: string[] = [];
  const joined = lines.join('\n');
  for (const [lineMatch, playerMatch, secretMessage, sharedMessage] of joined.matchAll(
    SPLIT_LINE_RE
  )) {
    const player = playerMatch ? parseInt(playerMatch, 10) : 0;
    if (player) {
      const p1Line = player === 1 ? secretMessage : sharedMessage;
      const p2Line = player === 2 ? secretMessage : sharedMessage;
      if (p1Line) p1Lines.push(p1Line);
      if (p2Line) p2Lines.push(p2Line);
    } else {
      p1Lines.push(lineMatch);
      p2Lines.push(lineMatch);
    }
  }
  return {p1Lines, p2Lines};
}
