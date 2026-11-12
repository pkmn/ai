// Declarative Arena scenario runner, probabilistic simulator, and CLI (`npm run mock`).
//
// Executes declarative `.mock` lifecycle commands (from scenario files, `stdin`, or one-by-one CLI
// arguments) across both fast Direct DB/FS mode (`npm run mock -- seed`, `tools/shots.ts`) and Live
// HTTP Server mode (`--server <url>`, `test/e2e.test.ts`), sampling outcomes probabilistically
// from per-ladder expected ratings via the Generalized Davidson model.

import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import * as zlib from 'zlib';

import * as champions from '@pkmn/mods/champions';
import * as sim from '@pkmn/sim';
import * as yaml from 'yaml';

import * as db from '../db';
import * as arena from '../server/arena';
import * as auth from '../server/auth';
import * as ratings from '../server/ratings';
import * as render from '../server/render';
import * as teams from '../server/teams';
import * as tournaments from '../server/tournaments';
import * as wiki from '../server/wiki';
import {Project} from '../static/projects';
import {root, slugify, toID} from '../static/util';

const CHAMPIONS_SIM_DEX = sim.Dex.mod('champions', champions as unknown as sim.ModData);

export const SCENARIOS_DIR = root('tools', 'scenarios');
export const SEED_SCENARIO = path.join(SCENARIOS_DIR, 'seed.mock');

function stepMulberry32(state: number): {nextState: number; unit: number} {
  const nextState = (state + 0x6d2b79f5) >>> 0;
  let t = Math.imul(nextState ^ (nextState >>> 15), 1 | nextState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return {nextState, unit};
}

export function createRng(rngSeed = 20261110): (max: number) => number {
  let state = rngSeed >>> 0;
  return (max: number): number => {
    if (max <= 1) return 0;
    const step = stepMulberry32(state);
    state = step.nextState;
    return Math.min(max - 1, Math.floor(step.unit * max));
  };
}

export const LEGAL_VGC_SPECIES = [
  'Archaludon', 'Farigiraf', 'Garchomp', 'Golisopod', 'Incineroar', 'Politoed',
  'Indeedee-F', 'Annihilape', 'Arcanine-Hisui', 'Meowstic-F', 'Torkoal', 'Raichu',
  'Basculegion', 'Gholdengo', 'Rillaboom', 'Staraptor', 'Volcarona', 'Salamence',
  'Kingambit', 'Sneasler', 'Sylveon', 'Delphox', 'Metagross', 'Gengar',
  'Altaria', 'Milotic', 'Tsareena', 'Sableye', 'Dragonite', 'Pelipper', 'Grimmsnarl',
];

const VGC_ITEMS = [
  'Leftovers', 'Sitrus Berry', 'Choice Scarf', 'Focus Sash', 'Life Orb', 'Lum Berry',
];

// `(31, 6, 1)` Singer difference set: every pair of cyclic 6-subsets shares at most 1 species,
// guaranteeing pairwise team distance `D >= 5.0 >= 1.30` across any 20-team subset.
const SINGER_31_OFFSETS = [0, 1, 3, 8, 12, 18];

const legalMovesCache = new Map<string, string[]>();

function getLegalChampionsMoves(speciesName: string): string[] {
  const cached = legalMovesCache.get(speciesName);
  if (cached) return cached;
  const sp = CHAMPIONS_SIM_DEX.species.get(speciesName);
  const learnset = CHAMPIONS_SIM_DEX.species.getLearnsetData(sp.id).learnset ?? {};
  const moves: string[] = [];
  for (const moveId of Object.keys(learnset)) {
    const move = CHAMPIONS_SIM_DEX.moves.get(moveId);
    if (move.exists && !move.isNonstandard && !move.isZ && !move.isMax) {
      moves.push(move.name);
      if (moves.length === 4) break;
    }
  }
  legalMovesCache.set(speciesName, moves);
  return moves;
}

export function generateValidVgcTeams(count = 20, agentOffset = 0): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const base = (i + agentOffset * 7) % LEGAL_VGC_SPECIES.length;
    const blocks = SINGER_31_OFFSETS.map((off, slot) => {
      const sp = CHAMPIONS_SIM_DEX.species.get(
        LEGAL_VGC_SPECIES[(base + off) % LEGAL_VGC_SPECIES.length]
      );
      const item = VGC_ITEMS[(slot + agentOffset) % VGC_ITEMS.length];
      const moves = getLegalChampionsMoves(sp.name);
      return [
        `${sp.name} @ ${item}`,
        `Ability: ${sp.abilities['0']}`,
        'Level: 50',
        // Champions Stat Points: max 32 per stat, max 66 total across all 6 stats.
        'EVs: 32 HP / 2 Def / 32 Spe',
        'Timid Nature',
        ...moves.map(m => `- ${m}`),
      ].join('\n');
    });
    out.push(blocks.join('\n\n'));
  }
  return out;
}

const ZERO_ERROR_PNG_BASE64 = [
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAPklEQVR4nO3SwQkAIAwDwZb9d+7C',
  'wcEXkJ6SuQkAAPBn1tp7zhljjAmcB1wHXAdcB1wHXAdcB1wHXAdc5wE93QMR8wX8WQAAAABJRU5ErkJggg==',
].join('');

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC32_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tag = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])), 0);
  return Buffer.concat([len, tag, data, crc]);
}

function generateAvatarPng(slug: string): Buffer {
  if (slug === '0-error') {
    return Buffer.from(ZERO_ERROR_PNG_BASE64, 'base64');
  }
  let hash = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    hash = Math.imul(hash ^ slug.charCodeAt(i), 16777619) >>> 0;
  }
  const fg = [80 + (hash & 0x9f), 80 + ((hash >>> 8) & 0x9f), 80 + ((hash >>> 16) & 0x9f)];
  const bg = [24, 28, 36];
  const size = 32;
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowOff = y * (1 + size * 4);
    raw[rowOff] = 0;
    const gy = Math.floor(y / 4);
    for (let x = 0; x < size; x++) {
      const gx = Math.floor(x / 4);
      const mirrorX = gx < 4 ? gx : 7 - gx;
      const bitIdx = (gy * 4 + mirrorX) % 31;
      const on = gy > 0 && gy < 7 && mirrorX > 0 && ((hash >>> bitIdx) & 1) === 1;
      const col = on ? fg : bg;
      const px = rowOff + 1 + x * 4;
      raw[px] = col[0];
      raw[px + 1] = col[1];
      raw[px + 2] = col[2];
      raw[px + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function sha256OfTag(tag: string): string {
  const hex = Buffer.from(tag, 'utf8').toString('hex');
  return hex.repeat(Math.ceil(64 / hex.length)).slice(0, 64);
}

export interface Command {
  lineNumber: number;
  raw: string;
  tokens: string[];
  positional: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set([
  'open-ladders',
  'pending',
  'disabled',
  'no-guild',
  'banned',
  'pass',
  'fail',
  'all',
  'heartbeats',
  'logs',
  'archive',
  'off',
  'notified',
  'fast-time',
  'balanced',
  'help',
]);

export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '\'' | '"' | undefined;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '\'') {
      if (ch === '\'') {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = undefined;
      } else if (ch === '\\' && i + 1 < line.length) {
        i++;
        const next = line[i];
        if (next === 'n') current += '\n';
        else if (next === 't') current += '\t';
        else if (next === 'r') current += '\r';
        else current += next;
      } else {
        current += ch;
      }
      continue;
    }

    // Outside quotes: `#` starts an inline comment when at start-of-token and followed by
    // whitespace or EOL (so tournament titles or anchors like `#1` remain ordinary tokens).
    if (ch === '#' && !inToken && (i + 1 === line.length || /\s/.test(line[i + 1]))) {
      break;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      i++;
      current += line[i];
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }

  if (quote) {
    throw new Error(`Unterminated ${quote} quote in mock command: ${line}`);
  }
  if (inToken) {
    tokens.push(current);
  }
  return tokens;
}

export function parseCommandTokens(
  tokens: string[],
  lineNumber = 1,
  raw = tokens.join(' ')
): Command {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const pushFlag = (key: string, val: string) => {
    const list = flags.get(key) ?? [];
    list.push(val);
    flags.set(key, list);
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('--') && tok.length > 2) {
      const eq = tok.indexOf('=');
      if (eq > 2) {
        pushFlag(tok.slice(2, eq), tok.slice(eq + 1));
      } else {
        const key = tok.slice(2);
        const next = tokens[i + 1];
        if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith('--')) {
          pushFlag(key, 'true');
        } else {
          pushFlag(key, next);
          i++;
        }
      }
    } else {
      positional.push(tok);
    }
  }
  return {lineNumber, raw, tokens, positional, flags};
}

export function parseScript(script: string): Command[] {
  const rawLines = script.replace(/\r\n/g, '\n').split('\n');
  const commands: Command[] = [];
  let acc = '';
  let startLine = 1;

  for (let idx = 0; idx < rawLines.length; idx++) {
    const raw = rawLines[idx];
    const trimmed = raw.trim();
    if (!acc) {
      if (!trimmed || trimmed.startsWith('#')) continue;
      startLine = idx + 1;
    } else if (trimmed.startsWith('#')) {
      continue;
    }

    if (raw.endsWith('\\') && !raw.endsWith('\\\\')) {
      acc += `${raw.slice(0, -1)} `;
      continue;
    }
    acc += raw;
    const tokens = tokenize(acc);
    acc = '';
    if (tokens.length > 0) {
      commands.push(parseCommandTokens(tokens, startLine, tokens.join(' ')));
    }
  }

  if (acc.trim()) {
    const tokens = tokenize(acc);
    if (tokens.length > 0) {
      commands.push(parseCommandTokens(tokens, startLine, tokens.join(' ')));
    }
  }
  return commands;
}

function getFlag(cmd: Command, key: string): string | undefined {
  const vals = cmd.flags.get(key);
  return vals?.[vals.length - 1];
}

function hasFlag(cmd: Command, key: string): boolean {
  return cmd.flags.has(key);
}

export function parseDurationSeconds(spec: string): number {
  const m = /^([+-]?\d+(?:\.\d+)?)(ms|s|m|h|d|w)?$/i.exec(spec.trim());
  if (!m) {
    throw new Error(`Invalid duration "${spec}" (expected e.g. 30s, 10m, 2h, 14d)`);
  }
  const value = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  const mult =
    unit === 'ms' ? 0.001
    : unit === 's' ? 1
    : unit === 'm' ? 60
    : unit === 'h' ? 3600
    : unit === 'd' ? 86400
    : 7 * 86400;
  return Math.round(value * mult);
}

export function parseTimestampSpec(
  spec: string,
  currentNow: number,
  anchorNow: number
): number {
  const trimmed = spec.trim();
  if (trimmed === 'now') return anchorNow;
  if (trimmed.startsWith('now+') || trimmed.startsWith('now-')) {
    return anchorNow + parseDurationSeconds(trimmed.slice(3));
  }
  if (trimmed.startsWith('+') || trimmed.startsWith('-')) {
    return currentNow + parseDurationSeconds(trimmed);
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const parsedMillis = Date.parse(trimmed);
  if (!Number.isNaN(parsedMillis)) {
    return Math.floor(parsedMillis / 1000);
  }
  throw new Error(`Invalid timestamp specification "${spec}"`);
}

function parseBytesSpec(spec: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(spec.trim());
  if (!m) throw new Error(`Invalid byte size "${spec}"`);
  const val = Number(m[1]);
  const unit = (m[2] ?? 'mb').toLowerCase();
  const mult =
    unit === 'b' ? 1
    : unit === 'kb' ? 1024
    : unit === 'gb' ? 1024 * 1024 * 1024
    : 1024 * 1024;
  return Math.round(val * mult);
}

interface SingleGameRecord {
  i: number;
  j: number;
  outcome: 'W' | 'L' | 'T';
}

function computeSingleGameTournamentRatings(
  M: number,
  games: SingleGameRecord[],
  anchorIndex = -1,
  anchorElo = 1550
): {elo: number[]; se: number[]} {
  if (M === 0) return {elo: [], se: []};
  const priorStdElo = 350;
  const sigma0 = priorStdElo / ratings.ELO_SCALE;
  const priorPrec = 1 / (sigma0 * sigma0);
  const theta = new Float64Array(M);
  const grad = new Float64Array(M);
  const H = new Float64Array(M * M);

  let tieCount = 0;
  for (const g of games) {
    if (g.outcome === 'T') tieCount++;
  }
  const tieRate = games.length > 0 ? Math.min(0.5, tieCount / games.length) : 0;
  const nu = tieRate > 0 ? (2 * tieRate) / (1 - tieRate) : 0;

  for (let iter = 0; iter < 25; iter++) {
    H.fill(0);
    for (let i = 0; i < M; i++) {
      grad[i] = -priorPrec * theta[i];
      H[i * M + i] = priorPrec;
    }
    for (const g of games) {
      const d = theta[g.i] - theta[g.j];
      const eh = Math.exp(0.5 * d);
      const emh = 1 / eh;
      const Z = eh + emh + nu;
      const pW = eh / Z;
      const pL = emh / Z;
      const y = g.outcome === 'W' ? 0.5 : g.outcome === 'L' ? -0.5 : 0;
      const mu = 0.5 * (pW - pL);
      const v = 0.25 * (pW + pL) - mu * mu;
      const diff = y - mu;
      grad[g.i] += diff;
      grad[g.j] -= diff;
      H[g.i * M + g.i] += v;
      H[g.j * M + g.j] += v;
      H[g.i * M + g.j] -= v;
      H[g.j * M + g.i] -= v;
    }
    const step = solveLinearSystem(H, grad, M);
    let maxStep = 0;
    for (let i = 0; i < M; i++) {
      theta[i] += step[i];
      if (Math.abs(step[i]) > maxStep) maxStep = Math.abs(step[i]);
    }
    if (maxStep < 1e-10) break;
  }

  H.fill(0);
  const played = new Uint8Array(M);
  for (let i = 0; i < M; i++) H[i * M + i] = priorPrec;
  for (const g of games) {
    const d = theta[g.i] - theta[g.j];
    const eh = Math.exp(0.5 * d);
    const emh = 1 / eh;
    const Z = eh + emh + nu;
    const pW = eh / Z;
    const pL = emh / Z;
    const mu = 0.5 * (pW - pL);
    const v = Math.max(1e-9, 0.25 * (pW + pL) - mu * mu);
    H[g.i * M + g.i] += v;
    H[g.j * M + g.j] += v;
    H[g.i * M + g.j] -= v;
    H[g.j * M + g.i] -= v;
    played[g.i] = 1;
    played[g.j] = 1;
  }
  let playedCount = 0;
  for (let i = 0; i < M; i++) playedCount += played[i];
  // Pin the global shift gauge only across entrants with >= 1 game so unplayed entrants keep
  // their 350 Elo prior uncertainty while pairwise variances stay exact.
  if (playedCount > 0) {
    const gauge = 1e6 / (playedCount * playedCount);
    for (let i = 0; i < M; i++) {
      if (!played[i]) continue;
      for (let j = 0; j < M; j++) {
        if (played[j]) H[i * M + j] += gauge;
      }
    }
  }
  const cov = invertMatrix(H, M);
  let offset = 0;
  if (anchorIndex >= 0 && anchorIndex < M) {
    offset = theta[anchorIndex];
  } else if (playedCount > 0) {
    let sum = 0;
    for (let i = 0; i < M; i++) {
      if (played[i]) sum += theta[i];
    }
    offset = sum / playedCount;
  }

  const elo: number[] = [];
  const se: number[] = [];
  for (let i = 0; i < M; i++) {
    elo.push(Math.round(anchorElo + ratings.ELO_SCALE * (theta[i] - offset)));
    se.push(Math.round(ratings.ELO_SCALE * Math.sqrt(Math.max(0, cov[i * M + i]))));
  }
  return {elo, se};
}

function solveLinearSystem(A: Float64Array, b: Float64Array, n: number): Float64Array {
  const M = new Float64Array(n * (n + 1));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) M[r * (n + 1) + c] = A[r * n + c];
    M[r * (n + 1) + n] = b[r];
  }
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r * (n + 1) + col]) > Math.abs(M[pivot * (n + 1) + col])) pivot = r;
    }
    if (pivot !== col) {
      for (let c = col; c <= n; c++) {
        const tmp = M[col * (n + 1) + c];
        M[col * (n + 1) + c] = M[pivot * (n + 1) + c];
        M[pivot * (n + 1) + c] = tmp;
      }
    }
    const diag = M[col * (n + 1) + col] || 1e-12;
    for (let r = col + 1; r < n; r++) {
      const f = M[r * (n + 1) + col] / diag;
      for (let c = col; c <= n; c++) M[r * (n + 1) + c] -= f * M[col * (n + 1) + c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let sum = M[r * (n + 1) + n];
    for (let c = r + 1; c < n; c++) sum -= M[r * (n + 1) + c] * x[c];
    x[r] = sum / (M[r * (n + 1) + r] || 1e-12);
  }
  return x;
}

function invertMatrix(A: Float64Array, n: number): Float64Array {
  const aug = new Float64Array(n * 2 * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) aug[r * 2 * n + c] = A[r * n + c];
    aug[r * 2 * n + n + r] = 1;
  }
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(aug[r * 2 * n + col]) > Math.abs(aug[pivot * 2 * n + col])) pivot = r;
    }
    if (pivot !== col) {
      for (let c = 0; c < 2 * n; c++) {
        const tmp = aug[col * 2 * n + c];
        aug[col * 2 * n + c] = aug[pivot * 2 * n + c];
        aug[pivot * 2 * n + c] = tmp;
      }
    }
    const diag = aug[col * 2 * n + col] || 1e-12;
    for (let c = 0; c < 2 * n; c++) aug[col * 2 * n + c] /= diag;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = aug[r * 2 * n + col];
      for (let c = 0; c < 2 * n; c++) aug[r * 2 * n + c] -= f * aug[col * 2 * n + c];
    }
  }
  const inv = new Float64Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) inv[r * n + c] = aug[r * 2 * n + n + c];
  }
  return inv;
}

// Berger round-robin circle method: partitions all K*(K-1)/2 unordered pairs into rounds where
// each entrant plays at most once per round.
function buildBergerPairings(count: number): Array<[number, number]> {
  if (count < 2) return [];
  const indices: number[] = [];
  for (let i = 0; i < count; i++) indices.push(i);
  if (count % 2 === 1) indices.push(-1);
  const n = indices.length;
  const half = n / 2;
  const out: Array<[number, number]> = [];
  const rot = indices.slice(1);
  for (let round = 0; round < n - 1; round++) {
    const circle = [indices[0], ...rot];
    for (let k = 0; k < half; k++) {
      const a = circle[k];
      const b = circle[n - 1 - k];
      if (a >= 0 && b >= 0) {
        out.push(round % 2 === 0 ? [a, b] : [b, a]);
      }
    }
    rot.unshift(rot.pop()!);
  }
  return out;
}

const PACKED_FORMAT_TEAMS: Record<string, string[][]> = {
  gen9ou: [
    ['Great Tusk', 'Kingambit', 'Gholdengo', 'Dragapult', 'Ogerpon-Wellspring', 'Gliscor'],
    ['Zamazenta', 'Darkrai', 'Ting-Lu', 'Raging Bolt', 'Hatterene', 'Samurott-Hisui'],
    ['Dragapult', 'Kingambit', 'Great Tusk', 'Slowking-Galar', 'Corviknight', 'Kyurem'],
    ['Gliscor', 'Gholdengo', 'Ting-Lu', 'Iron Valiant', 'Cinderace', 'Primarina'],
  ],
  gen9championsvgc2026regmc: [
    ['Incineroar', 'Rillaboom', 'Archaludon', 'Pelipper', 'Basculegion', 'Farigiraf'],
    ['Garchomp', 'Staraptor', 'Gholdengo', 'Kingambit', 'Sneasler', 'Milotic'],
    ['Dragonite', 'Arcanine-Hisui', 'Politoed', 'Grimmsnarl', 'Sylveon', 'Metagross'],
    ['Volcarona', 'Salamence', 'Tsareena', 'Sableye', 'Raichu', 'Torkoal'],
  ],
  gen1ou: [
    ['Tauros', 'Snorlax', 'Chansey', 'Exeggutor', 'Alakazam', 'Starmie'],
    ['Tauros', 'Snorlax', 'Chansey', 'Rhydon', 'Zapdos', 'Gengar'],
  ],
  gen3ou: [
    ['Tyranitar', 'Swampert', 'Skarmory', 'Blissey', 'Gengar', 'Salamence'],
    ['Tyranitar', 'Metagross', 'Zapdos', 'Celebi', 'Dugtrio', 'Suicune'],
  ],
};

function samplePackedTournamentTeam(format: string, index: number): string {
  const list = PACKED_FORMAT_TEAMS[format] ?? PACKED_FORMAT_TEAMS.gen9ou;
  const species = list[index % list.length];
  return species.map(n => `|${n}`).join(']');
}

function buildShowdownTournamentLog(opts: {
  format: string;
  p1Name: string;
  p2Name: string;
  p1TeamPacked: string;
  p2TeamPacked: string;
  outcome: 'W' | 'L' | 'T';
}): string {
  const isDoubles = opts.format.includes('vgc') || opts.format.includes('doubles');
  const gen = /^gen(\d)/i.exec(opts.format)?.[1] ?? '9';
  const tier = isDoubles ? '[Gen 9 Champions] VGC 2026 Reg M-C' : `[Gen ${gen}] OU`;
  const p1Mons = tournaments.parsePackedTeamSpecies(opts.p1TeamPacked);
  const p2Mons = tournaments.parsePackedTeamSpecies(opts.p2TeamPacked);
  const lead1 = p1Mons[0] ?? 'Great Tusk';
  const lead2 = p2Mons[0] ?? 'Dragapult';
  const lines = [
    `|player|p1|${opts.p1Name}|1`,
    `|player|p2|${opts.p2Name}|2`,
    `|gametype|${isDoubles ? 'doubles' : 'singles'}`,
    `|gen|${gen}`,
    `|tier|${tier}`,
    ...p1Mons.slice(0, 6).map(sp => `|poke|p1|${sp}|`),
    ...p2Mons.slice(0, 6).map(sp => `|poke|p2|${sp}|`),
    '|teampreview',
    `|c|☆${opts.p1Name}|{"team 1":0.685,"team 2":0.315}`,
    `|c|☆${opts.p2Name}|{"team 1":0.55,"team 2":0.45}`,
    '|start',
    `|switch|p1a: ${lead1}|${lead1}|100/100`,
    `|switch|p2a: ${lead2}|${lead2}|100/100`,
    '|turn|1',
    `|c|☆${opts.p1Name}|{"move 1":0.625,"move 2":0.25,"switch 2":0.125}`,
    `|c|☆${opts.p2Name}|{"move 1":0.55,"move 3":0.3,"switch 2":0.15}`,
    `|move|p1a: ${lead1}|Protect|p1a: ${lead1}`,
    `|move|p2a: ${lead2}|U-turn|p1a: ${lead1}`,
  ];
  if (opts.outcome === 'T') {
    lines.push('|tie');
  } else {
    const winner = opts.outcome === 'W' ? opts.p1Name : opts.p2Name;
    const loserLead = opts.outcome === 'W' ? `p2a: ${lead2}` : `p1a: ${lead1}`;
    lines.push(`|-damage|${loserLead}|0 fnt`, `|faint|${loserLead}`, `|win|${winner}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface PendingSmokeConfig {
  status?: 'pass' | 'fail';
  error?: string;
  bytes?: number;
  durationMillis?: number;
  turnMillis?: number;
  ram?: number;
}

export interface State {
  rngState: number;
  now: number;
  anchorNow: number;
  matchSeq: number;
  heartbeatSeq: number;
  lastMatchNumberByLadder: Record<string, number>;
  smogonSeq: number;
  discordSeq: number;
  vgcOffsetSeq: number;
  vgcOffsetBySlug: Record<string, number>;
  expectedRatings: Record<string, number>;
  matchupBiases: Record<string, number>;
  pendingSmoke: Record<string, PendingSmokeConfig>;
  liveMatch?: arena.LiveMatch;
  liveStale?: boolean;
  tournamentBroadcast?: tournaments.LiveBroadcast;
  featuredBattleId?: string;
}

export interface Options {
  db: db.Database;
  stateFile?: string;
  mockDir?: string;
  staticDir?: string;
  avatarsDir?: string;
  publicDir?: string;
  wikiDir?: string;
  laddersFile?: string;
  baseStaticDir?: string;
  baseLaddersFile?: string;
  now?: number;
  seed?: number;
  serverUrl?: string;
  arenaSecret?: string;
  sessionSecret?: string;
  log?: (line: string) => void;
  onTimeChange?: (nowSeconds: number) => void;
  onCheckpoint?: (name: string, runner: Runner) => Promise<void> | void;
  onDiscordSync?: (runner: Runner) => Promise<void> | void;
}

const ORGANIC_AGENT_POOL = [
  'BoltBeam',
  'ShowdownZero',
  'PorygonZ-RL',
  'Alabaster',
  'RegielekiNet',
  'TerastalMC',
  'PokeMCTS',
  'SmogonPPO',
  'StallBreaker',
  'FutureSight',
  'ChoiceBandit',
  'VictoryStar',
];

function createInitialState(now: number, rngSeed: number): State {
  return {
    rngState: rngSeed >>> 0,
    now,
    anchorNow: now,
    matchSeq: 0,
    heartbeatSeq: 0,
    lastMatchNumberByLadder: {},
    smogonSeq: 700000,
    discordSeq: 0,
    vgcOffsetSeq: 0,
    vgcOffsetBySlug: {},
    expectedRatings: {},
    matchupBiases: {},
    pendingSmoke: {},
    liveMatch: undefined,
    liveStale: false,
    tournamentBroadcast: undefined,
    featuredBattleId: undefined,
  };
}

export class Runner {
  readonly db: db.Database;
  readonly staticDir: string;
  readonly avatarsDir: string;
  readonly projectsFile: string;
  readonly laddersFile: string;
  readonly publicDir?: string;
  readonly wikiDir?: string;
  readonly mockDir?: string;
  readonly stateFile?: string;
  private readonly baseStaticDir: string;
  private readonly baseLaddersFile: string;
  private readonly serverUrl?: string;
  private readonly arenaSecret?: string;
  private readonly arenaClient?: arena.Client;
  private readonly sessionSecret?: string;
  private readonly log: (line: string) => void;
  private readonly onTimeChange?: (nowSeconds: number) => void;
  private readonly onCheckpoint?: (name: string, runner: Runner) => Promise<void> | void;
  private readonly onDiscordSync?: (runner: Runner) => Promise<void> | void;
  private readonly devCookies: Map<string, string>;
  state: State;

  constructor(options: Options) {
    this.db = options.db;
    this.mockDir = options.mockDir;
    this.baseStaticDir = options.baseStaticDir ?? root('static');
    this.baseLaddersFile = options.baseLaddersFile ?? root('config', 'ladders.yml');
    this.staticDir = options.staticDir ?? (
      options.mockDir
        ? path.join(options.mockDir, 'static')
        : fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-mock-static-'))
    );
    this.avatarsDir = options.avatarsDir ?? path.join(this.staticDir, 'avatars');
    this.projectsFile = path.join(this.staticDir, 'projects.yml');
    this.laddersFile = options.laddersFile ??
      (options.mockDir ? path.join(options.mockDir, 'ladders.yml') : db.LADDERS_FILE);
    this.publicDir = options.publicDir;
    this.wikiDir = options.wikiDir ??
      (options.mockDir ? path.join(options.mockDir, 'wiki') : undefined);
    this.stateFile = options.stateFile ??
      (options.mockDir ? path.join(options.mockDir, 'state.json') : undefined);
    this.serverUrl = options.serverUrl?.replace(/\/+$/, '');
    this.arenaSecret = options.arenaSecret;
    const resolvedSecret = options.arenaSecret ?? process.env.ARENA_SECRET;
    this.arenaClient = this.serverUrl && resolvedSecret
      ? new arena.Client({serverUrl: this.serverUrl, arenaSecret: resolvedSecret})
      : undefined;
    this.sessionSecret = options.sessionSecret;
    this.log = options.log ?? (() => undefined);
    this.onTimeChange = options.onTimeChange;
    this.onCheckpoint = options.onCheckpoint;
    this.onDiscordSync = options.onDiscordSync;
    this.devCookies = new Map<string, string>();

    const initialNow = options.now ?? Math.floor(Date.now() / 1000);
    const initialSeed = options.seed ?? 20261110;
    if (this.stateFile && fs.existsSync(this.stateFile)) {
      const loaded = JSON.parse(
        fs.readFileSync(this.stateFile, 'utf8')
      ) as Partial<State>;
      this.state = {
        ...createInitialState(initialNow, initialSeed),
        ...loaded,
        liveMatch: loaded.liveMatch ?? undefined,
        tournamentBroadcast: loaded.tournamentBroadcast ?? undefined,
      };
      if (options.now !== undefined) {
        this.state.now = options.now;
        this.state.anchorNow = options.now;
      }
      if (options.seed !== undefined) {
        this.state.rngState = options.seed >>> 0;
      }
    } else {
      this.state = createInitialState(initialNow, initialSeed);
    }
  }

  private getArenaClient(): arena.Client {
    if (this.arenaClient) return this.arenaClient;
    if (!this.serverUrl) {
      throw new Error('No serverUrl configured for Arena HTTP client');
    }
    const secret = this.arenaSecret ?? process.env.ARENA_SECRET ?? '';
    if (!secret) {
      throw new Error('Missing ARENA_SECRET for Arena HTTP client');
    }
    return new arena.Client({serverUrl: this.serverUrl, arenaSecret: secret});
  }

  saveState() {
    if (!this.stateFile) return;
    fs.mkdirSync(path.dirname(this.stateFile), {recursive: true});
    fs.writeFileSync(this.stateFile, `${JSON.stringify(this.state, undefined, 2)}\n`, 'utf8');
  }

  nextFloat(): number {
    const step = stepMulberry32(this.state.rngState);
    this.state.rngState = step.nextState;
    return step.unit;
  }

  nextInt = (max: number): number => {
    if (max <= 1) return 0;
    return Math.min(max - 1, Math.floor(this.nextFloat() * max));
  };

  setNow(nowSeconds: number) {
    this.state.now = Math.floor(nowSeconds);
    this.onTimeChange?.(this.state.now);
  }

  buildLiveDocument(): arena.LiveDocument {
    const countsBySlot = this.db.getMatchCountsBySlot();
    const recentRaw = this.db.getRecentMatches(50);
    const targetPublic = this.publicDir ?? render.PUBLIC_DIR;
    return {
      updatedAt: this.state.now,
      stale: Boolean(this.state.liveStale),
      live: this.state.liveStale ? undefined : this.state.liveMatch,
      pageSize: 50,
      totalMatches: countsBySlot.all ?? recentRaw.length,
      countsBySlot,
      historyEndpoint: '/api/battles.json',
      recentMatches: recentRaw.map(m => arena.enrichMatchView(targetPublic, m)),
    };
  }

  async runFile(filePath: string): Promise<void> {
    const content = fs.readFileSync(filePath, 'utf8');
    await this.runScript(content);
  }

  async runScript(script: string): Promise<void> {
    const commands = parseScript(script);
    for (const cmd of commands) {
      await this.execCommand(cmd);
    }
    this.saveState();
  }

  async execLine(line: string): Promise<void> {
    const commands = parseScript(line);
    for (const cmd of commands) {
      await this.execCommand(cmd);
    }
    this.saveState();
  }

  async execTokens(tokens: string[]): Promise<void> {
    if (!tokens.length) return;
    await this.execCommand(parseCommandTokens(tokens));
    this.saveState();
  }

  async execCommand(cmd: Command): Promise<void> {
    const verb = cmd.positional[0]?.toLowerCase();
    if (!verb) return;

    switch (verb) {
      case 'reset':
        this.cmdReset(cmd);
        return;
      case 'time':
        this.cmdTime(cmd);
        return;
      case 'rng':
        this.cmdRng(cmd);
        return;
      case 'checkpoint':
        if (this.onCheckpoint) {
          const name = cmd.positional[1] ?? '';
          await this.onCheckpoint(name, this);
        }
        return;
      case 'register':
        await this.cmdRegister(cmd);
        return;
      case 'qualify':
        this.cmdSetQualification(cmd, 'qualified');
        return;
      case 'disable':
        this.cmdSetQualification(cmd, 'disabled');
        return;
      case 'reassign':
        this.cmdReassign(cmd);
        return;
      case 'refund-cooldown':
        this.cmdRefundCooldown(cmd);
        return;
      case 'discord':
        await this.cmdDiscord(cmd);
        return;
      case 'ladder':
        await this.cmdLadder(cmd);
        return;
      case 'submit':
        await this.cmdSubmit(cmd);
        return;
      case 'smoke':
        await this.cmdSmoke(cmd);
        return;
      case 'quarantine':
        await this.cmdQuarantine(cmd);
        return;
      case 'unquarantine':
        this.cmdUnquarantine(cmd);
        return;
      case 'play':
        await this.cmdPlay(cmd);
        return;
      case 'settle':
        await this.cmdSettle(cmd);
        return;
      case 'match':
        await this.cmdMatch(cmd);
        return;
      case 'live':
        await this.cmdLive(cmd);
        return;
      case 'tournament':
        await this.cmdTournament(cmd);
        return;
      case 'wiki':
        await this.cmdWiki(cmd);
        return;
      case 'render':
        this.cmdRender();
        return;
      case 'simulate':
        await this.cmdSimulate(cmd);
        return;
      default:
        throw new Error(`Unknown mock command "${verb}" at line ${cmd.lineNumber}: ${cmd.raw}`);
    }
  }

  private ensureStaticInitialized() {
    fs.mkdirSync(this.staticDir, {recursive: true});
    fs.mkdirSync(this.avatarsDir, {recursive: true});
    for (const name of ['index.css', 'projects.bib', 'projects.dj', 'projects.ts', 'arena.dj']) {
      const src = path.join(this.baseStaticDir, name);
      const dst = path.join(this.staticDir, name);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
      }
    }
    if (!fs.existsSync(this.projectsFile)) {
      const baseProjects = path.join(this.baseStaticDir, 'projects.yml');
      fs.copyFileSync(baseProjects, this.projectsFile);
    }
    const zeroPngPath = path.join(this.avatarsDir, '0-error.png');
    if (!fs.existsSync(zeroPngPath)) {
      fs.writeFileSync(zeroPngPath, Buffer.from(ZERO_ERROR_PNG_BASE64, 'base64'));
    }
    if (!fs.existsSync(this.laddersFile) && fs.existsSync(this.baseLaddersFile)) {
      fs.mkdirSync(path.dirname(this.laddersFile), {recursive: true});
      fs.copyFileSync(this.baseLaddersFile, this.laddersFile);
    }
  }

  private clearDatabaseTables() {
    this.db.db.exec('PRAGMA foreign_keys = OFF;');
    try {
      const tables = this.db.db.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'`
      ).all() as Array<{name: string}>;
      this.db.inTransaction(() => {
        for (const {name} of tables) {
          this.db.db.exec(`DELETE FROM "${name.replace(/"/g, '""')}";`);
        }
      });
    } finally {
      this.db.db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  private cmdReset(cmd: Command) {
    const seedFlag = getFlag(cmd, 'seed');
    const nowFlag = getFlag(cmd, 'now');
    const openLadders = hasFlag(cmd, 'open-ladders');

    const nextSeed = seedFlag !== undefined ? Number(seedFlag) : 20261110;
    const nextAnchorNow = nowFlag !== undefined
      ? parseTimestampSpec(nowFlag, this.state.now, this.state.anchorNow)
      : this.state.anchorNow;

    this.state = createInitialState(nextAnchorNow, nextSeed);
    this.onTimeChange?.(this.state.now);
    this.devCookies.clear();
    this.clearDatabaseTables();

    fs.mkdirSync(this.staticDir, {recursive: true});
    fs.mkdirSync(this.avatarsDir, {recursive: true});
    for (const name of ['index.css', 'projects.bib', 'projects.dj', 'projects.ts', 'arena.dj']) {
      const src = path.join(this.baseStaticDir, name);
      const dst = path.join(this.staticDir, name);
      if (fs.existsSync(src) && src !== dst) {
        fs.copyFileSync(src, dst);
      }
    }

    const baseProjects = path.join(this.baseStaticDir, 'projects.yml');
    if (path.resolve(baseProjects) !== path.resolve(this.projectsFile)) {
      const parsed = (yaml.parse(fs.readFileSync(baseProjects, 'utf8')) ?? []) as Project[];
      for (const proj of parsed) {
        delete proj.arena;
      }
      fs.writeFileSync(this.projectsFile, yaml.stringify(parsed), 'utf8');
    }
    fs.writeFileSync(
      path.join(this.avatarsDir, '0-error.png'),
      Buffer.from(ZERO_ERROR_PNG_BASE64, 'base64')
    );

    if (fs.existsSync(this.baseLaddersFile)) {
      let rawLadders = fs.readFileSync(this.baseLaddersFile, 'utf8');
      if (openLadders) {
        rawLadders = rawLadders.replace(/status:\s*upcoming/g, 'status: active');
      }
      if (path.resolve(this.baseLaddersFile) !== path.resolve(this.laddersFile)) {
        fs.mkdirSync(path.dirname(this.laddersFile), {recursive: true});
        fs.writeFileSync(this.laddersFile, rawLadders, 'utf8');
        this.db.syncLadders(this.laddersFile, this.state.now);
      } else {
        this.db.syncLaddersFromYaml(rawLadders, this.state.now);
      }
    }

    if (this.mockDir) {
      fs.mkdirSync(this.mockDir, {recursive: true});
      fs.writeFileSync(
        path.join(this.mockDir, 'vgc-teams.txt'),
        `${generateValidVgcTeams(20, 42).join('\n\n')}\n`,
        'utf8'
      );
    }

    if (this.wikiDir) {
      fs.rmSync(this.wikiDir, {recursive: true, force: true});
      this.ensureWikiRepo();
    }

    this.db.syncProjects(this.projectsFile, this.avatarsDir, this.state.now);
  }

  private cmdTime(cmd: Command) {
    const spec = cmd.positional[1];
    if (!spec) throw new Error('Usage: time <+dur|-dur|now|now-dur|iso|unix>');
    this.setNow(parseTimestampSpec(spec, this.state.now, this.state.anchorNow));
  }

  private cmdRng(cmd: Command) {
    const rngSeed = Number(cmd.positional[1]);
    if (!Number.isFinite(rngSeed)) throw new Error('Usage: rng <seed>');
    this.state.rngState = rngSeed >>> 0;
  }

  private loadProjectsArray(): Project[] {
    this.ensureStaticInitialized();
    return (yaml.parse(fs.readFileSync(this.projectsFile, 'utf8')) ?? []) as Project[];
  }

  private saveProjectsArray(projects: Project[]) {
    fs.writeFileSync(this.projectsFile, yaml.stringify(projects), 'utf8');
  }

  private nextSmogonSpec(github: string, rawSmogon?: string): string {
    if (rawSmogon) {
      if (/\.\d+$/.test(rawSmogon) || /^\d+$/.test(rawSmogon)) return rawSmogon;
      this.state.smogonSeq++;
      return `${rawSmogon}.${this.state.smogonSeq}`;
    }
    const existing = this.db.getDeveloperByGitHub(github);
    if (existing) return `${existing.smogonUsername}.${existing.smogonId}`;
    this.state.smogonSeq++;
    return `${github}.${this.state.smogonSeq}`;
  }

  private nextDiscordIdentity(github: string, spec?: string): {id: string; username: string} {
    if (spec && spec !== 'auto') {
      const colon = spec.indexOf(':');
      if (colon > 0) {
        return {id: spec.slice(0, colon), username: spec.slice(colon + 1)};
      }
      if (/^\d+$/.test(spec)) {
        return {id: spec, username: github};
      }
    }
    this.state.discordSeq++;
    const id = `400000000000${String(this.state.discordSeq).padStart(6, '0')}`;
    return {id, username: spec && spec !== 'auto' ? spec : github};
  }

  private syncGuildMember(id: string, username: string) {
    this.db.db.prepare(
      'INSERT OR REPLACE INTO discord_members (id, username, updated_at) VALUES (?, ?, ?)'
    ).run(id, username, this.state.now);
  }

  private async cmdRegister(cmd: Command) {
    const name = cmd.positional[1];
    if (!name) throw new Error('Usage: register <name> [--owner <gh[:smogon]>...]');
    const slug = slugify(name).toLowerCase();
    const isPending = hasFlag(cmd, 'pending');
    const isDisabled = hasFlag(cmd, 'disabled');
    const isBanned = hasFlag(cmd, 'banned');
    const noGuild = hasFlag(cmd, 'no-guild');
    const logoFlag = getFlag(cmd, 'logo');
    const discordSpecs = cmd.flags.get('discord') ?? [];

    const rawOwners = cmd.flags.get('owner') ?? [];
    const ownerEntries: Array<{github: string; smogon: string}> = [];
    if (rawOwners.length === 0) {
      const defaultGh = `${slug.replace(/[^a-z0-9]/g, '')}dev`;
      ownerEntries.push({github: defaultGh, smogon: this.nextSmogonSpec(defaultGh)});
    } else {
      for (const raw of rawOwners) {
        const colon = raw.indexOf(':');
        const gh = (colon > 0 ? raw.slice(0, colon) : raw).trim().toLowerCase();
        const sm = colon > 0 ? raw.slice(colon + 1).trim() : undefined;
        ownerEntries.push({github: gh, smogon: this.nextSmogonSpec(gh, sm)});
      }
    }

    let logo: string | undefined;
    if (logoFlag === 'auto') {
      logo = `${slug}.png`;
      fs.mkdirSync(this.avatarsDir, {recursive: true});
      fs.writeFileSync(path.join(this.avatarsDir, logo), generateAvatarPng(slug));
    } else if (logoFlag) {
      logo = logoFlag;
      const logoPath = path.join(this.avatarsDir, logo);
      if (!fs.existsSync(logoPath)) {
        fs.mkdirSync(this.avatarsDir, {recursive: true});
        fs.writeFileSync(logoPath, generateAvatarPng(slug));
      }
    }

    const ownersMap: Record<string, string> = {};
    for (const o of ownerEntries) {
      ownersMap[o.github] = o.smogon;
    }

    const projects = this.loadProjectsArray();
    let entry = projects.find(
      p => p.name === name || (p.name && slugify(p.name).toLowerCase() === slug)
    );
    const arenaBlock: NonNullable<Project['arena']> = {
      qualified: !isPending,
      ...(logo ? {logo} : {}),
      owners: ownersMap,
    };

    if (entry) {
      entry.arena = arenaBlock;
    } else {
      entry = {
        name,
        site: 'https://pkmn.cc',
        active: new Date(this.state.now * 1000).getUTCFullYear(),
        license: 'MIT',
        source: name === '0 ERROR'
          ? 'https://github.com/pkmn/engine'
          : `https://github.com/${ownerEntries[0].github}/${slug}`,
        ...(name === '0 ERROR'
          ? {engine: {name: 'pkmn', url: 'https://github.com/pkmn/engine'}}
          : {}),
        language: name === '0 ERROR' ? ['Zig', 'TypeScript'] : ['Python', 'Rust'],
        platform: [
          {name: 'Pokémon Showdown!', url: 'https://github.com/smogon/pokemon-showdown'},
        ],
        arena: arenaBlock,
      };
      projects.unshift(entry);
    }
    this.saveProjectsArray(projects);

    if (isBanned) {
      await this.db.syncProjectsWithSmogon(this.projectsFile, {
        avatarsDir: this.avatarsDir,
        now: this.state.now,
        refreshSmogonNames: true,
        lookupSmogon: raw => {
          const s = String(raw);
          const dot = s.lastIndexOf('.');
          const id = dot > 0 ? Number(s.slice(dot + 1)) : 999999;
          const username = dot > 0 ? s.slice(0, dot) : s;
          return Promise.resolve({
            id,
            username,
            slug: username.toLowerCase(),
            url: `https://www.smogon.com/forums/members/${username.toLowerCase()}.${id}/`,
            banned: true,
          });
        },
      });
      return;
    }

    this.db.syncProjects(this.projectsFile, this.avatarsDir, this.state.now);

    if (isDisabled) {
      delete entry.arena;
      this.saveProjectsArray(projects);
      this.db.syncProjects(this.projectsFile, this.avatarsDir, this.state.now);
      return;
    }

    if (discordSpecs[0] === 'none') return;
    // Pending projects leave Discord unlinked unless `--discord` is explicitly provided.
    if (isPending && discordSpecs.length === 0) return;

    for (let idx = 0; idx < ownerEntries.length; idx++) {
      const gh = ownerEntries[idx].github;
      const spec = discordSpecs[idx] ?? (idx === 0 ? discordSpecs[0] : undefined);
      if (spec === 'none') continue;
      if (discordSpecs.length > 0 && idx > 0 && discordSpecs[idx] === undefined) continue;
      const identity = this.nextDiscordIdentity(gh, spec);
      this.db.linkDeveloperDiscord(gh, identity.id, identity.username, this.state.now);
      if (!noGuild) {
        this.syncGuildMember(identity.id, identity.username);
      }
    }
  }

  private resolveAgent(spec: string) {
    const bySlug = this.db.getAgentBySlug(spec.toLowerCase()) ??
      this.db.getAgentBySlug(slugify(spec).toLowerCase());
    if (bySlug) return bySlug;
    const targetId = toID(spec);
    const all = this.db.db.prepare('SELECT slug FROM agents').all() as Array<{slug: string}>;
    for (const row of all) {
      const a = this.db.getAgentBySlug(row.slug);
      if (a && (toID(a.name) === targetId || a.name.toLowerCase() === spec.toLowerCase())) {
        return a;
      }
    }
    throw new Error(`Unknown agent "${spec}"`);
  }

  private resolveAgentVersion(spec: string, ladderId?: string) {
    const atIdx = spec.lastIndexOf('@');
    if (atIdx > 0) {
      const agentPart = spec.slice(0, atIdx);
      const verPart = spec.slice(atIdx + 1);
      const agent = this.resolveAgent(agentPart);
      const ver = this.db.getVersionBySlugAndLabel(agent.slug, verPart);
      if (!ver) {
        throw new Error(`Version "${verPart}" not found for agent "${agent.slug}"`);
      }
      return ver;
    }
    const agent = this.resolveAgent(spec);
    if (ladderId) {
      const entries = this.db.getLeaderboardEntries(ladderId)
        .filter(e => e.agentId === agent.id && e.role !== 'retired');
      if (entries.length > 0) {
        const chosen = entries[0];
        const ver = this.db.getVersionById(chosen.versionId)!;
        return {...ver, agentSlug: agent.slug, agentName: agent.name};
      }
    }
    const history = this.db.getVersionsForAgent(agent.id);
    const passed = history.find(v => v.smokeStatus === 'passed') ?? history[0];
    if (!passed) {
      throw new Error(`Agent "${agent.slug}" has no submitted versions`);
    }
    const ver = this.db.getVersionById(passed.id)!;
    return {...ver, agentSlug: agent.slug, agentName: agent.name};
  }

  private cmdSetQualification(cmd: Command, target: 'qualified' | 'disabled') {
    const spec = cmd.positional[1];
    if (!spec) throw new Error(`Usage: ${cmd.positional[0]} <agent>`);
    const agent = this.resolveAgent(spec);
    const projects = this.loadProjectsArray();
    const proj = projects.find(
      p => p.name && slugify(p.name).toLowerCase() === agent.slug
    );
    if (!proj) throw new Error(`Project "${agent.name}" not found in ${this.projectsFile}`);
    if (target === 'disabled') {
      delete proj.arena;
    } else if (proj.arena) {
      proj.arena.qualified = true;
    }
    this.saveProjectsArray(projects);
    this.db.syncProjects(this.projectsFile, this.avatarsDir, this.state.now);
  }

  private cmdReassign(cmd: Command) {
    const github = cmd.positional[1];
    const targetRaw = cmd.positional[2] ?? (hasFlag(cmd, 'none') ? '--none' : undefined);
    if (!github || !targetRaw) {
      throw new Error('Usage: reassign <github> <target-agent|--none> [--smogon <spec>]');
    }
    const targetSlug = targetRaw === '--none' || targetRaw === 'none'
      ? undefined
      : this.resolveAgent(targetRaw).slug;
    const smogonFlag = getFlag(cmd, 'smogon');
    const existingDev = this.db.getDeveloperByGitHub(github);
    const smogonValue = smogonFlag
      ? this.nextSmogonSpec(github, smogonFlag)
      : existingDev
        ? `${existingDev.smogonUsername}.${existingDev.smogonId}`
        : this.nextSmogonSpec(github);

    this.ensureStaticInitialized();
    const updated = db.reassignDeveloperInProjectsYaml(
      fs.readFileSync(this.projectsFile, 'utf8'),
      github,
      targetSlug,
      smogonValue
    );
    fs.writeFileSync(this.projectsFile, updated.yaml, 'utf8');
    this.db.syncProjects(this.projectsFile, this.avatarsDir, this.state.now);
  }

  private cmdRefundCooldown(cmd: Command) {
    const spec = cmd.positional[1];
    if (!spec) throw new Error('Usage: refund-cooldown <agent>');
    const agent = this.resolveAgent(spec);
    this.db.refundCooldown(agent.slug, this.state.now);
  }

  private async cmdDiscord(cmd: Command) {
    const sub = cmd.positional[1]?.toLowerCase();
    if (sub === 'link') {
      const gh = cmd.positional[2]?.toLowerCase();
      if (!gh) throw new Error('Usage: discord link <github> [<id>:<username>] [--no-guild]');
      const identity = this.nextDiscordIdentity(gh, cmd.positional[3]);
      this.db.linkDeveloperDiscord(gh, identity.id, identity.username, this.state.now);
      if (!hasFlag(cmd, 'no-guild')) {
        this.syncGuildMember(identity.id, identity.username);
      }
      return;
    }
    if (sub === 'unlink') {
      const gh = cmd.positional[2]?.toLowerCase();
      if (!gh) throw new Error('Usage: discord unlink <github>');
      this.db.unlinkDeveloperDiscord(gh, this.state.now);
      return;
    }
    if (sub === 'sync') {
      if (this.onDiscordSync) {
        await this.onDiscordSync(this);
      }
      return;
    }
    throw new Error(`Unknown discord subcommand "${String(sub)}"`);
  }

  resolveLadders(spec: string): db.LadderRow[] {
    const all = this.db.getLadders();
    const trimmed = spec.trim();
    if (trimmed.toLowerCase() === 'all') {
      return all.filter(l => l.status !== 'archived');
    }
    const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
    const out: db.LadderRow[] = [];
    const seen = new Set<string>();
    for (const part of parts) {
      const lower = part.toLowerCase();
      const exact = all.find(l => l.id.toLowerCase() === lower);
      if (exact) {
        if (!seen.has(exact.id)) {
          seen.add(exact.id);
          out.push(exact);
        }
        continue;
      }
      const bySlot =
        all.find(l => l.slot === lower && (l.status === 'active' || l.status === 'upcoming')) ??
        all.find(l => l.slot === lower && l.status === 'settling') ??
        all.find(l => l.slot === lower);
      if (!bySlot) {
        throw new Error(`Unknown ladder "${part}"`);
      }
      if (!seen.has(bySlot.id)) {
        seen.add(bySlot.id);
        out.push(bySlot);
      }
    }
    return out;
  }

  private syncLadderFileStatuses() {
    if (!fs.existsSync(this.laddersFile)) return;
    if (path.resolve(this.laddersFile) === path.resolve(root('config', 'ladders.yml'))) return;
    const rows = this.db.getLadders();
    const existingCfg = (yaml.parse(fs.readFileSync(this.laddersFile, 'utf8')) ?? []) as
      db.LadderConfig[];
    const byId = new Map(existingCfg.map(c => [c.id, c]));
    const next: db.LadderConfig[] = rows.map(r => {
      const prev = byId.get(r.id);
      return {
        name: r.name,
        format: r.format,
        id: r.id,
        ...(r.discord ? {discord: r.discord} : {}),
        team: r.team,
        status: r.status,
        min: r.min,
        ...(r.teams !== undefined ? {teams: r.teams} : {}),
        ...(prev?.pools ? {pools: prev.pools} : {}),
      };
    });
    fs.writeFileSync(this.laddersFile, yaml.stringify(next), 'utf8');
  }

  private async cmdLadder(cmd: Command) {
    const sub = cmd.positional[1]?.toLowerCase();
    if (sub === 'open') {
      const targetSpec = cmd.positional[2] ?? 'all';
      for (const ladder of this.resolveLadders(targetSpec)) {
        this.db.setLadderStatus(ladder.id, 'active', this.state.now);
      }
      this.syncLadderFileStatuses();
      return;
    }
    if (sub === 'status') {
      const targetSpec = cmd.positional[2];
      const status = cmd.positional[3] as db.LadderStatus | undefined;
      if (!targetSpec || !status) {
        throw new Error('Usage: ladder status <ladders|all> <upcoming|active|settling|archived>');
      }
      for (const ladder of this.resolveLadders(targetSpec)) {
        this.db.setLadderStatus(ladder.id, status, this.state.now);
      }
      this.syncLadderFileStatuses();
      return;
    }
    if (sub === 'add') {
      const id = cmd.positional[2];
      const name = getFlag(cmd, 'name');
      const format = getFlag(cmd, 'format');
      if (!id || !name || !format) {
        throw new Error('Usage: ladder add <id> --name <title> --format <fmt> [--team <mode>]');
      }
      const team = (getFlag(cmd, 'team') ?? 'harvested') as db.TeamMode;
      const min = Number(getFlag(cmd, 'min') ?? (team === 'pools' ? 4 : 2));
      const teamCount = team === 'pools' ? Number(getFlag(cmd, 'teams') ?? 20) : undefined;
      const status = (getFlag(cmd, 'status') ?? 'active') as db.LadderStatus;
      const discord = getFlag(cmd, 'discord');

      this.ensureStaticInitialized();
      const cfgs = fs.existsSync(this.laddersFile)
        ? ((yaml.parse(fs.readFileSync(this.laddersFile, 'utf8')) ?? []) as db.LadderConfig[])
        : [];
      const filtered = cfgs.filter(c => c.id !== id);
      filtered.push({
        name,
        format,
        id,
        ...(discord ? {discord} : {}),
        team,
        status,
        min,
        ...(teamCount !== undefined ? {teams: teamCount} : {}),
      });
      if (path.resolve(this.laddersFile) !== path.resolve(root('config', 'ladders.yml'))) {
        fs.writeFileSync(this.laddersFile, yaml.stringify(filtered), 'utf8');
      }
      this.db.syncLaddersFromYaml(yaml.stringify(filtered), this.state.now);
      return;
    }
    if (sub === 'rotate') {
      const oldSpec = cmd.positional[2];
      const archiveName = getFlag(cmd, 'archive-name') ?? getFlag(cmd, 'name');
      if (!oldSpec || !archiveName) {
        throw new Error(
          'Usage: ladder rotate <old> --archive-name <title> [--new <id>] [--new-name <title>]'
        );
      }
      const oldLadder = this.resolveLadders(oldSpec)[0];
      const newMinFlag = getFlag(cmd, 'min');
      const newTeamsFlag = getFlag(cmd, 'teams');
      this.db.rotateLadder({
        oldLadderId: oldLadder.id,
        archivedName: archiveName,
        newLadderId: getFlag(cmd, 'new'),
        newName: getFlag(cmd, 'new-name'),
        newFormat: getFlag(cmd, 'format'),
        newTeam: getFlag(cmd, 'team') as db.TeamMode | undefined,
        newMin: newMinFlag !== undefined ? Number(newMinFlag) : undefined,
        newTeams: newTeamsFlag !== undefined ? Number(newTeamsFlag) : undefined,
        newDiscord: getFlag(cmd, 'discord'),
        now: this.state.now,
      });
      this.syncLadderFileStatuses();
      return;
    }
    if (sub === 'anchor') {
      const targetSpec = cmd.positional[2];
      const verSpec = cmd.positional[3];
      if (!targetSpec || !verSpec) {
        throw new Error('Usage: ladder anchor <ladders|all> <agent>[@<ver>]');
      }
      for (const ladder of this.resolveLadders(targetSpec)) {
        const ver = this.resolveAgentVersion(verSpec, ladder.id);
        this.db.setLadderAnchor(ladder.id, ver.agentSlug, ver.version, this.state.now);
      }
      return;
    }
    if (sub === 'archive') {
      const targetSpec = cmd.positional[2];
      if (!targetSpec) throw new Error('Usage: ladder archive <ladder> [--file <path>]');
      const ladder = this.resolveLadders(targetSpec)[0];
      const srcFile = getFlag(cmd, 'file');
      const bytes = srcFile && fs.existsSync(srcFile)
        ? fs.readFileSync(srcFile)
        : Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]);
      if (this.serverUrl) {
        await this.getArenaClient().uploadLadderArchive(ladder.id, bytes);
      } else {
        const pubDir = this.publicDir ?? render.PUBLIC_DIR;
        const dstDir = path.join(pubDir, 'arena', 'ladders', ladder.id);
        fs.mkdirSync(dstDir, {recursive: true});
        fs.writeFileSync(path.join(dstDir, `${ladder.id}-logs.7z`), bytes);
      }
      return;
    }
    throw new Error(`Unknown ladder subcommand "${String(sub)}"`);
  }

  private async getDeveloperCookie(githubLogin: string): Promise<string> {
    const cached = this.devCookies.get(githubLogin);
    if (cached) return cached;

    if (this.sessionSecret) {
      let hash = 1000;
      for (let i = 0; i < githubLogin.length; i++) {
        hash = (hash * 31 + githubLogin.charCodeAt(i)) % 900000;
      }
      const token = auth.signToken(
        {
          github: {id: 1000 + hash, login: githubLogin},
          exp: Math.max(this.state.now, Math.floor(Date.now() / 1000)) + 86400,
        },
        this.sessionSecret
      );
      const cookie = `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`;
      this.devCookies.set(githubLogin, cookie);
      return cookie;
    }

    if (this.serverUrl) {
      const res = await fetch(
        `${this.serverUrl}/auth/dev?github=${encodeURIComponent(githubLogin)}`,
        {redirect: 'manual'}
      );
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const cookie = setCookie.split(';')[0];
        this.devCookies.set(githubLogin, cookie);
        return cookie;
      }
    }
    throw new Error(`Cannot mint session cookie for "${githubLogin}" (missing sessionSecret)`);
  }

  private getExpectedRating(
    versionId: number,
    agentSlug: string,
    targetKey: string
  ): number {
    return (
      this.state.expectedRatings[`v:${versionId}:${targetKey}`] ??
      this.state.expectedRatings[`v:${versionId}:*`] ??
      this.state.expectedRatings[`a:${agentSlug}:${targetKey}`] ??
      this.state.expectedRatings[`a:${agentSlug}:*`] ??
      1500
    );
  }

  private setExpectedRating(
    versionId: number,
    agentSlug: string,
    targetKey: string,
    elo: number
  ) {
    this.state.expectedRatings[`v:${versionId}:${targetKey}`] = elo;
    this.state.expectedRatings[`a:${agentSlug}:${targetKey}`] = elo;
  }

  private getMatchupBiasElo(
    p1VersionId: number,
    p1Slug: string,
    p2VersionId: number,
    p2Slug: string,
    p2Version: string
  ): number {
    const forward =
      this.state.matchupBiases[`${p1VersionId}:${p2Slug}@${p2Version}`] ??
      this.state.matchupBiases[`${p1VersionId}:${p2Slug}`] ??
      0;
    const backward =
      this.state.matchupBiases[`${p2VersionId}:${p1Slug}`] ??
      0;
    return forward - backward;
  }

  private nextAutoVersion(agentId: number): string {
    const history = this.db.getVersionsForAgent(agentId);
    if (history.length === 0) return '1.0.0';
    const latest = history[0].version;
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(latest);
    if (m) return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
    return `1.0.${history.length}`;
  }

  private getVgcOffsetForSlug(slug: string): number {
    const existing = this.state.vgcOffsetBySlug[slug];
    if (existing !== undefined) return existing;
    const assigned = this.state.vgcOffsetSeq++;
    this.state.vgcOffsetBySlug[slug] = assigned;
    return assigned;
  }

  private looksLikeVersionToken(token: string | undefined): boolean {
    if (!token || token.includes('=')) return false;
    return /^v?\d+\.\d+/.test(token) || /^v\d+$/.test(token);
  }

  private async cmdSubmit(cmd: Command) {
    const agentSpec = cmd.positional[1];
    if (!agentSpec) {
      throw new Error('Usage: submit <agent> [<ver>] [<target>[=<rating>] ...] [options]');
    }
    const agent = this.resolveAgent(agentSpec);
    let posIdx = 2;
    let version: string;
    if (this.looksLikeVersionToken(cmd.positional[posIdx])) {
      version = cmd.positional[posIdx];
      posIdx++;
    } else {
      version = this.nextAutoVersion(agent.id);
    }

    const ratingFlag = getFlag(cmd, 'rating');
    const fallbackRating = ratingFlag !== undefined ? Number(ratingFlag) : undefined;
    const ladderIds: string[] = [];
    const tournamentIds: string[] = [];
    const targetRatings = new Map<string, number>();

    const tourFlag = getFlag(cmd, 'tournament');
    if (tourFlag) {
      for (const tid of tourFlag.split(',').map(s => s.trim()).filter(Boolean)) {
        if (!tournamentIds.includes(tid)) tournamentIds.push(tid);
      }
    }

    for (let i = posIdx; i < cmd.positional.length; i++) {
      const raw = cmd.positional[i];
      const eq = raw.indexOf('=');
      const lhs = eq > 0 ? raw.slice(0, eq) : raw;
      const rhs = eq > 0 ? Number(raw.slice(eq + 1)) : fallbackRating;

      if (lhs.startsWith('tournament:')) {
        const tid = lhs.slice('tournament:'.length);
        if (!tournamentIds.includes(tid)) tournamentIds.push(tid);
        if (rhs !== undefined && Number.isFinite(rhs)) targetRatings.set(`tournament:${tid}`, rhs);
        continue;
      }

      for (const ladder of this.resolveLadders(lhs)) {
        if (!ladderIds.includes(ladder.id)) ladderIds.push(ladder.id);
        if (rhs !== undefined && Number.isFinite(rhs)) targetRatings.set(ladder.id, rhs);
      }
    }

    if (ladderIds.length === 0 && tournamentIds.length === 0) {
      for (const ladder of this.db.getActiveLadders()) {
        ladderIds.push(ladder.id);
        if (fallbackRating !== undefined) targetRatings.set(ladder.id, fallbackRating);
      }
    }

    const pkgFlag = getFlag(cmd, 'pkg') as 'bundle' | 'oci' | undefined;
    const pkg: 'bundle' | 'oci' = pkgFlag ??
      (tournamentIds.length > 0 && ladderIds.length === 0 ? 'oci' : 'bundle');
    const url = getFlag(cmd, 'url') ?? (
      pkg === 'oci'
        ? `ghcr.io/pkmn-mock/${agent.slug}:${version}`
        : `https://r2.pkmn.cc/${agent.slug}-${version}.tar.zst`
    );
    const sha256 = getFlag(cmd, 'sha256') ?? sha256OfTag(`${agent.slug}-${version}`);
    const authToken = getFlag(cmd, 'auth-token');
    const byFlag = getFlag(cmd, 'by');
    const devs = this.db.getDevelopersForAgent(agent.id);
    const dev = byFlag
      ? this.db.getDeveloperByGitHub(byFlag)
      : devs[0];

    const teamsFlag = getFlag(cmd, 'teams') ?? 'auto';
    let rawVgcTeams: string[] | undefined;
    const poolsLadders = ladderIds
      .map(id => this.db.getLadder(id)!)
      .filter(l => l?.team === 'pools');

    if (poolsLadders.length > 0 && teamsFlag !== 'none') {
      const needsTeams = teamsFlag !== 'auto' ||
        poolsLadders.some(l => !this.db.hasActiveLadderTeams(l.id, agent.id));
      if (needsTeams) {
        if (teamsFlag === 'auto' || teamsFlag === 'new') {
          const offset = teamsFlag === 'new'
            ? (this.state.vgcOffsetSeq++)
            : this.getVgcOffsetForSlug(agent.slug);
          rawVgcTeams = generateValidVgcTeams(20, offset);
        } else {
          rawVgcTeams = teams.splitSubmittedTeams(fs.readFileSync(teamsFlag, 'utf8'));
        }
      }
    }

    const smokeMode = (getFlag(cmd, 'smoke') ?? 'pass').toLowerCase() as
      'pass' | 'pending' | 'fail';
    const smokeError = getFlag(cmd, 'error');
    const bytesFlag = getFlag(cmd, 'bytes');
    const durFlag = getFlag(cmd, 'duration-millis');
    const turnFlag = getFlag(cmd, 'turn-millis');
    const ramFlag = getFlag(cmd, 'ram');
    const pendingMeta: PendingSmokeConfig = {
      status: smokeMode === 'fail' ? 'fail' : 'pass',
      ...(smokeError !== undefined ? {error: smokeError} : {}),
      ...(bytesFlag !== undefined ? {bytes: parseBytesSpec(bytesFlag)} : {}),
      ...(durFlag !== undefined ? {durationMillis: Number(durFlag)} : {}),
      ...(turnFlag !== undefined ? {turnMillis: Number(turnFlag)} : {}),
      ...(ramFlag !== undefined ? {ram: Number(ramFlag)} : {}),
    };

    let versionId: number;
    if (this.serverUrl) {
      if (!dev) {
        throw new Error(`No developer registered for agent "${agent.slug}" to submit via HTTP`);
      }
      const cookie = await this.getDeveloperCookie(dev.githubLogin);
      const res = await fetch(`${this.serverUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          cookie,
        },
        body: JSON.stringify({
          version,
          package: pkg,
          url,
          sha256,
          ...(authToken ? {authToken} : {}),
          ladders: ladderIds,
          ...(tournamentIds.length > 0 ? {tournaments: tournamentIds} : {}),
          ...(rawVgcTeams ? {teams: rawVgcTeams} : {}),
        }),
      });
      if (res.status !== 201) {
        const errBody = await res.text().catch(() => '');
        throw new Error(
          `POST /api/submissions for ${agent.slug}@${version} failed (${res.status}): ${errBody}`
        );
      }
      const created = this.db.getVersionBySlugAndLabel(agent.slug, version);
      if (!created) {
        throw new Error(`Submitted ${agent.slug}@${version} not found in SQLite`);
      }
      versionId = created.id;
    } else {
      const teamsByLadder: Record<string, string[]> = {};
      if (rawVgcTeams) {
        const canonical = teams.splitSubmittedTeams(rawVgcTeams);
        for (const pl of poolsLadders) {
          teamsByLadder[pl.id] = canonical;
        }
      }
      const created = this.db.createSubmission({
        agentId: agent.id,
        developerId: dev?.id,
        version,
        package: pkg,
        url,
        sha256,
        ladderIds,
        tournamentIds: tournamentIds.length > 0 ? tournamentIds : undefined,
        teamsByLadder: Object.keys(teamsByLadder).length > 0 ? teamsByLadder : undefined,
        now: this.state.now,
      });
      versionId = created.id;
    }

    if (fallbackRating !== undefined) {
      this.setExpectedRating(versionId, agent.slug, '*', fallbackRating);
    }
    for (const [key, elo] of targetRatings) {
      this.setExpectedRating(versionId, agent.slug, key, elo);
    }
    for (const tid of tournamentIds) {
      if (!targetRatings.has(`tournament:${tid}`) && fallbackRating !== undefined) {
        this.setExpectedRating(versionId, agent.slug, `tournament:${tid}`, fallbackRating);
      }
    }

    const vsList = cmd.flags.get('vs') ?? [];
    for (const vsItem of vsList) {
      for (const pair of vsItem.split(',').map(s => s.trim()).filter(Boolean)) {
        const colon = pair.lastIndexOf(':');
        if (colon <= 0) continue;
        const oppSpec = pair.slice(0, colon).trim();
        const deltaElo = Number(pair.slice(colon + 1));
        if (!Number.isFinite(deltaElo)) continue;
        if (oppSpec.includes('@')) {
          const oppVer = this.resolveAgentVersion(oppSpec);
          this.state.matchupBiases[`${versionId}:${oppVer.agentSlug}@${oppVer.version}`] = deltaElo;
        } else {
          const oppAgent = this.resolveAgent(oppSpec);
          this.state.matchupBiases[`${versionId}:${oppAgent.slug}`] = deltaElo;
        }
      }
    }

    this.state.pendingSmoke[String(versionId)] = pendingMeta;
    if (smokeMode !== 'pending') {
      await this.smokeSpecificVersion(versionId, pendingMeta, hasFlag(cmd, 'notified'));
    }
  }

  private computeRetiredVersionIdsByLadder(
    agentId: number,
    versionId: number,
    ladderIds: string[]
  ): Record<string, number> {
    const retiredByLadder: Record<string, number> = {};
    for (const ladderId of ladderIds) {
      const active = this.db.getLeaderboardEntries(ladderId)
        .filter(e => e.agentId === agentId && e.role !== 'retired' && e.versionId !== versionId)
        .sort((a, b) => a.lcb - b.lcb || a.versionId - b.versionId);
      if (active.length >= 2) {
        retiredByLadder[ladderId] = active[0].versionId;
      }
    }
    return retiredByLadder;
  }

  private computeTelemetryForVersion(versionId: number, agentId: number) {
    return {
      bytes: (120 + ((agentId * 37 + versionId * 19) % 280)) * 1024 * 1024,
      durationMillis: 1600 + ((agentId * 173 + versionId * 89) % 2400),
      turnMillis: 210 + ((agentId * 41 + versionId * 23) % 240),
      ram: 540 + ((agentId * 131 + versionId * 67) % 1400),
    };
  }

  private async smokeSpecificVersion(
    versionId: number,
    meta: PendingSmokeConfig,
    markNotified = false
  ) {
    const ver = this.db.getVersionById(versionId);
    if (!ver) throw new Error(`Unknown versionId ${versionId}`);
    const smokeStatus = meta.status === 'fail' ? 'failed' : 'passed';
    const telemetry = this.computeTelemetryForVersion(versionId, ver.agentId);

    if (this.serverUrl) {
      const client = this.getArenaClient();
      const pendingPayload = await client.getPendingSubmissions();
      const remoteSub = pendingPayload.submissions.find(s => s.versionId === versionId);
      const ladders = remoteSub?.ladders ?? [];
      const retired = smokeStatus === 'passed'
        ? this.computeRetiredVersionIdsByLadder(ver.agentId, versionId, ladders)
        : {};
      await client.reportSubmissionStatus({
        versionId,
        smokeStatus,
        unpackedBytes: meta.bytes ?? telemetry.bytes,
        smokeDurationMillis: meta.durationMillis ?? telemetry.durationMillis,
        smokeTurnMillis: meta.turnMillis ?? telemetry.turnMillis,
        smokePeakRam: meta.ram ?? telemetry.ram,
        ...(smokeStatus === 'failed'
          ? {smokeError: meta.error ?? `Smoke test failed in ${ver.version}`}
          : {}),
        retiredVersionIdsByLadder: retired,
      });
    } else {
      const pendingRow = this.db.getPendingSubmissions().find(p => p.versionId === versionId);
      const ladders = pendingRow?.ladders ?? [];
      const retired = smokeStatus === 'passed'
        ? this.computeRetiredVersionIdsByLadder(ver.agentId, versionId, ladders)
        : {};
      this.db.applySubmissionStatus({
        versionId,
        smokeStatus,
        unpackedBytes: smokeStatus === 'passed' ? (meta.bytes ?? telemetry.bytes) : undefined,
        smokeDurationMillis: smokeStatus === 'passed'
          ? (meta.durationMillis ?? telemetry.durationMillis)
          : undefined,
        smokeTurnMillis: smokeStatus === 'passed'
          ? (meta.turnMillis ?? telemetry.turnMillis)
          : undefined,
        smokePeakRam: smokeStatus === 'passed' ? (meta.ram ?? telemetry.ram) : undefined,
        smokeError: smokeStatus === 'failed'
          ? (meta.error ?? `Smoke test failed in ${ver.version}`)
          : undefined,
        retiredVersionIdsByLadder: retired,
        now: this.state.now + 5,
      });
      if (markNotified) {
        this.db.markVersionNotified(versionId);
      }
    }
    delete this.state.pendingSmoke[String(versionId)];
  }

  private async cmdSmoke(cmd: Command) {
    const targetSpec = cmd.positional[1] ?? 'all';
    const forceFail = hasFlag(cmd, 'fail');
    const forcePass = hasFlag(cmd, 'pass');
    const errorFlag = getFlag(cmd, 'error');
    const bytesFlag = getFlag(cmd, 'bytes');
    const durFlag = getFlag(cmd, 'duration-millis');
    const turnFlag = getFlag(cmd, 'turn-millis');
    const ramFlag = getFlag(cmd, 'ram');

    let pendingList: Array<{versionId: number; agentId: number; ladders: string[]}>;
    if (this.serverUrl) {
      const payload = await this.getArenaClient().getPendingSubmissions();
      pendingList = payload.submissions;
    } else {
      pendingList = this.db.getPendingSubmissions().map(p => ({
        versionId: p.versionId,
        agentId: p.agentId,
        ladders: p.ladders,
      }));
    }

    if (targetSpec.toLowerCase() !== 'all') {
      const targetVer = this.resolveAgentVersion(targetSpec);
      pendingList = pendingList.filter(p => p.versionId === targetVer.id);
    }

    for (const sub of pendingList) {
      const stored = this.state.pendingSmoke[String(sub.versionId)] ?? {};
      const status: 'pass' | 'fail' = forceFail
        ? 'fail'
        : forcePass
          ? 'pass'
          : (stored.status ?? 'pass');
      const meta: PendingSmokeConfig = {
        status,
        error: errorFlag ?? stored.error,
        bytes: bytesFlag !== undefined ? parseBytesSpec(bytesFlag) : stored.bytes,
        durationMillis: durFlag !== undefined ? Number(durFlag) : stored.durationMillis,
        turnMillis: turnFlag !== undefined ? Number(turnFlag) : stored.turnMillis,
        ram: ramFlag !== undefined ? Number(ramFlag) : stored.ram,
      };

      if (this.serverUrl) {
        const ver = this.db.getVersionById(sub.versionId)!;
        const telemetry = this.computeTelemetryForVersion(sub.versionId, sub.agentId);
        const retired = status === 'pass'
          ? this.computeRetiredVersionIdsByLadder(sub.agentId, sub.versionId, sub.ladders)
          : {};
        await this.getArenaClient().reportSubmissionStatus({
          versionId: sub.versionId,
          smokeStatus: status === 'fail' ? 'failed' : 'passed',
          unpackedBytes: meta.bytes ?? telemetry.bytes,
          smokeDurationMillis: meta.durationMillis ?? telemetry.durationMillis,
          smokeTurnMillis: meta.turnMillis ?? telemetry.turnMillis,
          smokePeakRam: meta.ram ?? telemetry.ram,
          ...(status === 'fail'
            ? {smokeError: meta.error ?? `Boot failure in ${ver.version}`}
            : {}),
          retiredVersionIdsByLadder: retired,
        });
        delete this.state.pendingSmoke[String(sub.versionId)];
      } else {
        await this.smokeSpecificVersion(sub.versionId, meta, hasFlag(cmd, 'notified'));
      }
    }
  }

  private async cmdQuarantine(cmd: Command) {
    const spec = cmd.positional[1];
    if (!spec) throw new Error('Usage: quarantine <agent>[@<ver>] [--reason <msg>]');
    const ver = this.resolveAgentVersion(spec);
    const reason = getFlag(cmd, 'reason') ?? 'Quarantined due to repeated runtime crashes';
    const via = getFlag(cmd, 'via') ?? (this.serverUrl ? 'runner' : 'admin');
    if (via === 'runner' && this.serverUrl) {
      await this.getArenaClient().reportSubmissionStatus({
        versionId: ver.id,
        smokeStatus: 'quarantined',
        smokeError: reason,
      });
      return;
    }
    this.db.quarantineVersion(ver.agentSlug, ver.version, reason, this.state.now);
  }

  private cmdUnquarantine(cmd: Command) {
    const spec = cmd.positional[1];
    if (!spec) throw new Error('Usage: unquarantine <agent>[@<ver>]');
    const ver = this.resolveAgentVersion(spec);
    this.db.unquarantineVersion(ver.agentSlug, ver.version, this.state.now);
  }

  private sampleDavidsonSingleGame(
    expectedP1: number,
    expectedP2: number,
    biasElo: number,
    tieRate: number
  ): ratings.GameOutcome {
    const delta = (expectedP1 - expectedP2 + biasElo) / ratings.ELO_SCALE;
    const clampedTie = Math.max(0, Math.min(0.8, tieRate));
    const nu = clampedTie > 0 ? (2 * clampedTie) / (1 - clampedTie) : 0;
    const w = Math.exp(0.5 * delta);
    const l = 1 / w;
    const Z = w + l + nu;
    const u = this.nextFloat();
    if (u < w / Z) return 'W';
    if (u < (w + nu) / Z) return 'T';
    return 'L';
  }

  private buildPoolForLadder(ladder: db.LadderRow): teams.CanonicalPoolEntry[] {
    const entries = this.db.getLeaderboardEntries(ladder.id);
    const activeAgentIds = new Set(
      entries.filter(e => e.role !== 'retired').map(e => e.agentId)
    );
    const roster = this.db.getActiveRosterForLadder(ladder.id)
      .filter(r => activeAgentIds.has(r.agentId))
      .map(r => ({
        agentId: r.agentId,
        agentName: r.agentName,
        teams: r.teams.map(t => t.packed),
      }));
    return teams.buildCanonicalTeamPool(roster, ladder.format);
  }

  private resolvePoolLabelSpec(
    ladder: db.LadderRow,
    spec: string | undefined,
    sampledDefault: string | undefined
  ): string | undefined {
    if (!spec) return sampledDefault;
    if (/^(?:P[12]:)?[0-9a-f]{12}$/.test(spec)) return spec;
    const pool = this.buildPoolForLadder(ladder);
    const colon = spec.indexOf(':');
    const prefix = colon > 0 ? spec.slice(0, colon) : 'hash';
    const agentPart = colon > 0 ? spec.slice(colon + 1) : spec;
    const targetAgent = this.resolveAgent(agentPart);
    const entry = pool.find(e => e.owners.has(targetAgent.id));
    if (!entry) {
      throw new Error(`No pool team found for agent "${targetAgent.slug}" on ${ladder.id}`);
    }
    if (prefix === 'P1' || prefix === 'P2') {
      return teams.formatPoolTeamLabel(entry.canonicalPacked, prefix);
    }
    return teams.hashTeam(entry.canonicalPacked);
  }

  private buildCandidateLadderState(ladder: db.LadderRow): {
    state: ratings.LadderMatchState;
    entries: db.LeaderboardEntryView[];
  } | undefined {
    const entries = this.db.getLeaderboardEntries(ladder.id);
    const state = arena.buildLadderMatchState(
      ladder,
      entries,
      this.db.getPairAggregatesForLadder(ladder.id),
      this.state.lastMatchNumberByLadder[ladder.id] ?? 0
    );
    return state ? {state, entries} : undefined;
  }

  private async executeMatchPair(opts: {
    ladder: db.LadderRow;
    p1VersionId: number;
    p1AgentId: number;
    p1Slug: string;
    p1Name: string;
    p1Version: string;
    p2VersionId: number;
    p2AgentId: number;
    p2Slug: string;
    p2Name: string;
    p2Version: string;
    completedAt: number;
    tieRate?: number;
    faultRate?: number;
    forcedOutcome?: ratings.MatchCategory;
    g1Reason?: string;
    g2Reason?: string;
    p1TeamSpec?: string;
    p2TeamSpec?: string;
    emitHeartbeats?: boolean;
  }): Promise<{matchId: string; archivedLadder: boolean}> {
    const {ladder} = opts;
    let p1TeamLabel: string | undefined;
    let p2TeamLabel: string | undefined;
    if (ladder.team === 'pools') {
      const pool = this.buildPoolForLadder(ladder);
      const sampled = teams.samplePoolsPair(pool, opts.p1AgentId, opts.p2AgentId, this.nextInt);
      p1TeamLabel = this.resolvePoolLabelSpec(ladder, opts.p1TeamSpec, sampled.t1Label);
      p2TeamLabel = this.resolvePoolLabelSpec(ladder, opts.p2TeamSpec, sampled.t2Label);
    }

    const defaultTieRate = ladder.team === 'harvested' ? 0.025 : 0;
    const tieRate = opts.tieRate ?? defaultTieRate;
    const e1 = this.getExpectedRating(opts.p1VersionId, opts.p1Slug, ladder.id);
    const e2 = this.getExpectedRating(opts.p2VersionId, opts.p2Slug, ladder.id);
    const bias = this.getMatchupBiasElo(
      opts.p1VersionId,
      opts.p1Slug,
      opts.p2VersionId,
      opts.p2Slug,
      opts.p2Version
    );

    let g1: ratings.GameOutcome;
    let g2: ratings.GameOutcome;
    if (opts.forcedOutcome) {
      g1 = opts.forcedOutcome[0] as ratings.GameOutcome;
      g2 = opts.forcedOutcome[1] as ratings.GameOutcome;
    } else {
      g1 = this.sampleDavidsonSingleGame(e1, e2, bias, tieRate);
      g2 = this.sampleDavidsonSingleGame(e1, e2, bias, tieRate);
    }
    const category = normalizeMatchCategory(g1, g2);

    const pickReason = (outcome: ratings.GameOutcome, override?: string): string => {
      if (override) return override;
      if (outcome === 'T') return 'tie_100_turns';
      if (opts.faultRate && opts.faultRate > 0 && this.nextFloat() < opts.faultRate) {
        return this.nextInt(2) === 0 ? 'timeout' : 'crash';
      }
      return 'win';
    };

    const g1Reason = pickReason(g1, opts.g1Reason);
    const g2Reason = pickReason(g2, opts.g2Reason);
    const sampleTurns = (outcome: ratings.GameOutcome) =>
      outcome === 'T' ? 100 : (ladder.slot === 'vgc' ? 7 + this.nextInt(9) : 20 + this.nextInt(28));
    const g1Turns = sampleTurns(g1);
    const g2Turns = sampleTurns(g2);

    this.state.matchSeq++;
    this.state.lastMatchNumberByLadder[ladder.id] = this.state.matchSeq;
    const prefix = ladder.slot === 'vgc' ? 'vgc' : ladder.format;
    const matchId = `${prefix}-${String(this.state.matchSeq).padStart(7, '0')}`;

    const p1Ram = 720 + ((opts.p1VersionId * 47) % 980);
    const p2Ram = 720 + ((opts.p2VersionId * 53) % 980);
    const p1TurnMillis = 230 + ((opts.p1VersionId * 29) % 240);
    const p2TurnMillis = 240 + ((opts.p2VersionId * 31) % 240);

    if (opts.emitHeartbeats && this.serverUrl) {
      const client = this.getArenaClient();
      const inc = arena.turnIncrementSeconds(ladder.format);
      this.state.heartbeatSeq++;
      await client.sendHeartbeat({
        heartbeatSeq: this.state.heartbeatSeq,
        matchId,
        ladderId: ladder.id,
        format: ladder.format,
        game: 1,
        turn: Math.min(12, g1Turns),
        activeSlot: 'p1',
        turnStartedAt: opts.completedAt,
        turnBudgetSeconds: 145,
        incrementSeconds: inc,
        p1: {
          slug: opts.p1Slug,
          name: opts.p1Name,
          version: opts.p1Version,
          bankSeconds: 145,
          lastTurnMillis: p1TurnMillis,
          meanTurnMillis: p1TurnMillis,
          ram: p1Ram,
          ...(p1TeamLabel ? {team: p1TeamLabel} : {}),
        },
        p2: {
          slug: opts.p2Slug,
          name: opts.p2Name,
          version: opts.p2Version,
          bankSeconds: 142,
          lastTurnMillis: p2TurnMillis,
          meanTurnMillis: p2TurnMillis,
          ram: p2Ram,
          ...(p2TeamLabel ? {team: p2TeamLabel} : {}),
        },
      });

      this.state.heartbeatSeq++;
      await client.sendHeartbeat({
        heartbeatSeq: this.state.heartbeatSeq,
        matchId,
        ladderId: ladder.id,
        format: ladder.format,
        game: 2,
        turn: Math.min(15, g2Turns),
        activeSlot: 'p2',
        turnStartedAt: opts.completedAt,
        turnBudgetSeconds: 136,
        incrementSeconds: inc,
        game1Summary: {
          ...(g1 === 'W'
            ? {winnerSlot: 'p1' as const}
            : g1 === 'L'
              ? {winnerSlot: 'p2' as const}
              : {}),
          turns: g1Turns,
        },
        p1: {
          slug: opts.p1Slug,
          name: opts.p1Name,
          version: opts.p1Version,
          bankSeconds: 138,
          lastTurnMillis: p1TurnMillis,
          meanTurnMillis: p1TurnMillis,
          ram: p1Ram,
          ...(p2TeamLabel ? {team: p2TeamLabel} : {}),
        },
        p2: {
          slug: opts.p2Slug,
          name: opts.p2Name,
          version: opts.p2Version,
          bankSeconds: 136,
          lastTurnMillis: p2TurnMillis,
          meanTurnMillis: p2TurnMillis,
          ram: p2Ram,
          ...(p1TeamLabel ? {team: p1TeamLabel} : {}),
        },
      });
    }

    const matchPayload = {
      id: matchId,
      ladderId: ladder.id,
      p1VersionId: opts.p1VersionId,
      p2VersionId: opts.p2VersionId,
      seed: `100,200,300,${this.state.matchSeq}`,
      ...(p1TeamLabel !== undefined ? {p1TeamLabel} : {}),
      ...(p2TeamLabel !== undefined ? {p2TeamLabel} : {}),
      game1Outcome: g1,
      game2Outcome: g2,
      category,
      game1Turns: g1Turns,
      game2Turns: g2Turns,
      game1EndReason: g1Reason,
      game2EndReason: g2Reason,
      p1PeakRam: p1Ram,
      p2PeakRam: p2Ram,
      p1Game1BankSeconds: 95 + this.nextInt(55),
      p1Game2BankSeconds: 90 + this.nextInt(55),
      p2Game1BankSeconds: 92 + this.nextInt(55),
      p2Game2BankSeconds: 88 + this.nextInt(55),
      p1MeanTurnMillis: p1TurnMillis,
      p2MeanTurnMillis: p2TurnMillis,
      completedAt: opts.completedAt,
    };

    const archivedLadder = this.serverUrl
      ? (await this.getArenaClient().completeMatch({match: matchPayload})).archivedLadder
      : this.db.recordCompletedMatch({match: matchPayload}).archivedLadder;
    if (archivedLadder) {
      this.syncLadderFileStatuses();
    }
    this.state.featuredBattleId = matchId;
    return {matchId, archivedLadder};
  }

  async playNextScheduledMatch(opts: {
    ladders?: db.LadderRow[];
    completedAt?: number;
    exploit?: number;
    tieRate?: number;
    faultRate?: number;
    emitHeartbeats?: boolean;
  } = {}): Promise<{matchId: string; ladderId: string; archivedLadder: boolean} | undefined> {
    const targetLadders = opts.ladders ?? this.db.getPlayableLadders();
    const candidates: Array<{
      ladder: db.LadderRow;
      state: ratings.LadderMatchState;
      entries: db.LeaderboardEntryView[];
    }> = [];
    for (const l of targetLadders) {
      const refreshed = this.db.getLadder(l.id);
      if (!refreshed) continue;
      const built = this.buildCandidateLadderState(refreshed);
      if (built) candidates.push({ladder: refreshed, ...built});
    }
    if (!candidates.length) return undefined;

    const choice = ratings.selectNextArenaMatch(
      candidates.map(c => c.state),
      this.state.matchSeq + 1,
      opts.exploit ?? 0.45
    );
    const chosenLadder = candidates.find(c => c.ladder.id === choice.ladderId)!;
    const e1 = chosenLadder.entries[choice.agentI];
    const e2 = chosenLadder.entries[choice.agentJ];

    const at = opts.completedAt ?? this.state.now;
    const res = await this.executeMatchPair({
      ladder: chosenLadder.ladder,
      p1VersionId: e1.versionId,
      p1AgentId: e1.agentId,
      p1Slug: e1.agentSlug,
      p1Name: e1.agentName,
      p1Version: e1.version,
      p2VersionId: e2.versionId,
      p2AgentId: e2.agentId,
      p2Slug: e2.agentSlug,
      p2Name: e2.agentName,
      p2Version: e2.version,
      completedAt: at,
      tieRate: opts.tieRate,
      faultRate: opts.faultRate,
      emitHeartbeats: opts.emitHeartbeats,
    });
    return {
      matchId: res.matchId,
      ladderId: chosenLadder.ladder.id,
      archivedLadder: res.archivedLadder,
    };
  }

  private async playBalancedMatch(opts: {
    ladders?: db.LadderRow[];
    completedAt: number;
    tieRate?: number;
    faultRate?: number;
    emitHeartbeats?: boolean;
  }): Promise<boolean> {
    const targetLadders = (opts.ladders ?? this.db.getPlayableLadders()).filter(l => {
      const cur = this.db.getLadder(l.id);
      if (!cur || (cur.status !== 'active' && cur.status !== 'settling')) return false;
      const active = this.db.getLeaderboardEntries(cur.id).filter(e => e.role !== 'retired');
      return new Set(active.map(e => e.agentId)).size >= cur.min;
    });
    if (targetLadders.length === 0) return false;

    const chosenLadder = targetLadders.slice().sort(
      (a, b) =>
        (this.state.lastMatchNumberByLadder[a.id] ?? 0) -
        (this.state.lastMatchNumberByLadder[b.id] ?? 0)
    )[0];
    const active = this.db.getLeaderboardEntries(chosenLadder.id).filter(e => e.role !== 'retired');
    const pairCounts = new Map<string, number>();
    for (const p of this.db.getPairAggregatesForLadder(chosenLadder.id)) {
      pairCounts.set(
        `${p.lowVersionId}:${p.highVersionId}`,
        p.ww + p.wt + p.split + p.tl + p.ll
      );
    }

    let bestPair: [typeof active[number], typeof active[number]] | undefined;
    let bestScore = -1;
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i];
        const b = active[j];
        const low = Math.min(a.versionId, b.versionId);
        const high = Math.max(a.versionId, b.versionId);
        const mij = pairCounts.get(`${low}:${high}`) ?? 0;
        const diff = (a.elo - b.elo) / ratings.ELO_SCALE;
        const p = 1 / (1 + Math.exp(-diff));
        const score = (0.35 + 4 * p * (1 - p)) / ((1 + mij) * (1 + mij));
        if (score > bestScore) {
          bestScore = score;
          bestPair = [a, b];
        }
      }
    }
    if (!bestPair) return false;

    const [e1, e2] = bestPair;
    await this.executeMatchPair({
      ladder: chosenLadder,
      p1VersionId: e1.versionId,
      p1AgentId: e1.agentId,
      p1Slug: e1.agentSlug,
      p1Name: e1.agentName,
      p1Version: e1.version,
      p2VersionId: e2.versionId,
      p2AgentId: e2.agentId,
      p2Slug: e2.agentSlug,
      p2Name: e2.agentName,
      p2Version: e2.version,
      completedAt: opts.completedAt,
      tieRate: opts.tieRate,
      faultRate: opts.faultRate,
      emitHeartbeats: opts.emitHeartbeats,
    });
    return true;
  }

  private async cmdPlay(cmd: Command) {
    const count = cmd.positional[1] !== undefined ? Number(cmd.positional[1]) : 1;
    if (!Number.isFinite(count) || count < 0) throw new Error('Usage: play [<count>] [options]');
    const ladderFlag = getFlag(cmd, 'ladder');
    const overFlag = getFlag(cmd, 'over');
    const tieRateFlag = getFlag(cmd, 'tie-rate');
    const faultRateFlag = getFlag(cmd, 'fault-rate');
    const exploitFlag = getFlag(cmd, 'exploit');
    const balanced = hasFlag(cmd, 'balanced');
    const emitHeartbeats = hasFlag(cmd, 'heartbeats');

    const ladders = ladderFlag ? this.resolveLadders(ladderFlag) : undefined;
    const startAt = this.state.now;
    const spanSeconds = overFlag ? parseDurationSeconds(overFlag) : 0;
    const exploit = exploitFlag !== undefined ? Number(exploitFlag) : 0.45;
    const tieRate = tieRateFlag !== undefined ? Number(tieRateFlag) : undefined;
    const faultRate = faultRateFlag !== undefined ? Number(faultRateFlag) : undefined;

    for (let i = 0; i < count; i++) {
      const stepAt = spanSeconds > 0
        ? startAt + Math.floor(((i + 1) * spanSeconds) / count)
        : this.state.now + 1;
      this.setNow(stepAt);
      const played = balanced
        ? await this.playBalancedMatch({
          ladders,
          completedAt: stepAt,
          tieRate,
          faultRate,
          emitHeartbeats,
        })
        : Boolean(await this.playNextScheduledMatch({
          ladders,
          completedAt: stepAt,
          exploit,
          tieRate,
          faultRate,
          emitHeartbeats,
        }));
      if (!played) break;
    }
  }

  private async cmdSettle(cmd: Command) {
    const targetSpec = cmd.positional[1] ?? 'all';
    const maxSteps = Number(getFlag(cmd, 'max') ?? 8000);
    const overFlag = getFlag(cmd, 'over');
    const tieRateFlag = getFlag(cmd, 'tie-rate');
    const emitHeartbeats = hasFlag(cmd, 'heartbeats');
    const divisor = Math.max(1, Math.min(maxSteps, 250));
    const stepSeconds = overFlag
      ? Math.max(1, Math.floor(parseDurationSeconds(overFlag) / divisor))
      : 60;
    const tieRate = tieRateFlag !== undefined ? Number(tieRateFlag) : undefined;

    for (let step = 0; step < maxSteps; step++) {
      const unsettleCandidates: Array<{
        ladder: db.LadderRow;
        active: db.LeaderboardEntryView[];
        unsettled: db.LeaderboardEntryView[];
      }> = [];

      for (const l of this.resolveLadders(targetSpec)) {
        const cur = this.db.getLadder(l.id);
        if (!cur || (cur.status !== 'active' && cur.status !== 'settling')) continue;
        const active = this.db.getLeaderboardEntries(cur.id).filter(e => e.role !== 'retired');
        if (new Set(active.map(e => e.agentId)).size < cur.min) continue;
        const unsettled = active.filter(e => e.settledAt === undefined);
        if (unsettled.length > 0) {
          unsettleCandidates.push({ladder: cur, active, unsettled});
        }
      }
      if (unsettleCandidates.length === 0) break;

      unsettleCandidates.sort(
        (a, b) =>
          (this.state.lastMatchNumberByLadder[a.ladder.id] ?? 0) -
          (this.state.lastMatchNumberByLadder[b.ladder.id] ?? 0)
      );
      const chosen = unsettleCandidates[0];
      const u = chosen.unsettled.slice().sort((a, b) => {
        const aUnder = a.matches < 25 ? 1 : 0;
        const bUnder = b.matches < 25 ? 1 : 0;
        if (aUnder !== bUnder) return bUnder - aUnder;
        if (aUnder) return a.matches - b.matches;
        return b.se - a.se;
      })[0];

      const pairCounts = new Map<string, number>();
      for (const p of this.db.getPairAggregatesForLadder(chosen.ladder.id)) {
        pairCounts.set(
          `${p.lowVersionId}:${p.highVersionId}`,
          p.ww + p.wt + p.split + p.tl + p.ll
        );
      }

      let bestOpp: typeof u | undefined;
      let bestScore = -1;
      for (const cand of chosen.active) {
        if (cand.versionId === u.versionId) continue;
        const low = Math.min(u.versionId, cand.versionId);
        const high = Math.max(u.versionId, cand.versionId);
        const mij = pairCounts.get(`${low}:${high}`) ?? 0;
        const diff = (u.elo - cand.elo) / ratings.ELO_SCALE;
        const p = 1 / (1 + Math.exp(-diff));
        const unsettleBoost = cand.settledAt === undefined ? 1.5 : 1.0;
        const score = ((0.30 + 4 * p * (1 - p)) * unsettleBoost) / (1 + mij * mij);
        if (score > bestScore) {
          bestScore = score;
          bestOpp = cand;
        }
      }
      if (!bestOpp) break;

      this.setNow(this.state.now + stepSeconds);
      const isLastCheck = step === maxSteps - 1;
      await this.executeMatchPair({
        ladder: chosen.ladder,
        p1VersionId: u.versionId,
        p1AgentId: u.agentId,
        p1Slug: u.agentSlug,
        p1Name: u.agentName,
        p1Version: u.version,
        p2VersionId: bestOpp.versionId,
        p2AgentId: bestOpp.agentId,
        p2Slug: bestOpp.agentSlug,
        p2Name: bestOpp.agentName,
        p2Version: bestOpp.version,
        completedAt: this.state.now,
        tieRate,
        emitHeartbeats: emitHeartbeats && isLastCheck,
      });
    }

    if (emitHeartbeats && this.serverUrl) {
      const ladders = this.resolveLadders(targetSpec);
      this.setNow(this.state.now + stepSeconds);
      await this.playNextScheduledMatch({
        ladders,
        completedAt: this.state.now,
        exploit: 0.45,
        tieRate,
        emitHeartbeats: true,
      });
    }
  }

  private async cmdMatch(cmd: Command) {
    const ladderSpec = cmd.positional[1];
    const p1Spec = cmd.positional[2];
    const p2Spec = cmd.positional[3];
    if (!ladderSpec || !p1Spec || !p2Spec) {
      throw new Error('Usage: match <ladder> <p1>[@<ver>] <p2>[@<ver>] [options]');
    }
    const ladder = this.resolveLadders(ladderSpec)[0];
    const p1 = this.resolveAgentVersion(p1Spec, ladder.id);
    const p2 = this.resolveAgentVersion(p2Spec, ladder.id);
    const count = Number(getFlag(cmd, 'count') ?? 1);
    const overFlag = getFlag(cmd, 'over');
    const span = overFlag ? parseDurationSeconds(overFlag) : 0;
    const startAt = this.state.now;

    const outcomeRaw = getFlag(cmd, 'outcome')?.toUpperCase();
    const forcedOutcome = outcomeRaw && outcomeRaw !== 'AUTO'
      ? parseExplicitOutcome(outcomeRaw)
      : undefined;
    const reason = getFlag(cmd, 'reason');
    const g1Reason = getFlag(cmd, 'g1-reason') ?? reason;
    const g2Reason = getFlag(cmd, 'g2-reason') ?? reason;
    const tieRateFlag = getFlag(cmd, 'tie-rate');
    const tieRate = tieRateFlag !== undefined ? Number(tieRateFlag) : undefined;
    const p1TeamSpec = getFlag(cmd, 'p1-team');
    const p2TeamSpec = getFlag(cmd, 'p2-team');
    const emitHeartbeats = hasFlag(cmd, 'heartbeats');

    for (let i = 0; i < count; i++) {
      const stepAt = span > 0
        ? startAt + Math.floor(((i + 1) * span) / count)
        : this.state.now + 1;
      this.setNow(stepAt);
      await this.executeMatchPair({
        ladder,
        p1VersionId: p1.id,
        p1AgentId: p1.agentId,
        p1Slug: p1.agentSlug,
        p1Name: p1.agentName,
        p1Version: p1.version,
        p2VersionId: p2.id,
        p2AgentId: p2.agentId,
        p2Slug: p2.agentSlug,
        p2Name: p2.agentName,
        p2Version: p2.version,
        completedAt: stepAt,
        tieRate,
        forcedOutcome,
        g1Reason,
        g2Reason,
        p1TeamSpec,
        p2TeamSpec,
        emitHeartbeats,
      });
    }
  }

  private async cmdLive(cmd: Command) {
    const sub = cmd.positional[1]?.toLowerCase();
    if (sub === 'idle') {
      this.state.liveMatch = undefined;
      this.state.liveStale = false;
      if (this.serverUrl) {
        await this.getArenaClient().sendHeartbeat({idle: true});
      }
      return;
    }
    if (sub === 'stale') {
      this.state.liveMatch = undefined;
      this.state.liveStale = true;
      return;
    }
    if (sub === 'match') {
      const ladderSpec = cmd.positional[2];
      const p1Spec = cmd.positional[3];
      const p2Spec = cmd.positional[4];
      if (!ladderSpec || !p1Spec || !p2Spec) {
        throw new Error('Usage: live match <ladder> <p1>[@<ver>] <p2>[@<ver>] [options]');
      }
      const ladder = this.resolveLadders(ladderSpec)[0];
      const p1 = this.resolveAgentVersion(p1Spec, ladder.id);
      const p2 = this.resolveAgentVersion(p2Spec, ladder.id);
      const game: 1 | 2 = Number(getFlag(cmd, 'game') ?? 1) === 2 ? 2 : 1;
      const turn = Number(getFlag(cmd, 'turn') ?? 9);
      const activeSlot: 'p1' | 'p2' = getFlag(cmd, 'active') === 'p2' ? 'p2' : 'p1';
      const g1WinnerRaw = getFlag(cmd, 'g1-winner') ?? 'p1';
      const g1Winner: 'p1' | 'p2' | undefined =
        g1WinnerRaw === 'p2' ? 'p2' : g1WinnerRaw === 'tie' ? undefined : 'p1';
      const g1Turns = Number(getFlag(cmd, 'g1-turns') ?? 11);

      let p1Team: string | undefined;
      let p2Team: string | undefined;
      if (ladder.team === 'pools') {
        const pool = this.buildPoolForLadder(ladder);
        const sampled = teams.samplePoolsPair(pool, p1.agentId, p2.agentId, this.nextInt);
        p1Team = this.resolvePoolLabelSpec(ladder, getFlag(cmd, 'p1-team'), sampled.t1Label);
        p2Team = this.resolvePoolLabelSpec(ladder, getFlag(cmd, 'p2-team'), sampled.t2Label);
      }

      this.state.heartbeatSeq++;
      const matchId = getFlag(cmd, 'id') ?? `${ladder.slot}-live-${this.state.heartbeatSeq}`;
      const inc = arena.turnIncrementSeconds(ladder.format);
      const liveMatch: arena.LiveMatch = {
        heartbeatSeq: this.state.heartbeatSeq,
        matchId,
        ladderId: ladder.id,
        slot: ladder.slot,
        format: ladder.format,
        game,
        turn,
        activeSlot,
        turnStartedAt: this.state.now - 4,
        turnBudgetSeconds: 138,
        incrementSeconds: inc,
        ...(game === 2 ? {game1Summary: {winnerSlot: g1Winner, turns: g1Turns}} : {}),
        p1: {
          slug: p1.agentSlug,
          name: p1.agentName,
          version: p1.version,
          bankSeconds: Number(getFlag(cmd, 'p1-bank') ?? 142),
          lastTurnMillis: 290,
          meanTurnMillis: 280,
          ram: p1.smokePeakRam ?? 890,
          ...(p1Team ? {team: p1Team} : {}),
        },
        p2: {
          slug: p2.agentSlug,
          name: p2.agentName,
          version: p2.version,
          bankSeconds: Number(getFlag(cmd, 'p2-bank') ?? 128),
          lastTurnMillis: 340,
          meanTurnMillis: 315,
          ram: p2.smokePeakRam ?? 1420,
          ...(p2Team ? {team: p2Team} : {}),
        },
      };

      this.state.liveMatch = liveMatch;
      this.state.liveStale = false;
      if (this.serverUrl) {
        await this.getArenaClient().sendHeartbeat(liveMatch);
      }
      return;
    }
    throw new Error(`Unknown live subcommand "${String(sub)}"`);
  }

  private recomputeTournamentStandings(tournamentId: string, assignFinalRanks = false) {
    const entrants = this.db.getTournamentEntrants(tournamentId)
      .slice()
      .sort((a, b) => a.seed - b.seed || a.versionId - b.versionId);
    if (!entrants.length) return;

    const allGames = this.db.getTournamentGames(tournamentId, 100000)
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));

    const M = entrants.length;
    const idxByVer = new Map<number, number>();
    entrants.forEach((e, idx) => idxByVer.set(e.versionId, idx));

    const wins = new Int32Array(M);
    const losses = new Int32Array(M);
    const ties = new Int32Array(M);
    const pairScore = new Float64Array(M * M);
    const sfScore = new Float64Array(M);
    const singleGames: SingleGameRecord[] = [];

    for (const g of allGames) {
      if (!g.outcome) continue;
      const i = idxByVer.get(g.p1VersionId);
      const j = idxByVer.get(g.p2VersionId);
      if (i === undefined || j === undefined) continue;
      singleGames.push({i, j, outcome: g.outcome});

      if (g.stage === 'Superfinal') {
        if (g.outcome === 'W') {
          sfScore[i] += 1;
        } else if (g.outcome === 'L') {
          sfScore[j] += 1;
        } else {
          sfScore[i] += 0.5;
          sfScore[j] += 0.5;
        }
        continue;
      }

      if (g.outcome === 'W') {
        wins[i]++;
        losses[j]++;
        pairScore[i * M + j] += 1;
      } else if (g.outcome === 'L') {
        losses[i]++;
        wins[j]++;
        pairScore[j * M + i] += 1;
      } else {
        ties[i]++;
        ties[j]++;
        pairScore[i * M + j] += 0.5;
        pairScore[j * M + i] += 0.5;
      }
    }

    const points = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      points[i] = wins[i] + 0.5 * ties[i];
    }
    const sb = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      let total = 0;
      for (let j = 0; j < M; j++) {
        if (i !== j) total += pairScore[i * M + j] * points[j];
      }
      sb[i] = Math.round(total * 100) / 100;
    }

    const ratingRes = computeSingleGameTournamentRatings(M, singleGames, -1, 1575);
    const order = entrants.map((_, idx) => idx).sort((a, b) => (
      points[b] - points[a] ||
      sb[b] - sb[a] ||
      ratingRes.elo[b] - ratingRes.elo[a] ||
      entrants[a].seed - entrants[b].seed
    ));

    if (order.length >= 2 && (sfScore[order[0]] > 0 || sfScore[order[1]] > 0)) {
      if (sfScore[order[1]] > sfScore[order[0]]) {
        const tmp = order[0];
        order[0] = order[1];
        order[1] = tmp;
      }
    }

    const rankByIdx = new Int32Array(M);
    order.forEach((entIdx, rankZero) => {
      rankByIdx[entIdx] = rankZero + 1;
    });

    for (let i = 0; i < M; i++) {
      const ent = entrants[i];
      this.db.upsertTournamentEntrant({
        tournamentId,
        agentId: ent.agentId,
        versionId: ent.versionId,
        seed: ent.seed,
        finalRank: assignFinalRanks ? rankByIdx[i] : ent.finalRank,
        elo: singleGames.length > 0 ? ratingRes.elo[i] : ent.elo,
        se: singleGames.length > 0 ? ratingRes.se[i] : ent.se,
        gameWins: wins[i],
        gameLosses: losses[i],
        gameTies: ties[i],
        points: points[i],
        sonnebornBerger: sb[i],
      });
    }
  }

  private async cmdTournament(cmd: Command) {
    const sub = cmd.positional[1]?.toLowerCase();
    if (sub === 'create') {
      const id = cmd.positional[2];
      const name = getFlag(cmd, 'name');
      const format = getFlag(cmd, 'format');
      if (!id || !name || !format) {
        throw new Error('Usage: tournament create <id> --name <title> --format <fmt> [options]');
      }
      const startsRaw = getFlag(cmd, 'starts');
      const startsAt = startsRaw
        ? parseTimestampSpec(startsRaw, this.state.now, this.state.anchorNow)
        : this.state.now + 7 * 86400;
      const status = (getFlag(cmd, 'status') ?? 'scheduled') as db.TournamentStatus;
      this.db.upsertTournament({
        id,
        name,
        format,
        rulesJson: getFlag(cmd, 'rules') ?? '[]',
        gamesPerMatchup: Number(getFlag(cmd, 'games') ?? 8),
        batchSize: Number(getFlag(cmd, 'batch') ?? 10),
        parallelTables: Number(getFlag(cmd, 'tables') ?? 2),
        hardware: getFlag(cmd, 'hardware') ?? 'GCP L4 Spot · 24 vCPU · 48 GB RAM',
        status,
        startsAt,
        completedAt: status === 'completed' ? this.state.now : undefined,
      });
      return;
    }

    if (sub === 'enter') {
      const id = cmd.positional[2];
      if (!id || cmd.positional.length < 4) {
        throw new Error('Usage: tournament enter <id> <agent>[@<ver>][=<rating>] ...');
      }
      const tour = this.db.getTournament(id);
      if (!tour) throw new Error(`Unknown tournament "${id}"`);

      for (let i = 3; i < cmd.positional.length; i++) {
        const raw = cmd.positional[i];
        const eq = raw.indexOf('=');
        const verSpec = eq > 0 ? raw.slice(0, eq) : raw;
        const eloVal = eq > 0 ? Number(raw.slice(eq + 1)) : undefined;

        let resolved: {id: number; agentId: number; agentSlug: string; version: string};
        try {
          resolved = this.resolveAgentVersion(verSpec);
        } catch {
          const atIdx = verSpec.lastIndexOf('@');
          if (atIdx > 0) {
            const agentPart = verSpec.slice(0, atIdx);
            const verLabel = verSpec.slice(atIdx + 1);
            await this.execCommand(parseCommandTokens([
              'submit',
              agentPart,
              verLabel,
              '--tournament',
              id,
              '--pkg',
              getFlag(cmd, 'pkg') ?? 'oci',
              ...(eloVal !== undefined ? ['--rating', String(eloVal)] : []),
              ...(getFlag(cmd, 'by') ? ['--by', getFlag(cmd, 'by')!] : []),
            ]));
            resolved = this.resolveAgentVersion(verSpec);
          } else {
            throw new Error(`Cannot resolve entrant "${verSpec}" for tournament "${id}"`);
          }
        }

        const existingEntrants = this.db.getTournamentEntrants(id);
        if (!existingEntrants.some(e => e.versionId === resolved.id)) {
          this.db.upsertTournamentEntrant({
            tournamentId: id,
            agentId: resolved.agentId,
            versionId: resolved.id,
            seed: existingEntrants.length + 1,
            elo: 1500,
            se: 350,
            gameWins: 0,
            gameLosses: 0,
            gameTies: 0,
            points: 0,
            sonnebornBerger: 0,
          });
        }
        if (eloVal !== undefined && Number.isFinite(eloVal)) {
          this.setExpectedRating(resolved.id, resolved.agentSlug, `tournament:${id}`, eloVal);
        }
      }
      return;
    }

    if (sub === 'seed') {
      const id = cmd.positional[2];
      if (!id) throw new Error('Usage: tournament seed <id>');
      this.db.seedTournamentEntrants(id);
      return;
    }

    if (sub === 'start') {
      const id = cmd.positional[2];
      if (!id) throw new Error('Usage: tournament start <id>');
      const existingGames = this.db.getTournamentGames(id, 1);
      if (existingGames.length === 0) {
        this.db.seedTournamentEntrants(id);
      }
      this.db.setTournamentStatus(id, 'running', this.state.now);
      return;
    }

    if (sub === 'play') {
      const id = cmd.positional[2];
      if (!id) throw new Error('Usage: tournament play <id> [--cycles <c>|--games <n>|--all]');
      const tour = this.db.getTournament(id);
      if (!tour) throw new Error(`Unknown tournament "${id}"`);
      if (tour.status === 'scheduled') {
        this.db.setTournamentStatus(id, 'running', this.state.now);
      }

      const entrants = this.db.getTournamentEntrants(id)
        .slice()
        .sort((a, b) => a.seed - b.seed || a.versionId - b.versionId);
      if (entrants.length < 2) return;

      const bergerPairs = buildBergerPairings(entrants.length);
      const totalCycles = tour.gamesPerMatchup;
      const fullSchedule: Array<{
        seq: number;
        cycle: number;
        p1: typeof entrants[number];
        p2: typeof entrants[number];
      }> = [];
      let seq = 0;
      for (let c = 1; c <= totalCycles; c++) {
        for (const [idxA, idxB] of bergerPairs) {
          seq++;
          const swap = c % 2 === 0;
          fullSchedule.push({
            seq,
            cycle: c,
            p1: swap ? entrants[idxB] : entrants[idxA],
            p2: swap ? entrants[idxA] : entrants[idxB],
          });
        }
      }

      const existingRrCount = (this.db.db.prepare(
        `SELECT COUNT(*) AS cnt FROM tournament_games
         WHERE tournament_id = ? AND stage = 'Round Robin'`
      ).get(id) as {cnt: number}).cnt;

      const cyclesFlag = getFlag(cmd, 'cycles');
      const gamesFlag = getFlag(cmd, 'games');
      const playAll = hasFlag(cmd, 'all') || (!cyclesFlag && !gamesFlag);
      const gamesToPlay = playAll
        ? Math.max(0, fullSchedule.length - existingRrCount)
        : cyclesFlag !== undefined
          ? Number(cyclesFlag) * bergerPairs.length
          : Number(gamesFlag ?? 1);

      const slice = fullSchedule.slice(existingRrCount, existingRrCount + gamesToPlay);
      const overFlag = getFlag(cmd, 'over');
      const span = overFlag ? parseDurationSeconds(overFlag) : 0;
      const startAt = this.state.now;
      const tieRate = Number(getFlag(cmd, 'tie-rate') ?? (tour.format.includes('vgc') ? 0 : 0.03));
      const writeLogs = hasFlag(cmd, 'logs');
      const idPrefix = getFlag(cmd, 'id-prefix') ?? `t${id}`;

      const getEntrantExpected = (ent: typeof entrants[number]): number => {
        const direct = this.state.expectedRatings[`v:${ent.versionId}:tournament:${id}`] ??
          this.state.expectedRatings[`a:${ent.agentSlug}:tournament:${id}`];
        if (direct !== undefined) return direct;
        const formatLadder = this.db.getLadders().find(l => l.format === tour.format);
        if (formatLadder) {
          return this.getExpectedRating(ent.versionId, ent.agentSlug, formatLadder.id);
        }
        return this.getExpectedRating(ent.versionId, ent.agentSlug, '*');
      };

      for (let k = 0; k < slice.length; k++) {
        const item = slice[k];
        const at = span > 0
          ? startAt + Math.floor(((k + 1) * span) / Math.max(1, slice.length))
          : this.state.now + 1;
        this.setNow(at);

        const e1 = getEntrantExpected(item.p1);
        const e2 = getEntrantExpected(item.p2);
        const outcome = this.sampleDavidsonSingleGame(e1, e2, 0, tieRate);
        const p1Team = samplePackedTournamentTeam(tour.format, item.p1.seed + item.cycle);
        const p2Team = samplePackedTournamentTeam(tour.format, item.p2.seed + item.cycle + 1);
        const gameId = `${idPrefix}-rr-${item.seq}`;
        const isVgc = tour.format.includes('vgc');
        this.db.upsertTournamentGame({
          id: gameId,
          tournamentId: id,
          stage: 'Round Robin',
          cycle: item.cycle,
          matchupGame: item.cycle,
          p1VersionId: item.p1.versionId,
          p2VersionId: item.p2.versionId,
          seed: `10,20,${id},${item.seq}`,
          p1Team,
          p2Team,
          outcome,
          endReason: outcome === 'T' ? 'tie_100_turns' : 'win',
          turns: outcome === 'T' ? 100 : (isVgc ? 8 + this.nextInt(9) : 24 + this.nextInt(24)),
          p1BankSeconds: 70 + this.nextInt(50),
          p2BankSeconds: 60 + this.nextInt(50),
          status: 'completed',
          completedAt: at,
        });

        if (writeLogs && this.publicDir) {
          const tourDir = path.join(this.publicDir, 'arena', 'tournaments', id);
          fs.mkdirSync(tourDir, {recursive: true});
          fs.writeFileSync(
            path.join(tourDir, `${gameId}.log`),
            buildShowdownTournamentLog({
              format: tour.format,
              p1Name: item.p1.agentName,
              p2Name: item.p2.agentName,
              p1TeamPacked: p1Team,
              p2TeamPacked: p2Team,
              outcome,
            }),
            'utf8'
          );
        }
      }

      this.recomputeTournamentStandings(id, false);

      const sfRaw = getFlag(cmd, 'superfinal');
      if (sfRaw !== undefined) {
        const sfGames = sfRaw === 'true' ? 1 : Math.max(1, Number(sfRaw));
        const ranked = this.db.getTournamentEntrants(id)
          .slice()
          .sort((a, b) => (
            b.points - a.points ||
            b.sonnebornBerger - a.sonnebornBerger ||
            b.elo - a.elo ||
            a.seed - b.seed
          ));
        if (ranked.length >= 2) {
          const top1 = ranked[0];
          const top2 = ranked[1];
          for (let g = 1; g <= sfGames; g++) {
            this.setNow(this.state.now + 60);
            const p1 = g % 2 === 1 ? top1 : top2;
            const p2 = g % 2 === 1 ? top2 : top1;
            const e1 = getEntrantExpected(p1);
            const e2 = getEntrantExpected(p2);
            const outcome = this.sampleDavidsonSingleGame(e1, e2, 0, 0);
            const p1Team = samplePackedTournamentTeam(tour.format, g - 1);
            const p2Team = samplePackedTournamentTeam(tour.format, g);
            const sfId = `${idPrefix}-sf${g}`;
            this.db.upsertTournamentGame({
              id: sfId,
              tournamentId: id,
              stage: 'Superfinal',
              cycle: 1,
              matchupGame: g,
              p1VersionId: p1.versionId,
              p2VersionId: p2.versionId,
              seed: `10,20,30,${998 + g}`,
              p1Team,
              p2Team,
              outcome,
              endReason: 'win',
              turns: tour.format.includes('vgc') ? 10 : 34,
              p1BankSeconds: 88,
              p2BankSeconds: 64,
              status: 'completed',
              completedAt: this.state.now,
            });
            if (this.publicDir) {
              const tourDir = path.join(this.publicDir, 'arena', 'tournaments', id);
              fs.mkdirSync(tourDir, {recursive: true});
              fs.writeFileSync(
                path.join(tourDir, `${sfId}.log`),
                buildShowdownTournamentLog({
                  format: tour.format,
                  p1Name: p1.agentName,
                  p2Name: p2.agentName,
                  p1TeamPacked: p1Team,
                  p2TeamPacked: p2Team,
                  outcome,
                }),
                'utf8'
              );
            }
          }
          this.recomputeTournamentStandings(id, false);
        }
      }
      return;
    }

    if (sub === 'broadcast') {
      const id = cmd.positional[2];
      if (!id) throw new Error('Usage: tournament broadcast <id> [<p1> <p2> ... | --off]');
      if (hasFlag(cmd, 'off')) {
        this.state.tournamentBroadcast = undefined;
        return;
      }
      const tour = this.db.getTournament(id);
      if (!tour) throw new Error(`Unknown tournament "${id}"`);
      const entrants = this.db.getTournamentEntrants(id);
      const specs = cmd.positional.slice(3);
      const pairs: Array<[{name: string; version: string}, {name: string; version: string}]> = [];

      if (specs.length >= 2) {
        for (let i = 0; i + 1 < specs.length; i += 2) {
          const v1 = this.resolveAgentVersion(specs[i]);
          const v2 = this.resolveAgentVersion(specs[i + 1]);
          pairs.push([
            {name: v1.agentName, version: v1.version},
            {name: v2.agentName, version: v2.version},
          ]);
        }
      } else if (entrants.length >= 2) {
        pairs.push([
          {name: entrants[0].agentName, version: entrants[0].version},
          {name: entrants[1].agentName, version: entrants[1].version},
        ]);
        if (entrants.length >= 4) {
          pairs.push([
            {name: entrants[2].agentName, version: entrants[2].version},
            {name: entrants[3].agentName, version: entrants[3].version},
          ]);
        }
      }
      if (!pairs.length) return;

      const [mainP1, mainP2] = pairs[0];
      const cycle = Number(getFlag(cmd, 'cycle') ?? 4);
      const game = Number(getFlag(cmd, 'game') ?? cycle);
      const isDoubles = tour.format.includes('vgc') || tour.format.includes('doubles');
      const inc = arena.turnIncrementSeconds(tour.format);

      this.state.tournamentBroadcast = {
        tournamentId: id,
        tables: pairs.map((pr, idx) => ({
          label: `Table ${idx + 1} · ${pr[0].name} vs ${pr[1].name}`,
        })),
        seriesLeftHtml: `Round Robin · Cycle ${cycle} · Game ${game}`,
        seriesRightHtml:
          `${mainP1.name} <code>${mainP1.version}</code> vs ` +
          `${mainP2.name} <code>${mainP2.version}</code>`,
        p1: {name: mainP1.name, bankSeconds: 118, thinking: false, incrementSeconds: inc},
        p2: {name: mainP2.name, bankSeconds: 104, thinking: true, incrementSeconds: inc},
        lines: [
          `|player|p1|${mainP1.name}|1`,
          `|player|p2|${mainP2.name}|2`,
          `|gametype|${isDoubles ? 'doubles' : 'singles'}`,
          '|gen|9',
          `|tier|${isDoubles ? '[Gen 9 Champions] VGC 2026 Reg M-C' : '[Gen 9] OU'}`,
          '|turn|1',
        ],
        live: true,
      };
      return;
    }

    if (sub === 'complete') {
      const id = cmd.positional[2];
      if (!id) throw new Error('Usage: tournament complete <id> [--archive]');
      this.recomputeTournamentStandings(id, true);
      this.db.setTournamentStatus(id, 'completed', this.state.now);
      if (this.state.tournamentBroadcast?.tournamentId === id) {
        this.state.tournamentBroadcast = undefined;
      }
      if (hasFlag(cmd, 'archive')) {
        const archiveBytes = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]);
        if (this.serverUrl) {
          await this.getArenaClient().uploadTournamentArchive(id, archiveBytes);
        } else if (this.publicDir) {
          const tourDir = path.join(this.publicDir, 'arena', 'tournaments', id);
          fs.mkdirSync(tourDir, {recursive: true});
          fs.writeFileSync(path.join(tourDir, `${id}-replays.7z`), archiveBytes);
        }
      }
      return;
    }

    throw new Error(`Unknown tournament subcommand "${String(sub)}"`);
  }

  private ensureWikiRepo() {
    if (!this.wikiDir) return;
    fs.mkdirSync(this.wikiDir, {recursive: true});
    if (!fs.existsSync(path.join(this.wikiDir, '.git'))) {
      execFileSync('git', ['init', '-b', 'main'], {cwd: this.wikiDir});
      execFileSync('git', ['config', 'user.name', 'pkmn.ai'], {cwd: this.wikiDir});
      execFileSync('git', ['config', 'user.email', 'wiki@pkmn.ai'], {cwd: this.wikiDir});
    }
  }

  private async cmdWiki(cmd: Command) {
    const slug = cmd.positional[1];
    if (!slug) throw new Error('Usage: wiki <slug> (--content <djot> | --file <path>) [options]');
    const by = getFlag(cmd, 'by') ?? 'scheibo';
    const message = getFlag(cmd, 'message') ?? `Update ${slug}`;
    const visibility = getFlag(cmd, 'visibility') as wiki.PageVisibility | undefined;
    const fileFlag = getFlag(cmd, 'file');
    const contentFlag = getFlag(cmd, 'content');
    if (contentFlag === undefined && !fileFlag) {
      throw new Error(`wiki "${slug}" requires --content or --file`);
    }
    let body = fileFlag ? fs.readFileSync(fileFlag, 'utf8') : contentFlag!;
    if (!body.endsWith('\n')) body += '\n';
    if (visibility && visibility !== 'public' && !body.startsWith('{% visibility:')) {
      body = `{% visibility: ${visibility} %}\n${body}`;
    }

    const via = getFlag(cmd, 'via') ?? 'git';
    if (via === 'http' && this.serverUrl) {
      const cookie = await this.getDeveloperCookie(by);
      const form = new URLSearchParams({
        action: 'save',
        content: body,
        message,
        ...(visibility ? {visibility} : {}),
      });
      const res = await fetch(`${this.serverUrl}/wiki/${encodeURIComponent(slug)}/edit`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
        },
        body: form.toString(),
        redirect: 'manual',
      });
      if (res.status >= 400) {
        throw new Error(`POST /wiki/${slug}/edit failed (${res.status})`);
      }
      return;
    }

    if (!this.wikiDir) return;
    this.ensureWikiRepo();
    const filename = `${slug}.dj`;
    fs.writeFileSync(path.join(this.wikiDir, filename), body, 'utf8');
    const isoDate = new Date(this.state.now * 1000).toISOString();
    const env = {
      ...process.env,
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
    };
    execFileSync('git', ['add', filename], {cwd: this.wikiDir, env});
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: this.wikiDir,
      encoding: 'utf8',
    }).trim();
    if (status) {
      execFileSync(
        'git',
        ['commit', `--author=${by} <${by}@users.noreply.github.com>`, '-m', message],
        {cwd: this.wikiDir, env}
      );
    }
  }

  cmdRender(): arena.LiveDocument {
    const liveDoc = this.buildLiveDocument();
    if (this.publicDir) {
      render.renderArenaPages({
        db: this.db,
        publicDir: this.publicDir,
        staticDir: this.staticDir,
        avatarsDir: this.avatarsDir,
        liveDoc,
        tournamentBroadcast: this.state.tournamentBroadcast,
        now: this.state.now,
      });
      const liveJsonPath = path.join(this.publicDir, 'api', 'live.json');
      fs.mkdirSync(path.dirname(liveJsonPath), {recursive: true});
      fs.writeFileSync(liveJsonPath, `${JSON.stringify(liveDoc)}\n`, 'utf8');
    }
    return liveDoc;
  }

  private async cmdSimulate(cmd: Command) {
    const stepsArg = cmd.positional[1] !== undefined ? Number(cmd.positional[1]) : undefined;
    const intervalMillis = Number(getFlag(cmd, 'interval') ?? 2500);
    const overFlag = getFlag(cmd, 'over');
    const isBounded = stepsArg !== undefined;
    const totalSteps = stepsArg ?? Number.POSITIVE_INFINITY;
    const stepTimeAdvance = overFlag && stepsArg !== undefined && stepsArg > 0
      ? Math.max(1, Math.floor(parseDurationSeconds(overFlag) / stepsArg))
      : 30;

    const loopState = {running: true};
    const stop = () => {
      loopState.running = false;
    };
    if (!isBounded) {
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    }

    interface ActiveLiveSim {
      ladderSlot: string;
      p1Spec: string;
      p2Spec: string;
      stage: number;
      g1Winner: 'p1' | 'p2';
    }
    let activeLive: ActiveLiveSim | undefined;

    const runGenerated = async (commandLine: string) => {
      this.log(`[mock] ${commandLine}`);
      await this.execLine(commandLine);
    };

    try {
      for (let step = 0; loopState.running && step < totalSteps; step++) {
        if (isBounded) {
          this.setNow(this.state.now + stepTimeAdvance);
        } else {
          this.setNow(Math.max(this.state.now + 1, Math.floor(Date.now() / 1000)));
        }

        const pendingCount = this.serverUrl
          ? (await this.getArenaClient().getPendingSubmissions()).submissions.length
          : this.db.getPendingSubmissions().length;

        if (pendingCount > 0) {
          await runGenerated('smoke all --pass');
          if (!this.serverUrl && this.publicDir) await runGenerated('render');
        } else if (!isBounded && activeLive) {
          activeLive.stage++;
          const {ladderSlot, p1Spec, p2Spec, g1Winner} = activeLive;
          if (activeLive.stage === 1) {
            await runGenerated(
              `live match ${ladderSlot} ${p1Spec} ${p2Spec} ` +
              '--game 1 --turn 14 --active p2 --p1-bank 134 --p2-bank 129'
            );
          } else if (activeLive.stage === 2) {
            await runGenerated(
              `live match ${ladderSlot} ${p1Spec} ${p2Spec} ` +
              `--game 2 --turn 8 --active p1 --g1-winner ${g1Winner} --p1-bank 126 --p2-bank 121`
            );
          } else {
            await runGenerated(`match ${ladderSlot} ${p1Spec} ${p2Spec}`);
            await runGenerated('live idle');
            activeLive = undefined;
          }
          if (!this.serverUrl && this.publicDir) await runGenerated('render');
        } else {
          const roll = this.nextFloat();
          const allAgents = this.db.getAllActiveAgents();
          const runningTour = this.db.getRunningTournament();

          if (roll < 0.04 && allAgents.length < 24) {
            const existingSlugs = new Set(allAgents.map(a => a.slug));
            const candidateName = ORGANIC_AGENT_POOL.find(
              n => !existingSlugs.has(slugify(n).toLowerCase())
            );
            if (candidateName) {
              const slug = slugify(candidateName).toLowerCase();
              const baseElo = 1380 + this.nextInt(320);
              await runGenerated(`register "${candidateName}" --logo auto`);
              const openSlots = this.db.getActiveLadders().map(l => l.slot);
              if (openSlots.length > 0) {
                const picked = openSlots[this.nextInt(openSlots.length)];
                await runGenerated(`submit ${slug} 0.1.0 ${picked}=${baseElo}`);
              }
            }
          } else if (roll < 0.11) {
            const eligible = allAgents.filter(
              a => this.db.computeAgentSubmissionStatus(a.id, this.state.now).canSubmit
            );
            const activeLadders = this.db.getActiveLadders();
            if (eligible.length > 0 && activeLadders.length > 0) {
              const chosen = eligible[this.nextInt(eligible.length)];
              const nextVer = this.nextAutoVersion(chosen.id);
              const targetLadder = activeLadders[this.nextInt(activeLadders.length)];
              const prevElo = this.getExpectedRating(0, chosen.slug, targetLadder.id);
              const nextElo = Math.max(1250, Math.min(1850, prevElo - 10 + this.nextInt(35)));
              await runGenerated(
                `submit ${chosen.slug} ${nextVer} ${targetLadder.slot}=${nextElo}`
              );
            } else {
              await runGenerated('play 1');
            }
          } else if (roll < 0.20 && runningTour) {
            await runGenerated(`tournament play ${runningTour.id} --games 1`);
            await runGenerated(`tournament broadcast ${runningTour.id}`);
          } else if (!isBounded) {
            const playable = this.db.getPlayableLadders();
            const candidates: Array<{
              ladder: db.LadderRow;
              state: ratings.LadderMatchState;
              entries: db.LeaderboardEntryView[];
            }> = [];
            for (const l of playable) {
              const built = this.buildCandidateLadderState(l);
              if (built) candidates.push({ladder: l, ...built});
            }
            if (candidates.length > 0) {
              const choice = ratings.selectNextArenaMatch(
                candidates.map(c => c.state),
                this.state.matchSeq + 1
              );
              const chosen = candidates.find(c => c.ladder.id === choice.ladderId)!;
              const e1 = chosen.entries[choice.agentI];
              const e2 = chosen.entries[choice.agentJ];
              if (e1.versionId !== e2.versionId) {
                activeLive = {
                  ladderSlot: chosen.ladder.slot,
                  p1Spec: `${e1.agentSlug}@${e1.version}`,
                  p2Spec: `${e2.agentSlug}@${e2.version}`,
                  stage: 0,
                  g1Winner: this.nextInt(2) === 0 ? 'p1' : 'p2',
                };
                const {ladderSlot, p1Spec, p2Spec} = activeLive;
                await runGenerated(
                  `live match ${ladderSlot} ${p1Spec} ${p2Spec} ` +
                  '--game 1 --turn 4 --active p1 --p1-bank 146 --p2-bank 144'
                );
              }
            }
          } else {
            await runGenerated('play 1');
          }

          if (!this.serverUrl && this.publicDir && (!isBounded || step === totalSteps - 1)) {
            await runGenerated('render');
          }
        }

        if (!isBounded && loopState.running) {
          const jitter = 0.6 + this.nextFloat() * 0.8;
          await new Promise(resolve => setTimeout(resolve, Math.round(intervalMillis * jitter)));
        }
      }
    } finally {
      if (!isBounded) {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
    }
  }
}

function normalizeMatchCategory(
  g1: ratings.GameOutcome,
  g2: ratings.GameOutcome
): ratings.MatchCategory {
  return `${g1}${g2}`;
}

function parseExplicitOutcome(raw: string): ratings.MatchCategory {
  const valid = new Set<ratings.MatchCategory>([
    'WW', 'WT', 'TW', 'WL', 'LW', 'TT', 'TL', 'LT', 'LL',
  ]);
  if (!valid.has(raw as ratings.MatchCategory)) {
    throw new Error(
      `Invalid match --outcome "${raw}" (expected WW, WT, TW, WL, LW, TT, TL, LT, or LL)`
    );
  }
  return raw as ratings.MatchCategory;
}

export function prepareStaticDir(
  targetStaticDir: string,
  targetAvatarsDir: string,
  baseStaticDir = root('static')
): string {
  fs.mkdirSync(targetStaticDir, {recursive: true});
  fs.mkdirSync(targetAvatarsDir, {recursive: true});
  for (const name of ['index.css', 'projects.bib', 'projects.dj', 'projects.ts', 'arena.dj']) {
    const src = path.join(baseStaticDir, name);
    const dst = path.join(targetStaticDir, name);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
  }
  fs.writeFileSync(
    path.join(targetAvatarsDir, '0-error.png'),
    Buffer.from(ZERO_ERROR_PNG_BASE64, 'base64')
  );
  const projectsFile = path.join(targetStaticDir, 'projects.yml');
  if (!fs.existsSync(projectsFile)) {
    fs.copyFileSync(path.join(baseStaticDir, 'projects.yml'), projectsFile);
  }
  return projectsFile;
}

export interface SeedOptions {
  db: db.Database;
  publicDir?: string;
  staticDir?: string;
  avatarsDir?: string;
  wikiDir?: string;
  mockDir?: string;
  laddersFile?: string;
  scenarioFile?: string;
  now?: number;
  render?: boolean;
}

export interface SeedResult {
  liveDoc: arena.LiveDocument;
  tournamentBroadcast?: tournaments.LiveBroadcast;
  featuredBattleId: string;
}

export async function seed(options: SeedOptions): Promise<SeedResult> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const scenarioFile = options.scenarioFile ?? SEED_SCENARIO;

  const runner = new Runner({
    db: options.db,
    mockDir: options.mockDir,
    staticDir: options.staticDir,
    avatarsDir: options.avatarsDir,
    publicDir: options.render === false ? undefined : options.publicDir,
    wikiDir: options.wikiDir,
    laddersFile: options.laddersFile,
    now,
  });

  await runner.runFile(scenarioFile);
  const liveDoc = options.render !== false && options.publicDir
    ? runner.cmdRender()
    : runner.buildLiveDocument();

  return {
    liveDoc,
    tournamentBroadcast: runner.state.tournamentBroadcast,
    featuredBattleId: runner.state.featuredBattleId ?? '',
  };
}

const CLI_USAGE = [
  'Usage:',
  '  mock seed [--db <path>] [--public-dir <dir>] [--now <ts>]',
  '  mock [-f <scenario.mock>] [--db <path>] [--server <url>] [--secret <tok>]',
  '  mock <command> [args...] [--db <path>] [--server <url>] [--secret <tok>]',
  '  mock < tools/scenarios/seed.mock',
  '',
  'Declarative Commands:',
  '  reset [--seed <n>] [--now <ts>] [--open-ladders]',
  '  time <+dur|-dur|now|now-dur|iso|unix>',
  '  rng <seed>',
  '  register <name> [--owner <gh[:smogon]>...] [--pending|--disabled] [--logo <file|auto>]',
  '  qualify <agent> | disable <agent> | reassign <gh> <agent|--none> | refund-cooldown <agent>',
  '  discord <link|unlink|sync> ...',
  '  ladder <open|status|add|rotate|anchor|archive> ...',
  '  submit <agent> [<ver>] [<ladder>[=<rating>] ...] [--smoke <pass|pending|fail>] ...',
  '  smoke [<agent>[@<ver>]|all] [--pass|--fail] [--error <msg>]',
  '  quarantine <agent>[@<ver>] [--reason <msg>] | unquarantine <agent>[@<ver>]',
  '  play [<count>] [--ladder <ladders>] [--over <dur>] [--tie-rate <p>] [--fault-rate <p>]',
  '  settle [<ladders|all>] [--over <dur>] [--max <n>] [--heartbeats]',
  '  match <ladder> <p1>[@<ver>] <p2>[@<ver>] [--count <n>] [--outcome <cat>] ...',
  '  live <match|idle|stale> ...',
  '  tournament <create|enter|seed|start|play|broadcast|complete> ...',
  '  wiki <slug> [--by <gh>] [--visibility <vis>] (--content <djot> | --file <path>)',
  '  render',
  '  simulate [<steps>] [--interval <millis>] [--over <dur>]',
].join('\n');

interface GlobalCliFlags {
  scenarioFile?: string;
  dbPath?: string;
  publicDir?: string;
  serverUrl?: string;
  arenaSecret?: string;
  now?: string;
  help: boolean;
  remaining: string[];
}

function extractGlobalCliFlags(argv: string[]): GlobalCliFlags {
  const out: GlobalCliFlags = {help: false, remaining: []};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-f' || arg === '--file') {
      out.scenarioFile = argv[++i];
    } else if (arg.startsWith('--file=')) {
      out.scenarioFile = arg.slice('--file='.length);
    } else if (arg === '--db') {
      out.dbPath = argv[++i];
    } else if (arg.startsWith('--db=')) {
      out.dbPath = arg.slice('--db='.length);
    } else if (arg === '--public-dir') {
      out.publicDir = argv[++i];
    } else if (arg.startsWith('--public-dir=')) {
      out.publicDir = arg.slice('--public-dir='.length);
    } else if (arg === '--server') {
      out.serverUrl = argv[++i];
    } else if (arg.startsWith('--server=')) {
      out.serverUrl = arg.slice('--server='.length);
    } else if (arg === '--secret') {
      out.arenaSecret = argv[++i];
    } else if (arg.startsWith('--secret=')) {
      out.arenaSecret = arg.slice('--secret='.length);
    } else if (arg === '--now' && out.remaining[0] === 'seed') {
      out.now = argv[++i];
    } else if (arg === '-h' || (arg === '--help' && out.remaining.length === 0)) {
      out.help = true;
    } else {
      out.remaining.push(arg);
    }
  }
  return out;
}

export async function run(argv: string[]): Promise<void> {
  const globalFlags = extractGlobalCliFlags(argv);
  const firstToken = globalFlags.remaining[0];

  if (globalFlags.help || firstToken === 'help') {
    console.log(CLI_USAGE);
    return;
  }

  const isSeedAlias = firstToken === 'seed' && !globalFlags.scenarioFile;
  const scenarioFile = isSeedAlias ? SEED_SCENARIO : globalFlags.scenarioFile;
  const readingStdin = !scenarioFile && globalFlags.remaining.length === 0 && !process.stdin.isTTY;

  if (!scenarioFile && globalFlags.remaining.length === 0 && !readingStdin) {
    console.log(CLI_USAGE);
    return;
  }

  const dbPath = globalFlags.dbPath ?? db.DB_PATH;
  const publicDir = globalFlags.publicDir ?? render.PUBLIC_DIR;
  const useMockDir = !globalFlags.dbPath;
  const mockRoot = useMockDir
    ? root('.mock')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-mock-'));

  if (isSeedAlias) {
    if (dbPath !== ':memory:') {
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${dbPath}${suffix}`, {force: true});
      }
    }
    if (useMockDir) {
      fs.rmSync(mockRoot, {recursive: true, force: true});
      fs.mkdirSync(mockRoot, {recursive: true});
    }
  }

  const staticDir = useMockDir ? path.join(mockRoot, 'static') : mockRoot;
  const avatarsDir = path.join(staticDir, 'avatars');
  const laddersFile = useMockDir
    ? path.join(mockRoot, 'ladders.yml')
    : root('config', 'ladders.yml');
  const wikiDir = useMockDir ? path.join(mockRoot, 'wiki') : undefined;
  const wallNow = Math.floor(Date.now() / 1000);
  const nowOverride = globalFlags.now
    ? parseTimestampSpec(globalFlags.now, wallNow, wallNow)
    : undefined;

  const database = new db.Database(dbPath, nowOverride !== undefined ? {now: nowOverride} : {});
  try {
    const runner = new Runner({
      db: database,
      mockDir: useMockDir ? mockRoot : undefined,
      staticDir,
      avatarsDir,
      publicDir,
      wikiDir,
      laddersFile,
      now: nowOverride,
      serverUrl: globalFlags.serverUrl,
      arenaSecret: globalFlags.arenaSecret ?? process.env.ARENA_SECRET,
      sessionSecret: process.env.SESSION_SECRET,
      log: line => console.log(line),
    });

    if (scenarioFile) {
      await runner.runFile(scenarioFile);
      if (isSeedAlias) {
        console.log(`Seeded mock Arena DB at ${dbPath} and rendered pages into ${publicDir}`);
      }
      return;
    }

    if (readingStdin) {
      const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
      let acc = '';
      let lineNo = 0;
      for await (const line of rl) {
        lineNo++;
        const trimmed = line.trim();
        if (!acc && (!trimmed || trimmed.startsWith('#'))) continue;
        if (line.endsWith('\\') && !line.endsWith('\\\\')) {
          acc += `${line.slice(0, -1)} `;
          continue;
        }
        acc += line;
        const tokens = tokenize(acc);
        acc = '';
        if (tokens.length > 0) {
          await runner.execCommand(parseCommandTokens(tokens, lineNo, tokens.join(' ')));
          runner.saveState();
        }
      }
      if (acc.trim()) {
        const tokens = tokenize(acc);
        if (tokens.length > 0) {
          await runner.execCommand(parseCommandTokens(tokens, lineNo, tokens.join(' ')));
          runner.saveState();
        }
      }
      return;
    }

    await runner.execTokens(globalFlags.remaining);
  } finally {
    database.close();
    if (!useMockDir) {
      fs.rmSync(mockRoot, {recursive: true, force: true});
    }
  }
}

if (require.main === module) {
  require('source-map-support').install();
  run(process.argv.slice(2)).catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
