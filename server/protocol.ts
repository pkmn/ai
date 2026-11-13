// Stdio protocol helpers and inter-agent covert-channel elision for pkmn.ai Arena agents.
//
// Why this exists:
//   Zero covert communication: All chat/HTML/join lines (`|c|`, `|c:|`, `|chat|`, `|raw|`,
//   `|html|`, `|uhtml|`, `|debug|`, `|j|`, `|l|`, `|n|`) are stripped from player `stdin` streams
//   and agent chat lines are never forwarded into `@pkmn/sim`, so competing agents cannot exchange
//   signals during a game.

export type ParsedAgentStdout = {kind: 'chat'; message: string} | {kind: 'choice'; choice: string};

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
    if (!choice) return undefined;
    if (containsUndoSubchoice(choice) || !isBareSimulatorChoice(choice)) {
      return {kind: 'chat', message: body};
    }
    return {kind: 'choice', choice};
  }
  if (body.startsWith('/team ')) {
    const rest = body.slice(6).trim();
    if (!rest) return undefined;
    const choice = `team ${rest}`;
    if (containsUndoSubchoice(choice) || !isBareSimulatorChoice(choice)) {
      return {kind: 'chat', message: body};
    }
    return {kind: 'choice', choice};
  }
  if (body.startsWith('/switch ')) {
    const rest = body.slice(8).trim();
    if (!rest) return undefined;
    const choice = `switch ${rest}`;
    if (containsUndoSubchoice(choice) || !isBareSimulatorChoice(choice)) {
      return {kind: 'chat', message: body};
    }
    return {kind: 'choice', choice};
  }
  if (body.startsWith('/move ')) {
    const rest = body.slice(6).trim();
    if (!rest) return undefined;
    const choice = `move ${rest}`;
    if (containsUndoSubchoice(choice) || !isBareSimulatorChoice(choice)) {
      return {kind: 'chat', message: body};
    }
    return {kind: 'choice', choice};
  }
  if (
    body === '/pass' ||
    body === '/skip' ||
    body === '/shift' ||
    body === '/default' ||
    body === '/auto'
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
