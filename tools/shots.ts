// Visual regression & layout verifier (`npm run shots [-- --only <filter>]`).
//
// Renders every static and dynamic page across 4 viewports (`small`, `phone`, `tablet`, `desktop`)
// and both color schemes (`light`, `dark`) into `.shots/<viewport>/<theme>/<scenario>.png`,
// asserting zero runtime console/page errors and zero horizontal overflow on every combination.

import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {parseArgs} from 'util';
import * as zlib from 'zlib';

import {Browser, BrowserContext, Route, chromium} from 'playwright-core';
import polka from 'polka';

import {Database} from '../db';
import * as account from '../server/account';
import * as arena from '../server/arena';
import * as auth from '../server/auth';
import * as render from '../server/render';
import * as wiki from '../server/wiki';
import {ROOT, escapeHtml, root} from '../static/util';

import * as mock from './mock';

const PUBLIC = root('public');
const SHOTS_DIR = root('.shots');
export const BASELINE_DIR = path.join(SHOTS_DIR, 'baseline');
export const DIFF_DIR = path.join(SHOTS_DIR, 'diff');

const ORIGIN = 'http://pkmn.test';
const NOW = Date.parse('2026-10-20T12:00:00Z');
const VIEWPORTS = {
  small: {width: 375, height: 667}, // iPhone SE (3rd generation)
  phone: {width: 390, height: 844}, // iPhone 14
  tablet: {width: 744, height: 1133}, // iPad mini (6th generation, portrait)
  desktop: {width: 1280, height: 900},
};
const THEMES = ['light', 'dark'] as const;
const SETTLE_MILLIS = 200;

interface Scenario {
  name: string;
  path: string;
  click?: string;
  githubUser?: string;
}

const SHOTS_AUTH: auth.Config = {
  sessionSecret: 'shots-session-secret',
  github: {
    clientId: 'shots-client-id',
    clientSecret: 'shots-client-secret',
  },
  discord: {
    clientId: '689315793569447954',
    clientSecret: 'shots-discord-secret',
  },
};

function buildScenarios(wikiSha: string): Scenario[] {
  return [
    {name: 'home', path: '/'},
    {name: 'arena', path: '/arena/'},
    {name: 'arena-ladder-rby', path: '/arena/ladders/rby/'},
    {name: 'arena-ladder-vgc', path: '/arena/ladders/vgc/'},
    {name: 'arena-tournament-1', path: '/arena/tournaments/1/'},
    {name: 'arena-tournament-2', path: '/arena/tournaments/2/'},
    {name: 'arena-tournament-3', path: '/arena/tournaments/3/'},
    {name: 'arena-battles', path: '/arena/battles/'},
    {
      name: 'arena-battles-expanded',
      path: '/arena/battles/',
      click: '#battles-tbody tr.battle-row td:first-child',
    },
    {name: 'account', path: '/account/'},
    {name: 'account-tournament', path: '/account/', githubUser: 'pmariglia'},
    {name: 'background', path: '/background/'},
    {name: 'concepts', path: '/concepts/'},
    {name: 'concepts-baselines', path: '/concepts/baselines/'},
    {name: 'concepts-complexity', path: '/concepts/complexity/'},
    {name: 'concepts-engines', path: '/concepts/engines/'},
    {name: 'concepts-protocol', path: '/concepts/protocol/'},
    {name: 'concepts-variants', path: '/concepts/variants/'},
    {name: 'glossary', path: '/glossary/'},
    {name: 'projects', path: '/projects/'},
    {name: 'projects-arena', path: '/projects/', click: 'label[for="arena"]'},
    {name: 'project-profile', path: '/projects/0-error/'},
    {name: 'release', path: '/release/'},
    {name: 'research', path: '/research/'},
    {name: 'rules', path: '/rules/'},
    {name: 'wiki', path: '/wiki'},
    {name: 'wiki-pages', path: '/wiki/pages'},
    {name: 'wiki-project', path: '/wiki/0_ERROR'},
    {name: 'wiki-edit', path: '/wiki/Gen_9_OU/edit'},
    {name: 'wiki-edit-project', path: '/wiki/0_ERROR/edit'},
    {
      name: 'wiki-preview',
      path: '/wiki/0_ERROR/edit',
      click: '#wiki-actions button[value="preview"]',
    },
    {name: 'wiki-history', path: '/wiki/0_ERROR/history'},
    {name: 'wiki-revision', path: `/wiki/0_ERROR/${wikiSha}`},
    {name: 'wiki-diff', path: `/wiki/0_ERROR/${wikiSha}?diff=1`},
  ];
}

interface Fixture {
  origin: string;
  cookies: Record<string, string>;
  sha: string;
  publicDir: string;
  close: () => Promise<void>;
}

function copyStaticPublicHtml(srcPublic: string, dstPublic: string) {
  const indexHtml = path.join(srcPublic, 'index.html');
  if (fs.existsSync(indexHtml)) {
    fs.copyFileSync(indexHtml, path.join(dstPublic, 'index.html'));
  }
  for (const dir of [
    'background',
    'concepts',
    'glossary',
    'release',
    'research',
    'rules',
  ]) {
    const srcDir = path.join(srcPublic, dir);
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, path.join(dstPublic, dir), {recursive: true});
    }
  }
}

async function startFixture(): Promise<Fixture> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-shots-'));
  const wikiDir = path.join(tmpDir, 'wiki');
  const staticDir = path.join(tmpDir, 'static');
  const avatarsDir = path.join(staticDir, 'avatars');
  const publicDir = path.join(tmpDir, 'public');
  const laddersFile = path.join(tmpDir, 'ladders.yml');
  fs.mkdirSync(publicDir, {recursive: true});
  copyStaticPublicHtml(PUBLIC, publicDir);

  const nowSeconds = Math.floor(NOW / 1000);
  const db = new Database(':memory:', {now: nowSeconds});
  const seeded = await mock.seed({
    db,
    publicDir,
    staticDir,
    avatarsDir,
    wikiDir,
    laddersFile,
    now: nowSeconds,
    render: true,
  });
  const projectsFile = path.join(staticDir, 'projects.yml');

  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: wikiDir,
    encoding: 'utf8',
  }).trim();

  const app = polka();
  const wikiInstance = new wiki.Wiki({
    wikiDir,
    projectsFile,
    db,
    push: false,
    auth: new auth.Auth({
      config: SHOTS_AUTH,
      db,
      isAuthorizedGitHub: (login): boolean => wikiInstance.isDeveloper(login),
    }),
  });
  wikiInstance.auth.register(app);
  account.register(app, {
    db,
    auth: wikiInstance.auth,
    now: () => nowSeconds,
  });
  const arenaHandle = arena.register(app, {
    db,
    auth: wikiInstance.auth,
    publicDir,
    now: () => nowSeconds,
  });
  arenaHandle.setLiveState({
    live: seeded.liveDoc.live,
    stale: seeded.liveDoc.stale,
    updatedAt: seeded.liveDoc.updatedAt,
  });
  if (seeded.tournamentBroadcast) {
    arenaHandle.setTournamentBroadcast(seeded.tournamentBroadcast);
  }
  render.register(app, {
    db,
    arena: arenaHandle,
    publicDir,
    staticDir,
    avatarsDir,
    now: () => nowSeconds,
  });
  wiki.register(app, {
    wikiDir,
    projectsFile,
    db,
    auth: wikiInstance.auth,
    push: false,
  });

  const server = http.createServer((req, res) => app.handler(req as polka.Request, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as {port: number};
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const mintCookie = (id: number, login: string, discordId: string, discordUser: string) => {
    const token = auth.signToken(
      {
        github: {id, login},
        discord: {id: discordId, username: discordUser},
        exp,
      },
      SHOTS_AUTH.sessionSecret
    );
    return `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`;
  };

  return {
    origin: `http://127.0.0.1:${addr.port}`,
    cookies: {
      scheibo: mintCookie(1, 'scheibo', '513513270670262284', 'scheibo'),
      pmariglia: mintCookie(2, 'pmariglia', '283674461268344832', 'pmariglia'),
    },
    sha,
    publicDir,
    close: async () => {
      arenaHandle.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close();
      fs.rmSync(tmpDir, {recursive: true, force: true});
    },
  };
}

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({
      args: [
        '--disable-gpu',
        '--disable-gpu-rasterization',
        '--disable-partial-raster',
        '--num-raster-threads=1',
        '--force-color-profile=srgb',
      ],
    });
  } catch (error) {
    console.error(
      'Could not start Chromium. Install the one playwright-core expects with\n' +
      '  npx playwright-core install chromium\n'
    );
    throw error;
  }
}

function resolveFileInDir(baseDir: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  const candidate = path.resolve(baseDir, `.${decoded}`);
  if (candidate !== baseDir && !candidate.startsWith(`${baseDir}${path.sep}`)) {
    return undefined;
  }
  if (fs.existsSync(candidate)) {
    const stat = fs.statSync(candidate);
    if (stat.isFile()) return candidate;
    if (stat.isDirectory()) {
      const index = path.join(candidate, 'index.html');
      if (fs.existsSync(index) && fs.statSync(index).isFile()) return index;
    }
  }
  return undefined;
}

export interface PngImage {
  width: number;
  height: number;
  data: Buffer;
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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

export function encodePng(image: PngImage): Buffer {
  const {width, height, data} = image;
  const rowBytes = width * 4;
  const raw = Buffer.alloc(height * (1 + rowBytes));
  for (let y = 0; y < height; y++) {
    const dstOff = y * (1 + rowBytes);
    raw[dstOff] = 0;
    data.copy(raw, dstOff + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buf: Buffer): PngImage {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('Invalid PNG signature');
  }
  let width = 0;
  let height = 0;
  let colorType = 6;
  let palette: Buffer | undefined;
  let trns: Buffer | undefined;
  const idatParts: Buffer[] = [];
  let offset = 8;

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const chunk = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      colorType = chunk[9];
    } else if (type === 'PLTE') {
      palette = chunk;
    } else if (type === 'tRNS') {
      trns = chunk;
    } else if (type === 'IDAT') {
      idatParts.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
  }

  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const rowBytes = width * bpp;
  const stride = 1 + rowBytes;
  const inflated = zlib.inflateSync(Buffer.concat(idatParts));
  const unfiltered = Buffer.alloc(height * rowBytes);

  for (let y = 0; y < height; y++) {
    const filter = inflated[y * stride];
    const srcOff = y * stride + 1;
    const dstOff = y * rowBytes;
    const prevOff = (y - 1) * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const raw = inflated[srcOff + i];
      const left = i >= bpp ? unfiltered[dstOff + i - bpp] : 0;
      const up = y > 0 ? unfiltered[prevOff + i] : 0;
      const upLeft = y > 0 && i >= bpp ? unfiltered[prevOff + i - bpp] : 0;
      if (filter === 0) {
        unfiltered[dstOff + i] = raw;
      } else if (filter === 1) {
        unfiltered[dstOff + i] = (raw + left) & 0xff;
      } else if (filter === 2) {
        unfiltered[dstOff + i] = (raw + up) & 0xff;
      } else if (filter === 3) {
        unfiltered[dstOff + i] = (raw + ((left + up) >>> 1)) & 0xff;
      } else if (filter === 4) {
        unfiltered[dstOff + i] = (raw + paethPredictor(left, up, upLeft)) & 0xff;
      } else {
        throw new Error(`Unsupported PNG filter type: ${filter}`);
      }
    }
  }

  if (colorType === 6) {
    return {width, height, data: unfiltered};
  }
  const rgba = Buffer.alloc(width * height * 4);
  const pixels = width * height;
  for (let p = 0; p < pixels; p++) {
    const dst = p * 4;
    if (colorType === 2) {
      const src = p * 3;
      rgba[dst] = unfiltered[src];
      rgba[dst + 1] = unfiltered[src + 1];
      rgba[dst + 2] = unfiltered[src + 2];
      rgba[dst + 3] = 255;
    } else if (colorType === 4) {
      const src = p * 2;
      rgba[dst] = unfiltered[src];
      rgba[dst + 1] = unfiltered[src];
      rgba[dst + 2] = unfiltered[src];
      rgba[dst + 3] = unfiltered[src + 1];
    } else if (colorType === 3 && palette) {
      const idx = unfiltered[p];
      rgba[dst] = palette[idx * 3] ?? 0;
      rgba[dst + 1] = palette[idx * 3 + 1] ?? 0;
      rgba[dst + 2] = palette[idx * 3 + 2] ?? 0;
      rgba[dst + 3] = trns && idx < trns.length ? trns[idx] : 255;
    } else {
      const gray = unfiltered[p];
      rgba[dst] = gray;
      rgba[dst + 1] = gray;
      rgba[dst + 2] = gray;
      rgba[dst + 3] = 255;
    }
  }
  return {width, height, data: rgba};
}

const spriteCache = new Map<string, Buffer>();

export function standInSprite(urlPath: string): Buffer {
  const cached = spriteCache.get(urlPath);
  if (cached) return cached;

  const isBattleSprite = urlPath.includes('/sprites/');
  const width = isBattleSprite ? 96 : 40;
  const height = isBattleSprite ? 96 : 30;

  let hash = 2166136261;
  for (let i = 0; i < urlPath.length; i++) {
    hash = Math.imul(hash ^ urlPath.charCodeAt(i), 16777619) >>> 0;
  }
  const primary = [70 + (hash & 0x9f), 70 + ((hash >>> 8) & 0x9f), 70 + ((hash >>> 16) & 0x9f)];
  const accent = [
    90 + ((hash >>> 4) & 0x7f),
    90 + ((hash >>> 12) & 0x7f),
    90 + ((hash >>> 20) & 0x7f),
  ];
  const border = [24, 28, 36];

  const data = Buffer.alloc(width * height * 4);
  const gridCols = 8;
  const gridRows = 6;
  const cellW = isBattleSprite ? 10 : 2;
  const cellH = isBattleSprite ? 10 : 2;
  const padX = Math.floor((width - gridCols * cellW) / 2);
  const padY = Math.floor((height - gridRows * cellH) / 2);

  const filled = (gx: number, gy: number): number => {
    if (gx < 0 || gx >= gridCols || gy < 0 || gy >= gridRows) return 0;
    const mx = gx < 4 ? gx : 7 - gx;
    if (mx === 3 && gy >= 1 && gy <= 4) return 1;
    const bit = (gy * 4 + mx) % 31;
    return ((hash >>> bit) & 1) === 1 ? ((gy + mx) % 2 === 0 ? 1 : 2) : 0;
  };

  for (let y = 0; y < height; y++) {
    const gy = Math.floor((y - padY) / cellH);
    const inY = y >= padY && y < padY + gridRows * cellH;
    for (let x = 0; x < width; x++) {
      const gx = Math.floor((x - padX) / cellW);
      const inX = x >= padX && x < padX + gridCols * cellW;
      const px = (y * width + x) * 4;
      const cell = inX && inY ? filled(gx, gy) : 0;
      if (cell > 0) {
        const col = cell === 1 ? primary : accent;
        data[px] = col[0];
        data[px + 1] = col[1];
        data[px + 2] = col[2];
        data[px + 3] = 255;
      } else if (
        inX &&
        inY &&
        (filled(gx - 1, gy) > 0 ||
          filled(gx + 1, gy) > 0 ||
          filled(gx, gy - 1) > 0 ||
          filled(gx, gy + 1) > 0)
      ) {
        data[px] = border[0];
        data[px + 1] = border[1];
        data[px + 2] = border[2];
        data[px + 3] = 255;
      }
    }
  }

  const png = encodePng({width, height, data});
  spriteCache.set(urlPath, png);
  return png;
}

export function diffPngImages(a: PngImage, b: PngImage): {image: PngImage; count: number} {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const data = Buffer.alloc(width * height * 4, 255);
  let count = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      const inBoth = x < a.width && y < a.height && x < b.width && y < b.height;
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      if (inBoth && a.data.readUInt32LE(ia) === b.data.readUInt32LE(ib)) {
        const luma =
          0.3 * (b.data[ib] ?? 0) +
          0.59 * (b.data[ib + 1] ?? 0) +
          0.11 * (b.data[ib + 2] ?? 0);
        const faded = 255 - ((255 - Math.round(luma)) >> 2);
        data[out] = faded;
        data[out + 1] = faded;
        data[out + 2] = faded;
        continue;
      }
      count++;
      data[out + 1] = 0;
      if (inBoth) data[out + 2] = 0;
    }
  }
  return {image: {width, height, data}, count};
}

interface ShotChange {
  name: string;
  note: string;
  diffPath?: string;
}

function listPngsRelative(baseDir: string): string[] {
  if (!fs.existsSync(baseDir)) return [];
  const results: string[] = [];
  const walk = (dir: string, relPrefix: string) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (relPrefix === '' && (entry.name === 'baseline' || entry.name === 'diff')) {
        continue;
      }
      const rel = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile() && entry.name.endsWith('.png')) {
        results.push(rel);
      }
    }
  };
  walk(baseDir, '');
  return results.sort();
}

function renderDiffReport(
  changes: ShotChange[],
  beforeDir: string,
  afterDir: string,
  diffDir: string
): string {
  const imgTag = (dir: string, name: string) => {
    const rel = path.relative(diffDir, path.join(dir, name)).split(path.sep).join('/');
    return `<img loading="lazy" src="${escapeHtml(rel)}">`;
  };
  const rows = changes.map(({name, note, diffPath}) => {
    const cells = [
      `<td>${imgTag(beforeDir, name)}</td>`,
      `<td>${imgTag(afterDir, name)}</td>`,
      `<td>${diffPath ? imgTag(diffDir, name) : ''}</td>`,
    ];
    return `<h2>${escapeHtml(name)} <small>${escapeHtml(note)}</small></h2>` +
      `<table><tr>${cells.join('')}</tr></table>`;
  });
  return '<!doctype html><meta charset="utf-8"><title>Screenshot changes</title>\n' +
    '<style>body{font:14px system-ui;margin:1rem}td{vertical-align:top;padding:0 .5rem 0 0}' +
    'img{max-width:30vw;border:1px solid #ccc}small{font-weight:normal;color:#666}</style>\n' +
    `<p>Before: ${escapeHtml(path.relative(ROOT, beforeDir) || beforeDir)} · ` +
    `After: ${escapeHtml(path.relative(ROOT, afterDir) || afterDir)} · ` +
    'Red changed, magenta beyond an edge.</p>\n' +
    rows.join('\n');
}

export async function compareShots(
  beforeDir: string,
  afterDir: string,
  diffDir: string,
  tolerance = 0,
  only?: string[]
): Promise<{same: boolean; changes: ShotChange[]}> {
  const beforeNames = listPngsRelative(beforeDir);
  const afterNames = listPngsRelative(afterDir);
  const names = [...new Set([...beforeNames, ...afterNames])]
    .filter(name => !only || only.includes(name))
    .sort();
  await fsp.rm(diffDir, {recursive: true, force: true});
  await fsp.mkdir(diffDir, {recursive: true});

  const beforeSet = new Set(beforeNames);
  const afterSet = new Set(afterNames);
  const changes: ShotChange[] = [];

  for (const name of names) {
    if (!afterSet.has(name)) {
      changes.push({name, note: `only in ${path.relative(ROOT, beforeDir) || beforeDir}`});
      continue;
    }
    if (!beforeSet.has(name)) {
      changes.push({name, note: `only in ${path.relative(ROOT, afterDir) || afterDir}`});
      continue;
    }
    const [rawA, rawB] = await Promise.all([
      fsp.readFile(path.join(beforeDir, name)),
      fsp.readFile(path.join(afterDir, name)),
    ]);
    if (rawA.equals(rawB)) continue;
    const a = decodePng(rawA);
    const b = decodePng(rawB);
    const resized = a.width !== b.width || a.height !== b.height;
    if (!resized && a.data.equals(b.data)) continue;

    const {image, count} = diffPngImages(a, b);
    if (count === 0 || (count <= tolerance && !resized)) continue;

    const pct = ((100 * count) / (image.width * image.height)).toFixed(2);
    const sizeNote = resized ? `, ${a.width}×${a.height} → ${b.width}×${b.height}` : '';
    const diffPath = path.join(diffDir, name);
    await fsp.mkdir(path.dirname(diffPath), {recursive: true});
    await fsp.writeFile(diffPath, encodePng(image));
    changes.push({name, note: `${count} px (${pct}%)${sizeNote}`, diffPath});
  }

  if (changes.length > 0) {
    const html = renderDiffReport(changes, beforeDir, afterDir, diffDir);
    await fsp.writeFile(path.join(diffDir, 'index.html'), html, 'utf8');
  }
  return {same: changes.length === 0, changes};
}

async function serve(route: Route, fixture: Fixture, cookie: string): Promise<void> {
  const url = new URL(route.request().url());
  if (url.origin !== ORIGIN) {
    if (url.pathname.endsWith('.png')) {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: standInSprite(url.pathname),
      });
      return;
    }
    await route.fulfill({status: 204, body: ''});
    return;
  }
  if (
    url.pathname === '/api/battles/stream' ||
    /^\/api\/tournaments\/[^/]+\/stream$/.test(url.pathname)
  ) {
    await route.fulfill({status: 204, contentType: 'text/event-stream', body: ''});
    return;
  }
  const isStaticArenaAsset = (
    url.pathname === '/arena/viewer' ||
    url.pathname.startsWith('/arena/viewer/') ||
    /\.(?:7z|log)$/i.test(url.pathname)
  );
  const isDynamic = !isStaticArenaAsset && (
    url.pathname === '/wiki' ||
    url.pathname.startsWith('/wiki/') ||
    url.pathname === '/account' ||
    url.pathname.startsWith('/account/') ||
    url.pathname === '/projects' ||
    url.pathname.startsWith('/projects/') ||
    url.pathname === '/arena' ||
    url.pathname.startsWith('/arena/') ||
    url.pathname === '/arena.json' ||
    url.pathname.startsWith('/api/')
  );
  if (isDynamic) {
    const req = route.request();
    const body = req.postDataBuffer();
    const reqHeaders = req.headers();
    const res = await fetch(`${fixture.origin}${url.pathname}${url.search}`, {
      method: req.method(),
      headers: {
        ...reqHeaders,
        ...(reqHeaders.origin === ORIGIN ? {origin: fixture.origin} : {}),
        cookie,
      },
      body: body ? new Uint8Array(body) : undefined,
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    await route.fulfill({status: res.status, headers, body: buffer});
    return;
  }
  const file = (
    resolveFileInDir(fixture.publicDir, url.pathname) ??
    resolveFileInDir(PUBLIC, url.pathname)
  );
  if (file) {
    await route.fulfill({path: file});
    return;
  }
  const notFound = path.join(PUBLIC, '404.html');
  if (fs.existsSync(notFound)) {
    await route.fulfill({status: 404, path: notFound});
    return;
  }
  await route.fulfill({status: 404, contentType: 'text/plain', body: 'Not Found'});
}

async function shoot(
  context: BrowserContext,
  scenario: Scenario,
  file: string,
  fixture: Fixture
): Promise<string[]> {
  const cookie = fixture.cookies[scenario.githubUser ?? 'scheibo'] ?? fixture.cookies.scheibo;
  await context.route('**/*', route => serve(route, fixture, cookie));
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') problems.push(message.text());
  });
  await page.clock.setFixedTime(NOW);

  await page.goto(scenario.path);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(SETTLE_MILLIS);
  if (scenario.click) {
    await page.click(scenario.click);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(SETTLE_MILLIS);
  }
  await page.evaluate(`(async () => {
    for (const image of document.querySelectorAll("img")) image.loading = "eager";
    await document.fonts.ready;
    const pending = [...document.images].filter((image) => !image.complete);
    await Promise.all(
      pending.map((image) => new Promise((done) => (image.onload = image.onerror = done)))
    );
  })()`);
  await page.waitForTimeout(SETTLE_MILLIS / 2);
  const overflow = await page.evaluate<number>(
    'document.documentElement.scrollWidth - window.innerWidth'
  );
  if (overflow > 0) {
    problems.push(`horizontal overflow: +${overflow}px`);
  }
  await page.screenshot({path: file, fullPage: true, animations: 'disabled', caret: 'hide'});
  return problems;
}

async function run(): Promise<void> {
  const {values} = parseArgs({
    options: {
      only: {type: 'string'},
      baseline: {type: 'boolean', default: false},
      tolerance: {type: 'string', default: '0'},
    },
  });

  if (!fs.existsSync(path.join(PUBLIC, 'index.html'))) {
    console.error('There is no build to screenshot: run `npm run build` first.');
    process.exit(1);
  }

  const fixture = await startFixture();
  const newDir = `${SHOTS_DIR}.new`;
  const scenarios = buildScenarios(fixture.sha).filter(
    scenario => scenario.name.includes(values.only ?? '')
  );
  const browser = await launch();
  await fsp.rm(newDir, {recursive: true, force: true});
  for (const device of Object.keys(VIEWPORTS)) {
    for (const theme of THEMES) {
      await fsp.mkdir(path.join(newDir, device, theme), {recursive: true});
    }
  }

  const shotPaths: string[] = [];
  const errors: string[] = [];
  try {
    for (const scenario of scenarios) {
      const shots = Object.entries(VIEWPORTS).flatMap(([device, viewport]) =>
        THEMES.map(async theme => {
          const context = await browser.newContext({
            viewport,
            colorScheme: theme,
            deviceScaleFactor: 1,
            baseURL: ORIGIN,
            timezoneId: 'UTC',
            locale: 'en-US',
          });
          try {
            const relPath = path.join(device, theme, `${scenario.name}.png`);
            const problems = await shoot(context, scenario, path.join(newDir, relPath), fixture);
            shotPaths.push(relPath);
            errors.push(
              ...problems.map(problem => `${scenario.name} (${device}/${theme}): ${problem}`)
            );
          } finally {
            await context.close();
          }
        }));
      await Promise.all(shots);
      console.log(`  ${scenario.name}`);
    }
  } finally {
    await browser.close();
    await fixture.close();
  }

  if (values.only === undefined) {
    for (const device of Object.keys(VIEWPORTS)) {
      await fsp.rm(path.join(SHOTS_DIR, device), {recursive: true, force: true});
      if (values.baseline) {
        await fsp.rm(path.join(BASELINE_DIR, device), {recursive: true, force: true});
      }
    }
  }
  for (const relPath of shotPaths) {
    const src = path.join(newDir, relPath);
    const dest = path.join(SHOTS_DIR, relPath);
    await fsp.mkdir(path.dirname(dest), {recursive: true});
    if (values.baseline) {
      const baseDest = path.join(BASELINE_DIR, relPath);
      await fsp.mkdir(path.dirname(baseDest), {recursive: true});
      await fsp.copyFile(src, baseDest);
    }
    await fsp.rename(src, dest);
  }
  await fsp.rm(newDir, {recursive: true, force: true});

  const targetLabel = values.baseline
    ? path.relative(ROOT, BASELINE_DIR)
    : path.relative(ROOT, SHOTS_DIR);
  console.log(`Screenshots of ${scenarios.length} scenarios in ${targetLabel}.`);
  for (const error of new Set(errors)) console.warn(`  error: ${error}`);

  if (!values.baseline && fs.existsSync(BASELINE_DIR)) {
    const tolerance = Number(values.tolerance) || 0;
    const only = values.only === undefined ? undefined : shotPaths;
    const {same, changes} = await compareShots(
      BASELINE_DIR,
      SHOTS_DIR,
      DIFF_DIR,
      tolerance,
      only
    );
    for (const {name, note} of changes) {
      console.log(`  changed  ${name}  ${note}`);
    }
    if (same) {
      console.log(`All compared screenshots match ${path.relative(ROOT, BASELINE_DIR)}.`);
    } else {
      console.log(
        `${changes.length} screenshot(s) changed. ` +
        `See ${path.relative(ROOT, path.join(DIFF_DIR, 'index.html'))}`
      );
    }
  }

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
