import * as fs from 'fs';
import * as path from 'path';
import {parseArgs} from 'util';

import * as yaml from 'yaml';

import {
  ArenaDB,
  DB_PATH,
  LADDERS_FILE,
  type LadderSlot,
  type LadderStatus,
  type TeamMode,
} from '../db';
import type {
  LiveJsonDocument,
  LiveMatchTelemetry,
} from '../server/arena';
import {
  type GameOutcome,
  type LadderMatchState,
  type MatchCategory,
  type PairMatchCounts,
  computeDavidsonRatings,
  selectNextArenaMatch,
} from '../server/ratings';
import {
  PUBLIC_DIR,
  STATIC_DIR,
  type TournamentLiveBroadcast,
  renderArenaPages,
} from '../server/render';
import {splitSubmittedTeams} from '../server/teams';
import type {Project} from '../static/projects';
import {root, toID} from '../static/util';
import {getDex, parseTeam} from '../teams';

export interface CanonicalPoolEntry {
  canonicalPacked: string;
  speciesIds: string[];
  owners: Map<number, {botName: string; slotIndex: number}>;
}

export interface SampledPoolPair {
  t1Packed: string;
  t2Packed: string;
  t1Label: string;
  t2Label: string;
}

export function createRng(seed = 20261110): (max: number) => number {
  let state = seed >>> 0;
  return (max: number): number => {
    if (max <= 1) return 0;
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.min(max - 1, Math.floor(u * max));
  };
}

const speciesCache = new Map<string, string[]>();

function extractSpeciesIdsFromPacked(packed: string, formatId: string): string[] {
  const cacheKey = `${formatId}:${packed}`;
  const cached = speciesCache.get(cacheKey);
  if (cached) return cached;

  try {
    const dex = getDex(formatId);
    const parsed = parseTeam(dex, packed);
    if (parsed && parsed.length > 0) {
      const ids = parsed.map(s => toID(s.species ?? s.name ?? 'unknown')).sort();
      speciesCache.set(cacheKey, ids);
      return ids;
    }
  } catch {}
  const fallback = packed
    .split(']')
    .filter(Boolean)
    .map(mon => {
      const parts = mon.split('|');
      return toID(parts[1] || parts[0] || 'unknown');
    })
    .sort();
  speciesCache.set(cacheKey, fallback);
  return fallback;
}

export function buildCanonicalTeamPool(
  teamsByBot: Iterable<{botId: number; botName: string; teams: string[]}>,
  formatId = 'gen9championsvgc2026regmc'
): CanonicalPoolEntry[] {
  const byPacked = new Map<string, CanonicalPoolEntry>();
  for (const {botId, botName, teams} of teamsByBot) {
    for (let idx = 0; idx < teams.length; idx++) {
      const canonicalPacked = teams[idx].trim();
      if (!canonicalPacked) continue;
      let entry = byPacked.get(canonicalPacked);
      if (!entry) {
        entry = {
          canonicalPacked,
          speciesIds: extractSpeciesIdsFromPacked(canonicalPacked, formatId),
          owners: new Map(),
        };
        byPacked.set(canonicalPacked, entry);
      }
      if (!entry.owners.has(botId)) {
        entry.owners.set(botId, {botName, slotIndex: idx + 1});
      }
    }
  }
  return [...byPacked.values()];
}

export function sampleCompetitorPoolPair(
  pool: CanonicalPoolEntry[],
  botAId: number,
  botBId: number,
  rngNextInt: (max: number) => number
): SampledPoolPair {
  const eligibleT1 = pool.filter(e => !(e.owners.has(botAId) && e.owners.has(botBId)));
  if (!eligibleT1.length) {
    throw new Error('No eligible T1 teams in seasonal competitor pool');
  }
  const t1 = eligibleT1[rngNextInt(eligibleT1.length)];
  const activeOwnsT1 = t1.owners.has(botAId) || t1.owners.has(botBId);

  const candidatesT2 = pool.filter(cand => {
    if (cand.canonicalPacked === t1.canonicalPacked) return false;
    if (
      cand.speciesIds.length === t1.speciesIds.length &&
      cand.speciesIds.every((s, idx) => s === t1.speciesIds[idx])
    ) {
      return false;
    }
    if (cand.owners.has(botAId) && cand.owners.has(botBId)) return false;
    // At most 1 of {T1, T2} may come from the 40 teams submitted by botA and botB combined:
    if (activeOwnsT1 && (cand.owners.has(botAId) || cand.owners.has(botBId))) return false;
    for (const ownerId of t1.owners.keys()) {
      if (cand.owners.has(ownerId)) return false;
    }
    return true;
  });

  if (!candidatesT2.length) {
    throw new Error('Insufficient third-party teams in pool (VGC requires min_bots >= 3)');
  }
  const t2 = candidatesT2[rngNextInt(candidatesT2.length)];

  const formatProvenanceLabel = (entry: CanonicalPoolEntry): string => {
    const activeLabels: string[] = [];
    if (entry.owners.has(botAId)) {
      const o = entry.owners.get(botAId)!;
      activeLabels.push(`${o.botName} Team #${o.slotIndex}`);
    }
    if (entry.owners.has(botBId)) {
      const o = entry.owners.get(botBId)!;
      activeLabels.push(`${o.botName} Team #${o.slotIndex}`);
    }
    if (activeLabels.length > 0) return activeLabels.join(' / ');
    const allOwners = [...entry.owners.values()];
    const chosen = allOwners[rngNextInt(allOwners.length)];
    return `${chosen.botName} Team #${chosen.slotIndex}`;
  };

  return {
    t1Packed: t1.canonicalPacked,
    t2Packed: t2.canonicalPacked,
    t1Label: formatProvenanceLabel(t1),
    t2Label: formatProvenanceLabel(t2),
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

// (31, 6, 1) Singer difference set: every pair of 6-subsets shares at most 1 species (d >= 5.0)
const SINGER_31_OFFSETS = [0, 1, 3, 8, 12, 18];

export function generateValidVgcTeams(count = 20, botOffset = 0): string[] {
  const dex = getDex('gen9championsvgc2026regmc');
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const base = (i + botOffset * 7) % LEGAL_VGC_SPECIES.length;
    const blocks = SINGER_31_OFFSETS.map((off, slot) => {
      const sp = dex.species.get(LEGAL_VGC_SPECIES[(base + off) % LEGAL_VGC_SPECIES.length]);
      const item = VGC_ITEMS[(slot + botOffset) % VGC_ITEMS.length];
      return [
        `${sp.name} @ ${item}`,
        `Ability: ${sp.abilities['0']}`,
        'Level: 50',
        'EVs: 252 HP / 4 Def / 252 Spe',
        'Timid Nature',
        '- Protect',
        '- Substitute',
        '- Rest',
        '- Sleep Talk',
      ].join('\n');
    });
    out.push(blocks.join('\n\n'));
  }
  return out;
}

const ZERO_ERROR_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAPklEQVR4nO3SwQkAIAwDwZb9d+7C' +
  'wcEXkJ6SuQkAAPBn1tp7zhljjAmcB1wHXAdcB1wHXAdcB1wHXAdc5wE93QMR8wX8WQAAAABJRU5ErkJggg==';

export function prepareMockStaticDir(
  targetStaticDir: string,
  targetAvatarsDir: string,
  baseStaticDir = STATIC_DIR
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

  const rawProjects = yaml.parse(
    fs.readFileSync(path.join(baseStaticDir, 'projects.yml'), 'utf8')
  ) as Project[];

  const arenaOverrides: Record<string, NonNullable<Project['arena']>> = {
    '0 ERROR': {
      qualified: true,
      logo: '0-error.png',
      owners: {
        scheibo: 'pre.10544',
        coauthor: 'coauthor.20001',
      },
    },
    'Foul Play': {
      qualified: true,
      owners: {pmariglia: 'pmariglia.535629'},
    },
    'Metamon': {
      qualified: true,
      owners: {jakegrigsby: 'jakegrigsby.610001'},
    },
    "Mew's Truck": {
      qualified: true,
      owners: {pkmnbotguy: 'pkmnbotguy.610002'},
    },
    'MissingNo.Zero': {
      qualified: true,
      owners: {missingno: 'missingno.610003'},
    },
    'Xatu Zero': {
      qualified: true,
      owners: {xatudev: 'xatudev.610004'},
    },
    'AsterAI': {
      qualified: false,
      owners: {asterdev: 'asterdev.610005'},
    },
  };

  for (const proj of rawProjects) {
    if (proj.name && arenaOverrides[proj.name]) {
      proj.arena = arenaOverrides[proj.name];
    }
  }

  if (!rawProjects.some(p => p.name === '0 ERROR')) {
    rawProjects.unshift({
      name: '0 ERROR',
      site: 'https://pkmn.cc',
      active: 2026,
      license: 'MIT',
      source: 'https://github.com/pkmn/engine',
      engine: {name: 'pkmn', url: 'https://github.com/pkmn/engine'},
      language: ['Zig', 'TypeScript'],
      platform: [{name: 'Pokémon Showdown!', url: 'https://github.com/smogon/pokemon-showdown'}],
      arena: {
        qualified: true,
        logo: '0-error.png',
        owners: {
          scheibo: 'pre.10544',
          coauthor: 'coauthor.20001',
        },
      },
    });
  }

  const projectsFile = path.join(targetStaticDir, 'projects.yml');
  fs.writeFileSync(projectsFile, yaml.stringify(rawProjects), 'utf8');
  return projectsFile;
}

export interface SeedMockArenaOptions {
  db: ArenaDB;
  publicDir?: string;
  staticDir?: string;
  avatarsDir?: string;
  laddersFile?: string;
  now?: number;
  render?: boolean;
}

export interface SeedMockArenaResult {
  liveDoc: LiveJsonDocument;
  tournamentBroadcast: TournamentLiveBroadcast;
}

export function seedMockArena(options: SeedMockArenaOptions): SeedMockArenaResult {
  const {db} = options;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const staticDir = options.staticDir ?? STATIC_DIR;
  const avatarsDir = options.avatarsDir ?? path.join(staticDir, 'avatars');
  const projectsFile = path.join(staticDir, 'projects.yml');

  db.syncLadders(options.laddersFile ?? LADDERS_FILE, now - 30 * 86400);
  for (const ladder of db.getLadders()) {
    db.setLadderStatus(ladder.id, 'active', now - 30 * 86400);
  }

  db.syncProjects(projectsFile, avatarsDir, now - 30 * 86400);
  db.linkDeveloperDiscord('scheibo', '513513270670262284', 'scheibo', now - 25 * 86400);
  db.linkDeveloperDiscord('pmariglia', '283674461268344832', 'pmariglia', now - 25 * 86400);
  db.linkDeveloperDiscord('jakegrigsby', '300000000000000001', 'jakegrigsby', now - 25 * 86400);
  db.linkDeveloperDiscord('pkmnbotguy', '300000000000000002', 'batistas_dick', now - 25 * 86400);
  db.syncDiscordMembers([
    {id: '513513270670262284', username: 'scheibo'},
    {id: '283674461268344832', username: 'pmariglia'},
    {id: '300000000000000001', username: 'jakegrigsby'},
    {id: '300000000000000002', username: 'batistas_dick'},
  ], now - 60);

  const shaOf = (tag: string): string => {
    const hex = Buffer.from(tag, 'utf8').toString('hex');
    return hex.repeat(Math.ceil(64 / hex.length)).slice(0, 64);
  };

  const zeroBot = db.getBotBySlug('0-error')!;
  const fpBot = db.getBotBySlug('foul-play')!;
  const mmBot = db.getBotBySlug('metamon')!;
  const mtBot = db.getBotBySlug('mews-truck')!;
  const mnBot = db.getBotBySlug('missingnozero')!;
  const xzBot = db.getBotBySlug('xatu-zero')!;
  const scheiboDev = db.getDeveloperByGitHub('scheibo')!;

  const vgcTeams0 = splitSubmittedTeams(generateValidVgcTeams(20, 0));
  const vgcTeams1 = splitSubmittedTeams(generateValidVgcTeams(20, 1));
  const vgcTeams2 = splitSubmittedTeams(generateValidVgcTeams(20, 2));
  const vgcTeams3 = splitSubmittedTeams(generateValidVgcTeams(20, 3));

  const submitAndPass = (input: {
    botId: number;
    devId?: number | null;
    ver: string;
    fmt: 'bundle' | 'oci';
    url: string;
    ladders: string[];
    teams?: Record<string, string[]>;
    at: number;
    bytes: number;
    durMs: number;
    turnMs: number;
    ramMb: number;
  }) => {
    const v = db.createSubmission({
      botId: input.botId,
      submittedByDevId: input.devId ?? null,
      versionStr: input.ver,
      formatType: input.fmt,
      downloadUrl: input.url,
      sha256: shaOf(`${input.botId}-${input.ver}`),
      authTokenEnc: null,
      ladderIds: input.ladders,
      teamsByLadder: input.teams,
      now: input.at,
    });
    db.applySubmissionStatus({
      versionId: v.id,
      smokeStatus: 'passed',
      unpackedBytes: input.bytes,
      smokeDurationMs: input.durMs,
      smokeTurnMs: input.turnMs,
      smokePeakRamMb: input.ramMb,
      now: input.at + 5,
    });
    return v;
  };

  // Historical failed smoke test on 0 ERROR (DM sent = 1) for /account/ History table
  const zeroFail = db.createSubmission({
    botId: zeroBot.id,
    submittedByDevId: scheiboDev.id,
    versionStr: '0.9.0-rc1',
    formatType: 'bundle',
    downloadUrl: 'https://r2.pkmn.cc/0-error-0.9.0-rc1.tar.zst',
    sha256: shaOf('0-error-0.9.0-rc1'),
    authTokenEnc: null,
    ladderIds: ['gen1ou20261109', 'gen9ou20261109'],
    now: now - 28 * 86400,
  });
  db.applySubmissionStatus({
    versionId: zeroFail.id,
    smokeStatus: 'failed_smoke_test',
    smokeErrorLog:
      'Error: invalid choice on turn 1 ("move 5")\n  at SearchAgent.choose (src/agent.zig:142)',
    now: now - 28 * 86400 + 8,
  });
  db.markVersionDmSent(zeroFail.id);

  const zV100 = submitAndPass({
    botId: zeroBot.id,
    devId: scheiboDev.id,
    ver: '1.0.0',
    fmt: 'bundle',
    url: 'https://r2.pkmn.cc/0-error-1.0.0.tar.zst',
    ladders: [
      'gen1ou20261109',
      'gen3ou20261109',
      'gen9ou20261109',
      'gen9randombattle20261109',
      'gen9championsvgc2026regmc',
    ],
    teams: {gen9championsvgc2026regmc: vgcTeams0},
    at: now - 27 * 86400,
    bytes: 184 * 1024 * 1024,
    durMs: 2400,
    turnMs: 310,
    ramMb: 820,
  });

  const fpV1 = submitAndPass({
    botId: fpBot.id,
    ver: '1.4.0',
    fmt: 'bundle',
    url: 'https://r2.pkmn.cc/foul-play-1.4.0.tar.zst',
    ladders: [
      'gen1ou20261109',
      'gen3ou20261109',
      'gen9ou20261109',
      'gen9randombattle20261109',
      'gen9championsvgc2026regmc',
    ],
    teams: {gen9championsvgc2026regmc: vgcTeams1},
    at: now - 27 * 86400 + 60,
    bytes: 142 * 1024 * 1024,
    durMs: 1900,
    turnMs: 260,
    ramMb: 640,
  });

  const mmV1 = submitAndPass({
    botId: mmBot.id,
    ver: '1.0.0',
    fmt: 'oci',
    url: 'ghcr.io/ut-austin-rpl/metamon:1.0.0',
    ladders: ['gen1ou20261109', 'gen3ou20261109', 'gen9ou20261109'],
    at: now - 27 * 86400 + 120,
    bytes: 412 * 1024 * 1024,
    durMs: 4200,
    turnMs: 480,
    ramMb: 2150,
  });

  const mtV1 = submitAndPass({
    botId: mtBot.id,
    ver: '1.0.0',
    fmt: 'bundle',
    url: 'https://r2.pkmn.cc/mews-truck-1.0.0.tar.zst',
    ladders: ['gen9ou20261109', 'gen9championsvgc2026regmc'],
    teams: {gen9championsvgc2026regmc: vgcTeams2},
    at: now - 27 * 86400 + 180,
    bytes: 298 * 1024 * 1024,
    durMs: 3100,
    turnMs: 390,
    ramMb: 1580,
  });

  const mnV1 = submitAndPass({
    botId: mnBot.id,
    ver: '2.1.0',
    fmt: 'bundle',
    url: 'https://r2.pkmn.cc/missingno-zero-2.1.0.tar.zst',
    ladders: ['gen1ou20261109', 'gen9randombattle20261109', 'gen9championsvgc2026regmc'],
    teams: {gen9championsvgc2026regmc: vgcTeams3},
    at: now - 27 * 86400 + 240,
    bytes: 210 * 1024 * 1024,
    durMs: 2700,
    turnMs: 340,
    ramMb: 980,
  });

  const xzV1 = submitAndPass({
    botId: xzBot.id,
    ver: '0.8.0',
    fmt: 'oci',
    url: 'ghcr.io/xatu/xatu-zero:0.8.0',
    ladders: ['gen1ou20261109', 'gen9ou20261109'],
    at: now - 26 * 86400,
    bytes: 356 * 1024 * 1024,
    durMs: 3800,
    turnMs: 440,
    ramMb: 1840,
  });

  // Designate 1500 Elo anchors per ladder
  db.setLadderAnchor('gen1ou20261109', 'metamon', '1.0.0', now - 26 * 86400 + 10);
  db.setLadderAnchor('gen3ou20261109', 'foul-play', '1.4.0', now - 26 * 86400 + 10);
  db.setLadderAnchor('gen9ou20261109', 'foul-play', '1.4.0', now - 26 * 86400 + 10);
  db.setLadderAnchor('gen9randombattle20261109', 'foul-play', '1.4.0', now - 26 * 86400 + 10);
  db.setLadderAnchor('gen9championsvgc2026regmc', 'foul-play', '1.4.0', now - 26 * 86400 + 10);

  let matchSeq = 0;
  const recordSeries = (
    ladderId: string,
    prefix: string,
    v1Id: number,
    v2Id: number,
    count: number,
    winBias: number,
    startAt: number,
    stepSec = 1800,
    labels?: {t1: string; t2: string}
  ) => {
    for (let k = 0; k < count; k++) {
      matchSeq++;
      const roll = ((k * 37 + matchSeq * 13) % 100) / 100;
      let g1: GameOutcome;
      let g2: GameOutcome;
      if (roll < winBias * 0.65) {
        g1 = 'W';
        g2 = 'W';
      } else if (roll < winBias) {
        g1 = 'W';
        g2 = 'L';
      } else {
        g1 = 'L';
        g2 = 'L';
      }
      const cat = `${g1}${g2}` as MatchCategory;
      db.recordCompletedMatch({
        match: {
          id: `${prefix}-${String(matchSeq).padStart(7, '0')}`,
          ladder_id: ladderId,
          v1_id: v1Id,
          v2_id: v2Id,
          seed: `100,200,300,${matchSeq}`,
          team1_label: labels?.t1 ?? null,
          team2_label: labels?.t2 ?? null,
          g1_outcome: g1,
          g2_outcome: g2,
          match_category: cat,
          g1_turns: 24 + (matchSeq % 19),
          g2_turns: 22 + ((matchSeq * 3) % 21),
          g1_end_reason: 'win',
          g2_end_reason: 'win',
          v1_peak_ram_mb: 860,
          v2_peak_ram_mb: 920,
          v1_g1_bank_s: 138,
          v1_g2_bank_s: 132,
          v2_g1_bank_s: 124,
          v2_g2_bank_s: 118,
          v1_avg_turn_ms: 340,
          v2_avg_turn_ms: 410,
          completed_at: startAt + k * stepSec,
        },
      });
    }
  };

  // Settle initial cohort across multiple UTC days so zV100 can upgrade to 1.1.0 -> 1.2.0
  recordSeries('gen1ou20261109', 'gen1ou', zV100.id, mmV1.id, 30, 0.72, now - 25 * 86400, 7200);
  recordSeries('gen1ou20261109', 'gen1ou', zV100.id, fpV1.id, 24, 0.68, now - 24 * 86400, 7200);
  recordSeries('gen1ou20261109', 'gen1ou', fpV1.id, mmV1.id, 26, 0.62, now - 24 * 86400, 7200);
  recordSeries('gen1ou20261109', 'gen1ou', mnV1.id, mmV1.id, 26, 0.54, now - 23 * 86400, 7200);
  recordSeries('gen1ou20261109', 'gen1ou', xzV1.id, mmV1.id, 14, 0.45, now - 22 * 86400, 7200);

  recordSeries('gen3ou20261109', 'gen3ou', zV100.id, fpV1.id, 50, 0.68, now - 24 * 86400, 7200);
  recordSeries('gen3ou20261109', 'gen3ou', mmV1.id, fpV1.id, 56, 0.84, now - 24 * 86400, 7200);

  recordSeries('gen9ou20261109', 'gen9ou', zV100.id, fpV1.id, 48, 0.68, now - 24 * 86400, 7200);
  recordSeries('gen9ou20261109', 'gen9ou', mtV1.id, fpV1.id, 50, 0.78, now - 24 * 86400, 7200);
  recordSeries('gen9ou20261109', 'gen9ou', xzV1.id, fpV1.id, 34, 0.56, now - 23 * 86400, 7200);
  recordSeries('gen9ou20261109', 'gen9ou', mmV1.id, fpV1.id, 30, 0.48, now - 23 * 86400, 7200);

  recordSeries(
    'gen9randombattle20261109', 'gen9rand', mnV1.id, fpV1.id, 56, 0.85, now - 24 * 86400, 7200
  );
  recordSeries(
    'gen9randombattle20261109', 'gen9rand', zV100.id, fpV1.id, 50, 0.68, now - 24 * 86400, 7200
  );

  recordSeries(
    'gen9championsvgc2026regmc',
    'vgc',
    mtV1.id,
    fpV1.id,
    58,
    0.86,
    now - 24 * 86400,
    7200,
    {t1: "Mew's Truck Team #1", t2: '0 ERROR Team #4'}
  );
  recordSeries(
    'gen9championsvgc2026regmc',
    'vgc',
    zV100.id,
    fpV1.id,
    50,
    0.72,
    now - 24 * 86400,
    7200,
    {t1: '0 ERROR Team #2', t2: 'MissingNo.Zero Team #7'}
  );
  recordSeries(
    'gen9championsvgc2026regmc',
    'vgc',
    mnV1.id,
    fpV1.id,
    46,
    0.58,
    now - 23 * 86400,
    7200,
    {t1: 'MissingNo.Zero Team #3', t2: "Mew's Truck Team #9"}
  );

  // Upgrade 0 ERROR -> 1.1.0 (after 14d cooldown) -> 1.2.0 (retiring 1.0.0 on RBY & SV!)
  const zV110 = submitAndPass({
    botId: zeroBot.id,
    devId: scheiboDev.id,
    ver: '1.1.0',
    fmt: 'bundle',
    url: 'https://r2.pkmn.cc/0-error-1.1.0.tar.zst',
    ladders: ['gen1ou20261109', 'gen9ou20261109'],
    at: now - 12 * 86400,
    bytes: 192 * 1024 * 1024,
    durMs: 2200,
    turnMs: 295,
    ramMb: 860,
  });
  recordSeries('gen1ou20261109', 'gen1ou', zV110.id, mmV1.id, 52, 0.62, now - 11 * 86400, 3600);
  recordSeries('gen1ou20261109', 'gen1ou', zV110.id, fpV1.id, 28, 0.56, now - 10 * 86400, 3600);
  recordSeries('gen9ou20261109', 'gen9ou', zV110.id, fpV1.id, 52, 0.64, now - 11 * 86400, 3600);
  recordSeries('gen9ou20261109', 'gen9ou', zV110.id, mtV1.id, 28, 0.52, now - 10 * 86400, 3600);

  db.refundCooldown('0-error', now - 4 * 86400);
  const zV120 = submitAndPass({
    botId: zeroBot.id,
    devId: scheiboDev.id,
    ver: '1.2.0',
    fmt: 'bundle',
    url: 'https://r2.pkmn.cc/0-error-1.2.0.tar.zst',
    ladders: ['gen1ou20261109', 'gen9ou20261109'],
    at: now - 3 * 86400,
    bytes: 198 * 1024 * 1024,
    durMs: 2100,
    turnMs: 280,
    ramMb: 890,
  });
  recordSeries('gen1ou20261109', 'gen1ou', zV120.id, mmV1.id, 46, 0.88, now - 2 * 86400, 2400);
  recordSeries('gen1ou20261109', 'gen1ou', zV120.id, fpV1.id, 36, 0.84, now - 86400, 2000);
  recordSeries('gen9ou20261109', 'gen9ou', zV120.id, mtV1.id, 48, 0.86, now - 2 * 86400, 2000);
  recordSeries('gen9ou20261109', 'gen9ou', zV120.id, fpV1.id, 44, 0.88, now - 86400, 1800);

  // Tournaments: #1 Completed ("Spring ’26") and #2 Running ("Autumn ’26")
  db.upsertTournament({
    id: '1',
    name: 'Spring ’26',
    format_id: 'gen9ou',
    games_per_matchup: 8,
    parallel_tables: 2,
    hardware_desc: 'GCP L4 Spot · 24 vCPU · 48 GB RAM',
    status: 'completed',
    starts_at: now - 90 * 86400,
    completed_at: now - 88 * 86400,
  });
  const springEntrants = [
    {
      bot: mtBot.id, ver: mtV1.id, seed: 1, rank: 1,
      elo: 1684, se: 24, w: 18, l: 4, t: 2, pts: 19, sb: 142.5,
    },
    {
      bot: zeroBot.id, ver: zV100.id, seed: 2, rank: 2,
      elo: 1642, se: 25, w: 15, l: 7, t: 2, pts: 16, sb: 118.0,
    },
    {
      bot: fpBot.id, ver: fpV1.id, seed: 3, rank: 3,
      elo: 1540, se: 26, w: 10, l: 12, t: 2, pts: 11, sb: 84.5,
    },
    {
      bot: mmBot.id, ver: mmV1.id, seed: 4, rank: 4,
      elo: 1465, se: 27, w: 5, l: 17, t: 2, pts: 6, sb: 46.0,
    },
  ];
  for (const ent of springEntrants) {
    db.upsertTournamentEntrant({
      tournament_id: '1',
      bot_id: ent.bot,
      version_id: ent.ver,
      seed_number: ent.seed,
      final_rank: ent.rank,
      tourney_elo: ent.elo,
      tourney_se: ent.se,
      game_wins: ent.w,
      game_losses: ent.l,
      game_ties: ent.t,
      points: ent.pts,
      sb_score: ent.sb,
    });
  }
  const packedSix = (names: string[]) => names.map(n => `|${n}`).join(']');
  db.upsertTournamentGame({
    id: 'spring26-sf1',
    tournament_id: '1',
    stage: 'sf',
    macro_cycle: 1,
    h2h_game_num: 1,
    p1_version_id: mtV1.id,
    p2_version_id: zV100.id,
    seed: '10,20,30,1',
    p1_team_packed: packedSix([
      'Great Tusk', 'Kingambit', 'Gholdengo', 'Dragapult', 'Ogerpon-Wellspring', 'Gliscor',
    ]),
    p2_team_packed: packedSix([
      'Zamazenta', 'Darkrai', 'Ting-Lu', 'Raging Bolt', 'Hatterene', 'Samurott-Hisui',
    ]),
    outcome: 'W',
    end_reason: 'win',
    turns: 34,
    p1_bank_left_s: 88,
    p2_bank_left_s: 64,
    status: 'completed',
    completed_at: now - 88 * 86400 - 300,
  });
  db.upsertTournamentGame({
    id: 'spring26-rr1',
    tournament_id: '1',
    stage: 'rr',
    macro_cycle: 1,
    h2h_game_num: 2,
    p1_version_id: zV100.id,
    p2_version_id: fpV1.id,
    seed: '10,20,30,2',
    p1_team_packed: packedSix([
      'Dragapult', 'Kingambit', 'Great Tusk', 'Slowking-Galar', 'Corviknight', 'Kyurem',
    ]),
    p2_team_packed: packedSix([
      'Gliscor', 'Gholdengo', 'Ting-Lu', 'Iron Valiant', 'Cinderace', 'Primarina',
    ]),
    outcome: 'W',
    end_reason: 'win',
    turns: 41,
    p1_bank_left_s: 72,
    p2_bank_left_s: 51,
    status: 'completed',
    completed_at: now - 89 * 86400 + 600,
  });

  db.upsertTournament({
    id: '2',
    name: 'Autumn ’26',
    format_id: 'gen9championsvgc2026regmc',
    games_per_matchup: 8,
    parallel_tables: 2,
    hardware_desc: 'GCP L4 Spot · 24 vCPU · 48 GB RAM',
    status: 'running',
    starts_at: now - 7200,
    completed_at: null,
  });
  const autumnEntrants = [
    {bot: zeroBot.id, ver: zV120.id, seed: 1, elo: 1628, se: 42, w: 6, l: 1, t: 0, pts: 6, sb: 18},
    {bot: mtBot.id, ver: mtV1.id, seed: 2, elo: 1610, se: 44, w: 5, l: 2, t: 0, pts: 5, sb: 15},
    {bot: fpBot.id, ver: fpV1.id, seed: 3, elo: 1512, se: 45, w: 3, l: 4, t: 0, pts: 3, sb: 9},
    {bot: mnBot.id, ver: mnV1.id, seed: 4, elo: 1450, se: 48, w: 0, l: 7, t: 0, pts: 0, sb: 0},
  ];
  for (const ent of autumnEntrants) {
    db.upsertTournamentEntrant({
      tournament_id: '2',
      bot_id: ent.bot,
      version_id: ent.ver,
      seed_number: ent.seed,
      final_rank: null,
      tourney_elo: ent.elo,
      tourney_se: ent.se,
      game_wins: ent.w,
      game_losses: ent.l,
      game_ties: ent.t,
      points: ent.pts,
      sb_score: ent.sb,
    });
  }
  db.upsertTournamentGame({
    id: 'autumn26-rr7',
    tournament_id: '2',
    stage: 'rr',
    macro_cycle: 2,
    h2h_game_num: 7,
    p1_version_id: zV120.id,
    p2_version_id: mtV1.id,
    seed: '10,20,30,7',
    p1_team_packed: packedSix([
      'Incineroar', 'Rillaboom', 'Archaludon', 'Pelipper', 'Basculegion', 'Farigiraf',
    ]),
    p2_team_packed: packedSix([
      'Garchomp', 'Talonflame', 'Gholdengo', 'Kingambit', 'Amoonguss', 'Sneasler',
    ]),
    outcome: 'W',
    end_reason: 'win',
    turns: 9,
    p1_bank_left_s: 112,
    p2_bank_left_s: 95,
    status: 'completed',
    completed_at: now - 900,
  });

  const liveTelemetry: LiveMatchTelemetry = {
    heartbeat_seq: 42,
    match_id: 'gen1ou-0000999',
    ladder_id: 'gen1ou20261109',
    slot: 'rby',
    format_id: 'gen1ou',
    game_num: 2,
    turn: 27,
    active_slot: 'p2',
    turn_started_at: now - 4,
    turn_budget_s: 138,
    increment_s: 10,
    g1_summary: {winner_slot: 'p1', turns: 31},
    p1: {
      slug: '0-error',
      name: '0 ERROR',
      version: '1.2.0',
      bank_s: 142,
      last_turn_ms: 290,
      mean_turn_ms: 280,
      ram_mb: 890,
    },
    p2: {
      slug: 'foul-play',
      name: 'Foul Play',
      version: '1.4.0',
      bank_s: 128,
      last_turn_ms: 340,
      mean_turn_ms: 315,
      ram_mb: 640,
    },
  };

  const liveDoc: LiveJsonDocument = {
    updated_at: now,
    stale: false,
    live: liveTelemetry,
    recent_matches: db.getRecentMatches(50),
  };

  const tournamentBroadcast: TournamentLiveBroadcast = {
    tournamentId: '2',
    tables: [
      {label: 'Table 1 · 0 ERROR vs Mew\'s Truck'},
      {label: 'Table 2 · Foul Play vs MissingNo.Zero'},
    ],
    seriesLeftHtml: 'Round Robin · Cycle 2 · Game 8',
    seriesRightHtml: '0 ERROR <code>1.2.0</code> vs Mew\'s Truck <code>1.0.0</code>',
    p1: {
      name: '0 ERROR',
      bankSeconds: 118,
      thinking: false,
      incrementSeconds: 25,
    },
    p2: {
      name: "Mew's Truck",
      bankSeconds: 104,
      thinking: true,
      incrementSeconds: 25,
    },
    lines: [
      '|player|p1|0 ERROR|1',
      '|player|p2|Mew\'s Truck|2',
      '|gametype|doubles',
      '|gen|9',
      '|tier|[Gen 9 Champions] VGC 2026 Reg M-C',
      '|turn|1',
    ],
    live: true,
  };

  if (options.render !== false && options.publicDir) {
    renderArenaPages({
      db,
      publicDir: options.publicDir,
      staticDir,
      avatarsDir,
      liveDoc,
      tournamentBroadcast,
      now,
    });
    const liveJsonPath = path.join(options.publicDir, 'api', 'live.json');
    fs.mkdirSync(path.dirname(liveJsonPath), {recursive: true});
    fs.writeFileSync(liveJsonPath, `${JSON.stringify(liveDoc)}\n`, 'utf8');
  }

  return {liveDoc, tournamentBroadcast};
}

interface RemotePendingLadder {
  id: string;
  slot: LadderSlot;
  display_name: string;
  format_id: string;
  team_mode: TeamMode;
  min_bots: number;
  team_count: number | null;
  status: LadderStatus;
}

interface RemotePendingSubmission {
  version_id: number;
  bot_id: number;
  bot_slug: string;
  bot_name: string;
  version_str: string;
  format_type: 'bundle' | 'oci';
  download_url: string;
  sha256: string;
  auth_token: string | null;
  ladders: string[];
  teams_by_ladder: Record<string, string[]>;
}

interface LocalVersionEntry {
  versionId: number;
  botId: number;
  botSlug: string;
  botName: string;
  versionStr: string;
  isAnchor: boolean;
  strengthBias: number;
  active: boolean;
  matchesPlayed: number;
  ratingElo: number;
  ratingSe: number;
  ratingLcb: number;
  settled: boolean;
}

interface LocalLadderState {
  meta: RemotePendingLadder;
  entries: LocalVersionEntry[];
  pairs: Map<string, PairMatchCounts>;
  teamsByBot: Map<number, {botName: string; teams: string[]}>;
  lastMatchNumber: number;
}

export interface SmokeDecision {
  smokeStatus: 'passed' | 'failed_smoke_test' | 'quarantined';
  smokeErrorLog?: string | null;
  unpackedBytes?: number;
  smokeDurationMs?: number;
  smokeTurnMs?: number;
  smokePeakRamMb?: number;
}

export interface MockArenaClientOptions {
  serverUrl: string;
  arenaSecret: string;
  seed?: number;
  now?: () => number;
  decideSmoke?: (sub: RemotePendingSubmission) => SmokeDecision;
}

export class MockArenaClient {
  private readonly serverUrl: string;
  private readonly arenaSecret: string;
  private readonly rng: (max: number) => number;
  private readonly getNowSec: () => number;
  private readonly decideSmoke: (sub: RemotePendingSubmission) => SmokeDecision;
  private readonly ladders = new Map<string, LocalLadderState>();
  private heartbeatSeq = 0;
  private globalMatchSeq = 0;

  constructor(options: MockArenaClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.arenaSecret = options.arenaSecret;
    this.rng = createRng(options.seed ?? 20261110);
    this.getNowSec = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.decideSmoke = options.decideSmoke ?? (() => ({smokeStatus: 'passed'}));
  }

  private async requestJson<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    body?: object
  ): Promise<T> {
    const res = await fetch(`${this.serverUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.arenaSecret}`,
        ...(body ? {'Content-Type': 'application/json'} : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Arena HTTP ${method} ${endpoint} failed (${res.status}): ${text}`);
    }
    return await res.json() as T;
  }

  private recomputeLocalLadder(ladder: LocalLadderState) {
    const M = ladder.entries.length;
    if (M === 0) return;
    const indexByVersion = new Map<number, number>();
    for (let i = 0; i < M; i++) {
      indexByVersion.set(ladder.entries[i].versionId, i);
    }
    const pairList: PairMatchCounts[] = [];
    for (const [key, counts] of ladder.pairs) {
      const [lowStr, highStr] = key.split(':');
      const i = indexByVersion.get(Number(lowStr));
      const j = indexByVersion.get(Number(highStr));
      if (i !== undefined && j !== undefined) {
        pairList.push({...counts, i, j});
      }
    }
    const anchorIdx = ladder.entries.findIndex(e => e.isAnchor);
    const res = computeDavidsonRatings(M, pairList, anchorIdx, 1500);
    for (let i = 0; i < M; i++) {
      const e = ladder.entries[i];
      e.ratingElo = res.elo[i];
      e.ratingSe = res.eloStd[i];
      e.ratingLcb = res.eloLcb[i];
      if (!e.settled && e.matchesPlayed >= 25 && e.ratingSe <= 30.0) {
        e.settled = true;
      }
    }
  }

  setAnchor(ladderId: string, botSlug: string, versionStr: string) {
    const ladder = this.ladders.get(ladderId);
    if (!ladder) return;
    for (const entry of ladder.entries) {
      entry.isAnchor = entry.botSlug === botSlug && entry.versionStr === versionStr;
    }
    this.recomputeLocalLadder(ladder);
  }

  async syncPendingSubmissions(): Promise<number> {
    const payload = await this.requestJson<{
      ladders: RemotePendingLadder[];
      submissions: RemotePendingSubmission[];
    }>('GET', '/api/arena/pending-submissions');

    const activeIds = new Set<string>();
    for (const meta of payload.ladders) {
      activeIds.add(meta.id);
      const existing = this.ladders.get(meta.id);
      if (existing) {
        existing.meta = meta;
      } else {
        this.ladders.set(meta.id, {
          meta,
          entries: [],
          pairs: new Map(),
          teamsByBot: new Map(),
          lastMatchNumber: 0,
        });
      }
    }
    for (const id of [...this.ladders.keys()]) {
      if (!activeIds.has(id)) {
        this.ladders.get(id)!.meta.status = 'archived';
      }
    }

    let processed = 0;
    for (const sub of payload.submissions) {
      const decision = this.decideSmoke(sub);
      const retiredByLadder: Record<string, number> = {};

      if (decision.smokeStatus === 'passed') {
        for (const ladderId of sub.ladders) {
          const ladder = this.ladders.get(ladderId);
          if (!ladder) continue;
          const submittedTeams = sub.teams_by_ladder[ladderId];
          if (submittedTeams?.length) {
            ladder.teamsByBot.set(sub.bot_id, {
              botName: sub.bot_name,
              teams: submittedTeams,
            });
          }

          this.recomputeLocalLadder(ladder);
          const otherActive = ladder.entries
            .filter(e => e.botId === sub.bot_id && e.active && e.versionId !== sub.version_id)
            .sort((a, b) => a.ratingLcb - b.ratingLcb || a.versionId - b.versionId);

          while (otherActive.length >= 2) {
            const weakest = otherActive.shift()!;
            weakest.active = false;
            retiredByLadder[ladderId] = weakest.versionId;
          }

          if (!ladder.entries.some(e => e.versionId === sub.version_id)) {
            const bias = ((sub.bot_id * 31 + sub.version_id * 17) % 11 - 5) * 0.12;
            ladder.entries.push({
              versionId: sub.version_id,
              botId: sub.bot_id,
              botSlug: sub.bot_slug,
              botName: sub.bot_name,
              versionStr: sub.version_str,
              isAnchor: false,
              strengthBias: bias,
              active: true,
              matchesPlayed: 0,
              ratingElo: 1500,
              ratingSe: 350,
              ratingLcb: 814,
              settled: false,
            });
          }
        }
      }

      await this.requestJson('POST', '/api/arena/submission-status', {
        version_id: sub.version_id,
        smoke_status: decision.smokeStatus,
        unpacked_bytes: decision.unpackedBytes ?? 196 * 1024 * 1024,
        smoke_duration_ms: decision.smokeDurationMs ?? 2100,
        smoke_turn_ms: decision.smokeTurnMs ?? 300,
        smoke_peak_ram_mb: decision.smokePeakRamMb ?? 840,
        smoke_error_log: decision.smokeErrorLog ?? null,
        retired_version_ids_by_ladder: retiredByLadder,
      });
      processed++;
    }

    return processed;
  }

  async quarantineVersion(versionId: number, reason: string): Promise<void> {
    for (const ladder of this.ladders.values()) {
      for (const entry of ladder.entries) {
        if (entry.versionId === versionId) {
          entry.active = false;
        }
      }
    }
    await this.requestJson('POST', '/api/arena/submission-status', {
      version_id: versionId,
      smoke_status: 'quarantined',
      smoke_error_log: reason,
    });
  }

  async sendIdleHeartbeat(): Promise<void> {
    await this.requestJson('POST', '/api/arena/heartbeat', {
      idle: true,
    });
  }

  async playMatchStep(options: {
    ladderId?: string;
    emitHeartbeats?: boolean;
  } = {}): Promise<{
    matchId: string;
    ladderId: string;
    v1Id: number;
    v2Id: number;
    t1Label: string | null;
    t2Label: string | null;
    archivedLadder: boolean;
  } | null> {
    const candidateStates: LadderMatchState[] = [];

    for (const [ladderId, ladder] of this.ladders) {
      if (options.ladderId && ladderId !== options.ladderId) continue;
      if (ladder.meta.status !== 'active' && ladder.meta.status !== 'settling') continue;

      const activeEntries = ladder.entries.filter(e => e.active);
      const distinctBots = new Set(activeEntries.map(e => e.botId));
      if (distinctBots.size < ladder.meta.min_bots) continue;

      if (ladder.meta.status === 'settling' && activeEntries.every(e => e.settled)) {
        continue;
      }

      this.recomputeLocalLadder(ladder);
      const M = ladder.entries.length;
      const activeIndices: number[] = [];
      const theta = new Float64Array(M);
      const sigma = new Float64Array(M);
      const botMatches = new Int32Array(M);
      const pairMatches = new Int32Array(M * M);

      for (let i = 0; i < M; i++) {
        const e = ladder.entries[i];
        if (e.active) activeIndices.push(i);
        theta[i] = (e.ratingElo - 1500) / (400 / Math.LN10);
        sigma[i] = e.ratingSe / (400 / Math.LN10);
        botMatches[i] = e.matchesPlayed;
      }

      for (let i = 0; i < M; i++) {
        for (let j = i + 1; j < M; j++) {
          const low = Math.min(ladder.entries[i].versionId, ladder.entries[j].versionId);
          const high = Math.max(ladder.entries[i].versionId, ladder.entries[j].versionId);
          const rec = ladder.pairs.get(`${low}:${high}`);
          const count = rec ? rec.ww + rec.wt + rec.split + rec.tl + rec.ll : 0;
          pairMatches[i * M + j] = count;
          pairMatches[j * M + i] = count;
        }
      }

      candidateStates.push({
        id: ladderId,
        activeBotIndices: activeIndices,
        theta,
        sigma,
        botMatches,
        pairMatches,
        lastMatchNumber: ladder.lastMatchNumber,
      });
    }

    if (!candidateStates.length) return null;

    const choice = selectNextArenaMatch(candidateStates, this.globalMatchSeq + 1);
    if (!choice) return null;

    const ladder = this.ladders.get(choice.ladderId)!;
    let e1 = ladder.entries[choice.botI];
    let opponent = ladder.entries[choice.botJ];
    // Never pair two versions of the same project; keep the less-settled version!
    if (e1.botId === opponent.botId) {
      if (opponent.matchesPlayed < e1.matchesPlayed) {
        e1 = opponent;
      }
      const alt = ladder.entries
        .filter(e => e.active && e.botId !== e1.botId)
        .sort((a, b) => a.matchesPlayed - b.matchesPlayed)[0];
      if (!alt) return null;
      opponent = alt;
    }

    let t1Label: string | null = null;
    let t2Label: string | null = null;
    if (ladder.meta.team_mode === 'competitor_pool') {
      const activeBotIds = new Set(ladder.entries.filter(e => e.active).map(e => e.botId));
      const pool = buildCanonicalTeamPool(
        [...ladder.teamsByBot.entries()]
          .filter(([botId]) => activeBotIds.has(botId))
          .map(([botId, data]) => ({botId, botName: data.botName, teams: data.teams})),
        ladder.meta.format_id
      );
      const sampled = sampleCompetitorPoolPair(pool, e1.botId, opponent.botId, this.rng);
      t1Label = sampled.t1Label;
      t2Label = sampled.t2Label;
    }

    this.globalMatchSeq++;
    ladder.lastMatchNumber = this.globalMatchSeq;
    const matchId = `${ladder.meta.format_id}-${String(this.globalMatchSeq).padStart(7, '0')}`;
    const nowSec = this.getNowSec();

    const diff = e1.strengthBias - opponent.strengthBias;
    const pWin = 1 / (1 + Math.exp(-diff));
    const sampleGame = (): GameOutcome => (this.rng(1000) / 1000 < pWin ? 'W' : 'L');
    const g1 = sampleGame();
    const g2 = sampleGame();
    const cat = `${g1}${g2}` as MatchCategory;

    if (options.emitHeartbeats !== false) {
      this.heartbeatSeq++;
      await this.requestJson('POST', '/api/arena/heartbeat', {
        heartbeat_seq: this.heartbeatSeq,
        match_id: matchId,
        ladder_id: ladder.meta.id,
        format_id: ladder.meta.format_id,
        game_num: 1,
        turn: 14,
        active_slot: 'p1',
        turn_started_at: nowSec,
        turn_budget_s: 145,
        increment_s: ladder.meta.slot === 'vgc' ? 25 : 10,
        g1_summary: null,
        p1: {
          slug: e1.botSlug,
          name: e1.botName,
          version: e1.versionStr,
          bank_s: 145,
          last_turn_ms: 280,
          mean_turn_ms: 295,
          ram_mb: 840,
        },
        p2: {
          slug: opponent.botSlug,
          name: opponent.botName,
          version: opponent.versionStr,
          bank_s: 142,
          last_turn_ms: 310,
          mean_turn_ms: 305,
          ram_mb: 790,
        },
      });

      this.heartbeatSeq++;
      await this.requestJson('POST', '/api/arena/heartbeat', {
        heartbeat_seq: this.heartbeatSeq,
        match_id: matchId,
        ladder_id: ladder.meta.id,
        format_id: ladder.meta.format_id,
        game_num: 2,
        turn: 21,
        active_slot: 'p2',
        turn_started_at: nowSec,
        turn_budget_s: 136,
        increment_s: ladder.meta.slot === 'vgc' ? 25 : 10,
        g1_summary: {winner_slot: g1 === 'W' ? 'p1' : 'p2', turns: 28},
        p1: {
          slug: e1.botSlug,
          name: e1.botName,
          version: e1.versionStr,
          bank_s: 138,
          last_turn_ms: 275,
          mean_turn_ms: 290,
          ram_mb: 850,
        },
        p2: {
          slug: opponent.botSlug,
          name: opponent.botName,
          version: opponent.versionStr,
          bank_s: 136,
          last_turn_ms: 325,
          mean_turn_ms: 310,
          ram_mb: 800,
        },
      });
    }

    // Update local state before deciding whether a settling ladder can transition to archived
    e1.matchesPlayed++;
    opponent.matchesPlayed++;
    const lowId = Math.min(e1.versionId, opponent.versionId);
    const highId = Math.max(e1.versionId, opponent.versionId);
    const pairKey = `${lowId}:${highId}`;
    let agg = ladder.pairs.get(pairKey);
    if (!agg) {
      agg = {i: 0, j: 0, ww: 0, wt: 0, split: 0, tl: 0, ll: 0};
      ladder.pairs.set(pairKey, agg);
    }
    const v1IsLow = e1.versionId === lowId;
    if (cat === 'WW') {
      if (v1IsLow) agg.ww++;
      else agg.ll++;
    } else if (cat === 'LL') {
      if (v1IsLow) agg.ll++;
      else agg.ww++;
    } else {
      agg.split++;
    }

    this.recomputeLocalLadder(ladder);
    const shouldArchive = (
      ladder.meta.status === 'settling' &&
      ladder.entries.filter(e => e.active).every(e => e.settled)
    );

    const res = await this.requestJson<{
      ok: boolean;
      duplicate: boolean;
      archived_ladder: boolean;
    }>('POST', '/api/arena/match-complete', {
      match: {
        id: matchId,
        ladder_id: ladder.meta.id,
        v1_id: e1.versionId,
        v2_id: opponent.versionId,
        seed: `100,200,300,${this.globalMatchSeq}`,
        team1_label: t1Label,
        team2_label: t2Label,
        g1_outcome: g1,
        g2_outcome: g2,
        match_category: cat,
        g1_turns: 28,
        g2_turns: 26,
        g1_end_reason: 'win',
        g2_end_reason: 'win',
        v1_peak_ram_mb: 850,
        v2_peak_ram_mb: 800,
        v1_g1_bank_s: 140,
        v1_g2_bank_s: 138,
        v2_g1_bank_s: 136,
        v2_g2_bank_s: 134,
        v1_avg_turn_ms: 290,
        v2_avg_turn_ms: 310,
        completed_at: nowSec,
      },
      ...(shouldArchive ? {ladder_status: 'archived' as const} : {}),
    });

    if (res.archived_ladder) {
      ladder.meta.status = 'archived';
    }

    return {
      matchId,
      ladderId: ladder.meta.id,
      v1Id: e1.versionId,
      v2Id: opponent.versionId,
      t1Label,
      t2Label,
      archivedLadder: res.archived_ladder,
    };
  }
}

const CLI_USAGE = [
  'Usage: mock-arena <seed|step|run> [options]',
  '',
  'Commands:',
  '  seed [--db <path>] [--public-dir <dir>] [--now <unix_sec>]',
  '  step [--server <url>] [--secret <token>] [--matches <n>] [--smoke <pass|fail>]',
  '  run  [--server <url>] [--secret <token>] [--interval-ms <ms>] [--smoke <pass|fail>]',
].join('\n');

export async function runMockArenaCli(argv: string[]): Promise<void> {
  const {positionals, values} = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: {type: 'string'},
      'public-dir': {type: 'string'},
      server: {type: 'string'},
      secret: {type: 'string'},
      matches: {type: 'string'},
      'interval-ms': {type: 'string'},
      smoke: {type: 'string'},
      now: {type: 'string'},
      help: {type: 'boolean'},
    },
  });

  const cmd = positionals[0];
  if (!cmd || cmd === 'help' || values.help) {
    console.log(CLI_USAGE);
    return;
  }

  if (cmd === 'seed') {
    const dbPath = values.db ?? DB_PATH;
    const publicDir = values['public-dir'] ?? PUBLIC_DIR;
    const now = values.now ? Number(values.now) : Math.floor(Date.now() / 1000);
    const tmpStatic = fs.mkdtempSync(path.join(root('private'), 'mock-static-'));
    const db = new ArenaDB(dbPath);
    try {
      const avatarsDir = path.join(tmpStatic, 'avatars');
      prepareMockStaticDir(tmpStatic, avatarsDir);
      seedMockArena({
        db,
        publicDir,
        staticDir: tmpStatic,
        avatarsDir,
        now,
        render: true,
      });
      console.log(`Seeded mock Arena DB at ${dbPath} and rendered pages into ${publicDir}`);
    } finally {
      db.close();
      fs.rmSync(tmpStatic, {recursive: true, force: true});
    }
    return;
  }

  const serverUrl = values.server ?? process.env.ARENA_SERVER_URL ?? 'http://127.0.0.1:1234';
  const arenaSecret = values.secret ?? process.env.ARENA_SECRET ?? '';
  if (!arenaSecret) {
    throw new Error('Missing ARENA_SECRET (pass --secret or set ARENA_SECRET in private/.env)');
  }
  const smokeMode = values.smoke === 'fail' ? 'failed_smoke_test' : 'passed';
  const client = new MockArenaClient({
    serverUrl,
    arenaSecret,
    decideSmoke: () => ({
      smokeStatus: smokeMode,
      smokeErrorLog: smokeMode === 'failed_smoke_test' ? 'Simulated smoke test failure' : null,
    }),
  });

  if (cmd === 'step') {
    const subCount = await client.syncPendingSubmissions();
    const matchesToPlay = values.matches ? Number(values.matches) : 1;
    let played = 0;
    for (let i = 0; i < matchesToPlay; i++) {
      const res = await client.playMatchStep();
      if (!res) break;
      played++;
    }
    console.log(`Processed ${subCount} submission(s) and played ${played} match(es)`);
    return;
  }

  if (cmd === 'run') {
    const intervalMs = values['interval-ms'] ? Number(values['interval-ms']) : 2000;
    const state = {running: true};
    process.on('SIGINT', () => {
      state.running = false;
    });
    process.on('SIGTERM', () => {
      state.running = false;
    });
    while (state.running) {
      await client.syncPendingSubmissions();
      const step = await client.playMatchStep();
      if (!step) {
        await client.sendIdleHeartbeat();
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return;
  }

  throw new Error(`Unknown command "${cmd}"\n\n${CLI_USAGE}`);
}

if (require.main === module) {
  require('source-map-support').install();
  runMockArenaCli(process.argv.slice(2)).catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
