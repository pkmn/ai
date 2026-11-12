// Mock Arena simulator, team-pool sampler, and deterministic database seeder (`npm run mock`).
//
// Used by:
//   - `tools/shots.ts` to populate realistic 10-agent ladders, multi-week rating histories,
//     dense matchup matrices, and championship tournaments for visual regression screenshots.
//   - `test/e2e.test.ts` (`MockArenaClient`) to exercise the full `/api/arena/*` HTTP protocol,
//     team-pool provenance sampling, 14-day cooldowns, version retirement, and ladder rotation.
//   - Local operators (`npm run mock -- seed | step | run`) when developing without the Mac Mini.

import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {parseArgs} from 'util';

import * as champions from '@pkmn/mods/champions';
import {Team} from '@pkmn/sets';
import * as sim from '@pkmn/sim';
import * as yaml from 'yaml';

import {DB_PATH, Database, LADDERS_FILE, LadderSlot, LadderStatus, TeamMode} from '../db';
import * as arena from '../server/arena';
import * as ratings from '../server/ratings';
import * as render from '../server/render';
import {formatPoolTeamLabel, splitSubmittedTeams} from '../server/teams';
import * as tournaments from '../server/tournaments';
import {Project} from '../static/projects';
import {root, toID} from '../static/util';
import {getDex, hashTeam, parseTeam} from '../teams';

const CHAMPIONS_SIM_DEX = sim.Dex.mod('champions', champions as unknown as sim.ModData);

export interface CanonicalPoolEntry {
  canonicalPacked: string;
  speciesIds: string[];
  owners: Map<number, {agentName: string; slotIndex: number}>;
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

function extractSpeciesIdsFromPacked(packed: string, format: string): string[] {
  const cacheKey = `${format}:${packed}`;
  const cached = speciesCache.get(cacheKey);
  if (cached) return cached;

  try {
    const dex = getDex(format);
    const parsed = parseTeam(dex, packed);
    if (parsed.length > 0) {
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

function normalizeCanonicalPacked(rawTeam: string, format: string): string {
  const trimmed = rawTeam.trim();
  if (!trimmed.includes('\n')) return trimmed;
  try {
    const dex = getDex(format);
    const imported = Team.import(trimmed, dex);
    const sets = Team.canonicalize((imported?.team || []).filter(s => s?.moves?.length), dex);
    if (sets.length > 0) return new Team(sets, dex).pack();
  } catch {}
  return trimmed;
}

export function buildCanonicalTeamPool(
  teamsByAgent: Iterable<{agentId: number; agentName: string; teams: string[]}>,
  format = 'gen9championsvgc2026regmc'
): CanonicalPoolEntry[] {
  const byPacked = new Map<string, CanonicalPoolEntry>();
  for (const {agentId, agentName, teams} of teamsByAgent) {
    for (let idx = 0; idx < teams.length; idx++) {
      const canonicalPacked = normalizeCanonicalPacked(teams[idx], format);
      if (!canonicalPacked) continue;
      let entry = byPacked.get(canonicalPacked);
      if (!entry) {
        entry = {
          canonicalPacked,
          speciesIds: extractSpeciesIdsFromPacked(canonicalPacked, format),
          owners: new Map(),
        };
        byPacked.set(canonicalPacked, entry);
      }
      if (!entry.owners.has(agentId)) {
        entry.owners.set(agentId, {agentName, slotIndex: idx + 1});
      }
    }
  }
  return [...byPacked.values()];
}

function isValidPoolsPair(
  t1: CanonicalPoolEntry,
  t2: CanonicalPoolEntry,
  agentAId: number,
  agentBId: number
): boolean {
  if (t1.canonicalPacked === t2.canonicalPacked) return false;
  if (
    t1.speciesIds.length === t2.speciesIds.length &&
    t1.speciesIds.every((s, idx) => s === t2.speciesIds[idx])
  ) {
    return false;
  }
  if (t1.owners.has(agentAId) && t1.owners.has(agentBId)) return false;
  if (t2.owners.has(agentAId) && t2.owners.has(agentBId)) return false;
  const activeOwnsT1 = t1.owners.has(agentAId) || t1.owners.has(agentBId);
  const activeOwnsT2 = t2.owners.has(agentAId) || t2.owners.has(agentBId);
  if (activeOwnsT1 && activeOwnsT2) return false;
  for (const ownerId of t1.owners.keys()) {
    if (t2.owners.has(ownerId)) return false;
  }
  return true;
}

// Uniform pseudo-blind-pair sampler for `team: pools` ladders (e.g. VGC):
//   - Requires `N >= 4` distinct active agent rosters (`min >= 4`).
//   - Samples unordered distinct roster pair `{I, J}` with exact marginal `2 / N` per agent:
//       * `2 / N`: `{agentAId, C}` for uniform third party `C not in {A, B}`
//       * `2 / N`: `{agentBId, C}` for uniform third party `C not in {A, B}`
//       * `(N - 4) / N`: `{C1, C2}` uniformly from distinct third parties
//   - Swaps `(I, J)` with probability `1/2`, draws uniformly within each roster, and rejection-
//     resamples mirrors / cross-competitor exact duplicates so at most ONE of `{T1, T2}` belongs
//     to `P_A U P_B` while every agent's teams are assigned with equal `2 / (N * K)` probability.
export function samplePoolsPair(
  pool: CanonicalPoolEntry[],
  agentAId: number,
  agentBId: number,
  rngNextInt: (max: number) => number
): SampledPoolPair {
  if (agentAId === agentBId) {
    throw new Error('Cannot sample pools pair for identical competing agents');
  }

  const rosters = new Map<number, CanonicalPoolEntry[]>();
  for (const entry of pool) {
    for (const ownerId of entry.owners.keys()) {
      let list = rosters.get(ownerId);
      if (!list) {
        list = [];
        rosters.set(ownerId, list);
      }
      list.push(entry);
    }
  }

  const thirdParties = [...rosters.keys()]
    .filter(id => id !== agentAId && id !== agentBId)
    .sort((a, b) => a - b);
  const totalAgents = rosters.size;
  if (
    totalAgents < 4 ||
    !rosters.get(agentAId)?.length ||
    !rosters.get(agentBId)?.length ||
    thirdParties.length < 2
  ) {
    throw new Error('Insufficient third-party teams in pool (pools ladders require min >= 4)');
  }

  const formatProvenanceLabel = (entry: CanonicalPoolEntry): string => {
    const owner = entry.owners.has(agentAId)
      ? 'P1'
      : entry.owners.has(agentBId)
        ? 'P2'
        : undefined;
    return formatPoolTeamLabel(entry.canonicalPacked, owner);
  };

  for (let attempt = 0; attempt < 256; attempt++) {
    const roll = rngNextInt(totalAgents);
    let firstAgentId: number;
    let secondAgentId: number;
    if (roll < 2) {
      firstAgentId = agentAId;
      secondAgentId = thirdParties[rngNextInt(thirdParties.length)];
    } else if (roll < 4) {
      firstAgentId = agentBId;
      secondAgentId = thirdParties[rngNextInt(thirdParties.length)];
    } else {
      const i1 = rngNextInt(thirdParties.length);
      let i2 = rngNextInt(thirdParties.length - 1);
      if (i2 >= i1) i2++;
      firstAgentId = thirdParties[i1];
      secondAgentId = thirdParties[i2];
    }
    if (rngNextInt(2) === 1) {
      [firstAgentId, secondAgentId] = [secondAgentId, firstAgentId];
    }

    const r1 = rosters.get(firstAgentId)!;
    const r2 = rosters.get(secondAgentId)!;
    const t1 = r1[rngNextInt(r1.length)];
    const t2 = r2[rngNextInt(r2.length)];
    if (!isValidPoolsPair(t1, t2, agentAId, agentBId)) continue;

    return {
      t1Packed: t1.canonicalPacked,
      t2Packed: t2.canonicalPacked,
      t1Label: formatProvenanceLabel(t1),
      t2Label: formatProvenanceLabel(t2),
    };
  }

  // Deterministic exhaustive fallback for degenerate synthetic pools with heavy duplicate overlap
  const validPairs: Array<[CanonicalPoolEntry, CanonicalPoolEntry]> = [];
  for (const t1 of pool) {
    for (const t2 of pool) {
      if (isValidPoolsPair(t1, t2, agentAId, agentBId)) {
        validPairs.push([t1, t2]);
      }
    }
  }
  if (!validPairs.length) {
    throw new Error('Insufficient third-party teams in pool (pools ladders require min >= 4)');
  }
  const [t1, t2] = validPairs[rngNextInt(validPairs.length)];
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

const ZERO_ERROR_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAPklEQVR4nO3SwQkAIAwDwZb9d+7C' +
  'wcEXkJ6SuQkAAPBn1tp7zhljjAmcB1wHXAdcB1wHXAdcB1wHXAdc5wE93QMR8wX8WQAAAABJRU5ErkJggg==';

export function prepareMockStaticDir(
  targetStaticDir: string,
  targetAvatarsDir: string,
  baseStaticDir = render.STATIC_DIR
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
    'Jaxcalibur': {
      qualified: true,
      owners: {jaxdev: 'jaxdev.610006'},
    },
    'eevenator': {
      qualified: true,
      owners: {eevedev: 'eevedev.610007'},
    },
    'AWRorus': {
      qualified: true,
      owners: {awrdev: 'awrdev.610008'},
    },
    'MysteriousWind': {
      qualified: true,
      owners: {winddev: 'winddev.610009'},
    },
    'pokerus': {
      qualified: true,
      owners: {pokerusdev: 'pokerusdev.610010'},
    },
    'mikumiku': {
      qualified: true,
      owners: {mikudev: 'mikudev.610011'},
    },
    'CynthiAI': {
      qualified: true,
      owners: {sisyphus25: 'sisyphus25.610012'},
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

const MOCK_WIKI_INDEX = `# Wiki

Shared documentation, format notes, and project profiles for the \`pkmn.ai\` community.

## Pages

- [0 ERROR](0_ERROR) — Gen 9 OU search & evaluation agent by *pre*.
- [Gen 9 OU](Gen_9_OU) — Metagame overview, team structures, and benchmark baselines.
`;

const MOCK_WIKI_GEN9OU = [
  '# Gen 9 OU',
  '',
  'Standard Smogon Singles format used for the `pkmn.ai` ladder and tournament benchmarks.',
  '',
  '## Evaluation',
  '',
  'Agents are evaluated across 2-game blind-pair matches using Davidson MAP ratings:',
  '',
  '$$`P(i \\text{ beats } j) = ' +
    '\\frac{\\gamma_i}{\\gamma_i + \\gamma_j + \\nu \\sqrt{\\gamma_i \\gamma_j}}`',
  '',
].join('\n');

const MOCK_WIKI_PROJECT_V1 = `{% visibility: developers %}
# 0 ERROR

\`0 ERROR\` is a Gen 9 OU battle agent developed by *pre*.

## Architecture

- Depth-limited Nash equilibrium search over packed battle states.
- Move ordering guided by damage calculator bounds.
`;

const MOCK_WIKI_PROJECT_V2 = `{% visibility: developers %}
# 0 ERROR

\`0 ERROR\` is a Gen 9 OU battle agent developed by *pre*.

## Architecture

- Depth-limited Nash equilibrium search over packed battle states.
- Neural leaf evaluation network trained via self-play trajectories.
- Team preview policy conditioned on revealed opponent archetypes.
`;

export function seedMockWiki(wikiDir: string): string {
  fs.rmSync(wikiDir, {recursive: true, force: true});
  fs.mkdirSync(wikiDir, {recursive: true});

  const git = (args: string[], date?: string) =>
    execFileSync('git', args, {
      cwd: wikiDir,
      env: date
        ? {
          ...process.env,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        }
        : process.env,
    });

  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'pkmn.ai']);
  git(['config', 'user.email', 'wiki@pkmn.ai']);

  fs.writeFileSync(path.join(wikiDir, 'index.dj'), MOCK_WIKI_INDEX, 'utf8');
  fs.writeFileSync(path.join(wikiDir, 'Gen_9_OU.dj'), MOCK_WIKI_GEN9OU, 'utf8');
  fs.writeFileSync(path.join(wikiDir, '0_ERROR.dj'), MOCK_WIKI_PROJECT_V1, 'utf8');
  git(['add', 'index.dj', 'Gen_9_OU.dj', '0_ERROR.dj']);
  git(
    [
      'commit',
      '--author=scheibo <scheibo@users.noreply.github.com>',
      '-m', 'Create initial wiki pages',
    ],
    '2026-10-18T12:00:00Z'
  );

  fs.writeFileSync(path.join(wikiDir, '0_ERROR.dj'), MOCK_WIKI_PROJECT_V2, 'utf8');
  git(['add', '0_ERROR.dj']);
  git(
    [
      'commit',
      '--author=pmariglia <pmariglia@users.noreply.github.com>',
      '-m', 'Document neural value network',
    ],
    '2026-10-20T12:00:00Z'
  );

  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: wikiDir,
    encoding: 'utf8',
  }).trim();
}

export interface SeedOptions {
  db: Database;
  publicDir?: string;
  staticDir?: string;
  avatarsDir?: string;
  laddersFile?: string;
  now?: number;
  render?: boolean;
}

export interface SeedResult {
  liveDoc: arena.LiveDocument;
  tournamentBroadcast: tournaments.LiveBroadcast;
  featuredBattleId: string;
}

export function seedMockArena(options: SeedOptions): SeedResult {
  const {db} = options;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const staticDir = options.staticDir ?? render.STATIC_DIR;
  const avatarsDir = options.avatarsDir ?? path.join(staticDir, 'avatars');
  const projectsFile = path.join(staticDir, 'projects.yml');

  db.syncLadders(options.laddersFile ?? LADDERS_FILE, now - 30 * 86400);
  for (const ladder of db.getLadders()) {
    db.setLadderStatus(ladder.id, 'active', now - 30 * 86400);
  }

  db.syncProjects(projectsFile, avatarsDir, now - 30 * 86400);
  db.linkDeveloperDiscord('scheibo', '513513270670262284', 'scheibo', now - 28 * 86400);
  db.linkDeveloperDiscord('pmariglia', '283674461268344832', 'pmariglia', now - 28 * 86400);
  db.linkDeveloperDiscord('jakegrigsby', '300000000000000001', 'jakegrigsby', now - 28 * 86400);
  db.linkDeveloperDiscord('pkmnbotguy', '300000000000000002', 'batistas_dick', now - 28 * 86400);
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

  const zeroAgent = db.getAgentBySlug('0-error')!;
  const fpAgent = db.getAgentBySlug('foul-play')!;
  const mmAgent = db.getAgentBySlug('metamon')!;
  const mtAgent = db.getAgentBySlug('mews-truck')!;
  const mnAgent = db.getAgentBySlug('missingnozero')!;
  const xzAgent = db.getAgentBySlug('xatu-zero')!;
  const jaxAgent = db.getAgentBySlug('jaxcalibur')!;
  const eeveAgent = db.getAgentBySlug('eevenator')!;
  const awrAgent = db.getAgentBySlug('awrorus')!;
  const windAgent = db.getAgentBySlug('mysteriouswind')!;
  const prAgent = db.getAgentBySlug('pokerus')!;
  const mikuAgent = db.getAgentBySlug('mikumiku')!;
  const scheiboDev = db.getDeveloperByGitHub('scheibo')!;

  const ALL_LADDERS = [
    'gen1ou20261109',
    'gen3ou20261109',
    'gen9ou20261109',
    'gen9randombattle20261109',
    'gen9championsvgc2026regmc',
  ];

  const vgcPoolInputs: Array<{agentId: number; agentName: string; teams: string[]}> = [];
  const agentIdByVersion = new Map<number, number>();

  const submitAndPass = (input: {
    agentId: number;
    developerId?: number;
    version: string;
    pkg: 'bundle' | 'oci';
    url: string;
    ladders: string[];
    tournaments?: string[];
    vgcOffset?: number;
    at: number;
    bytes: number;
    durationMillis: number;
    turnMillis: number;
    ram: number;
    retiredByLadder?: Record<string, number>;
  }) => {
    const vgcTeams =
      input.vgcOffset !== undefined && input.ladders.includes('gen9championsvgc2026regmc')
        ? splitSubmittedTeams(generateValidVgcTeams(20, input.vgcOffset))
        : undefined;
    const teamsByLadder = vgcTeams ? {gen9championsvgc2026regmc: vgcTeams} : undefined;
    const v = db.createSubmission({
      agentId: input.agentId,
      developerId: input.developerId,
      version: input.version,
      package: input.pkg,
      url: input.url,
      sha256: shaOf(`${input.agentId}-${input.version}`),
      ladderIds: input.ladders,
      tournamentIds: input.tournaments,
      teamsByLadder,
      now: input.at,
    });
    db.applySubmissionStatus({
      versionId: v.id,
      smokeStatus: 'passed',
      unpackedBytes: input.bytes,
      smokeDurationMillis: input.durationMillis,
      smokeTurnMillis: input.turnMillis,
      smokePeakRam: input.ram,
      retiredVersionIdsByLadder: input.retiredByLadder,
      now: input.at + 5,
    });
    agentIdByVersion.set(v.id, input.agentId);
    if (vgcTeams) {
      const agent = db.getAgentById(input.agentId);
      vgcPoolInputs.push({
        agentId: input.agentId,
        agentName: agent?.name ?? String(input.agentId),
        teams: vgcTeams,
      });
    }
    return v;
  };

  // Historical failed smoke test on 0 ERROR (`notified = true`) for `/account/` History table
  const zeroFail = db.createSubmission({
    agentId: zeroAgent.id,
    developerId: scheiboDev.id,
    version: '0.9.0-rc1',
    package: 'bundle',
    url: 'https://r2.pkmn.cc/0-error-0.9.0-rc1.tar.zst',
    sha256: shaOf('0-error-0.9.0-rc1'),
    ladderIds: ['gen1ou20261109', 'gen9ou20261109'],
    now: now - 28 * 86400,
  });
  db.applySubmissionStatus({
    versionId: zeroFail.id,
    smokeStatus: 'failed',
    smokeError:
      'Error: invalid choice on turn 1 ("move 5")\n  at SearchAgent.choose (src/agent.zig:142)',
    now: now - 28 * 86400 + 8,
  });
  db.markVersionNotified(zeroFail.id);

  // Initial cohort across all 5 ladders so every ladder has 10 settled + 1 provisional agents
  const zV100 = submitAndPass({
    agentId: zeroAgent.id,
    developerId: scheiboDev.id,
    version: '1.0.0',
    pkg: 'bundle',
    url: 'https://r2.pkmn.cc/0-error-1.0.0.tar.zst',
    ladders: ALL_LADDERS,
    vgcOffset: 0,
    at: now - 27 * 86400,
    bytes: 184 * 1024 * 1024,
    durationMillis: 2400,
    turnMillis: 310,
    ram: 820,
  });
  const fpV1 = submitAndPass({
    agentId: fpAgent.id,
    version: '1.4.0',
    pkg: 'bundle',
    url: 'https://r2.pkmn.cc/foul-play-1.4.0.tar.zst',
    ladders: ALL_LADDERS,
    vgcOffset: 1,
    at: now - 27 * 86400 + 30,
    bytes: 142 * 1024 * 1024,
    durationMillis: 1900,
    turnMillis: 260,
    ram: 640,
  });
  const mmV1 = submitAndPass({
    agentId: mmAgent.id,
    version: '1.0.0',
    pkg: 'oci',
    url: 'ghcr.io/ut-austin-rpl/metamon:1.0.0',
    ladders: ['gen1ou20261109', 'gen3ou20261109', 'gen9ou20261109'],
    at: now - 27 * 86400 + 60,
    bytes: 412 * 1024 * 1024,
    durationMillis: 4200,
    turnMillis: 480,
    ram: 2150,
  });
  const mtV1 = submitAndPass({
    agentId: mtAgent.id,
    version: '1.0.0',
    pkg: 'bundle',
    url: 'https://r2.pkmn.cc/mews-truck-1.0.0.tar.zst',
    ladders: ['gen9ou20261109', 'gen9randombattle20261109', 'gen9championsvgc2026regmc'],
    vgcOffset: 2,
    at: now - 27 * 86400 + 90,
    bytes: 298 * 1024 * 1024,
    durationMillis: 3100,
    turnMillis: 390,
    ram: 1580,
  });
  const mnV1 = submitAndPass({
    agentId: mnAgent.id,
    version: '2.1.0',
    pkg: 'bundle',
    url: 'https://r2.pkmn.cc/missingno-zero-2.1.0.tar.zst',
    ladders: [
      'gen1ou20261109',
      'gen3ou20261109',
      'gen9randombattle20261109',
      'gen9championsvgc2026regmc',
    ],
    vgcOffset: 3,
    at: now - 27 * 86400 + 120,
    bytes: 210 * 1024 * 1024,
    durationMillis: 2700,
    turnMillis: 340,
    ram: 980,
  });
  const xzV1 = submitAndPass({
    agentId: xzAgent.id,
    version: '0.8.0',
    pkg: 'oci',
    url: 'ghcr.io/xatu/xatu-zero:0.8.0',
    ladders: ALL_LADDERS,
    vgcOffset: 4,
    at: now - 27 * 86400 + 150,
    bytes: 356 * 1024 * 1024,
    durationMillis: 3800,
    turnMillis: 440,
    ram: 1840,
  });
  const jaxV1 = submitAndPass({
    agentId: jaxAgent.id,
    version: '1.3.0',
    pkg: 'oci',
    url: 'ghcr.io/jaxcalibur/agent:1.3.0',
    ladders: ALL_LADDERS,
    vgcOffset: 5,
    at: now - 27 * 86400 + 180,
    bytes: 390 * 1024 * 1024,
    durationMillis: 3400,
    turnMillis: 350,
    ram: 1920,
  });
  const eeveV1 = submitAndPass({
    agentId: eeveAgent.id,
    version: '0.6.2',
    pkg: 'bundle',
    url: 'https://r2.pkmn.cc/eevenator-0.6.2.tar.zst',
    ladders: ALL_LADDERS,
    vgcOffset: 6,
    at: now - 27 * 86400 + 210,
    bytes: 96 * 1024 * 1024,
    durationMillis: 1500,
    turnMillis: 210,
    ram: 520,
  });
  const awrV1 = submitAndPass({
    agentId: awrAgent.id,
    version: '1.1.0',
    pkg: 'oci',
    url: 'ghcr.io/awrorus/agent:1.1.0',
    ladders: ALL_LADDERS,
    vgcOffset: 7,
    at: now - 27 * 86400 + 240,
    bytes: 320 * 1024 * 1024,
    durationMillis: 3100,
    turnMillis: 410,
    ram: 1640,
  });
  const windV1 = submitAndPass({
    agentId: windAgent.id,
    version: '0.4.0',
    pkg: 'bundle',
    url: 'https://r2.pkmn.cc/mysteriouswind-0.4.0.tar.zst',
    ladders: ALL_LADDERS,
    vgcOffset: 8,
    at: now - 27 * 86400 + 270,
    bytes: 128 * 1024 * 1024,
    durationMillis: 1850,
    turnMillis: 295,
    ram: 710,
  });
  const prV1 = submitAndPass({
    agentId: prAgent.id,
    version: '1.0.2',
    pkg: 'bundle',
    url: 'https://r2.pkmn.cc/pokerus-1.0.2.tar.zst',
    ladders: ALL_LADDERS,
    vgcOffset: 9,
    at: now - 27 * 86400 + 300,
    bytes: 152 * 1024 * 1024,
    durationMillis: 2050,
    turnMillis: 330,
    ram: 780,
  });
  const mikuV1 = submitAndPass({
    agentId: mikuAgent.id,
    version: '0.9.1',
    pkg: 'bundle',
    url: 'https://r2.pkmn.cc/mikumiku-0.9.1.tar.zst',
    ladders: ALL_LADDERS,
    vgcOffset: 10,
    at: now - 27 * 86400 + 330,
    bytes: 168 * 1024 * 1024,
    durationMillis: 2250,
    turnMillis: 365,
    ram: 840,
  });

  // Designate 1500 Elo anchors per ladder
  db.setLadderAnchor('gen1ou20261109', 'metamon', '1.0.0', now - 26 * 86400 + 10);
  db.setLadderAnchor('gen3ou20261109', 'foul-play', '1.4.0', now - 26 * 86400 + 10);
  db.setLadderAnchor('gen9ou20261109', 'foul-play', '1.4.0', now - 26 * 86400 + 10);
  db.setLadderAnchor('gen9randombattle20261109', 'foul-play', '1.4.0', now - 26 * 86400 + 10);
  db.setLadderAnchor('gen9championsvgc2026regmc', 'foul-play', '1.4.0', now - 26 * 86400 + 10);

  const vgcPool = buildCanonicalTeamPool(vgcPoolInputs);
  const rng = createRng(20261110);
  let matchSeq = 0;

  const playSimulatedMatch = (input: {
    ladderId: string;
    prefix: string;
    p1VersionId: number;
    p2VersionId: number;
    pWin: number;
    allowTies?: boolean;
    completedAt: number;
    p1TeamLabel?: string;
    p2TeamLabel?: string;
    game1EndReason?: string;
    game2EndReason?: string;
  }): string => {
    matchSeq++;
    const matchId = `${input.prefix}-${String(matchSeq).padStart(7, '0')}`;
    const sampleGame = (): {outcome: ratings.GameOutcome; reason: string; turns: number} => {
      const roll = rng(1000) / 1000;
      if (input.allowTies && roll > 0.965) {
        return {outcome: 'T', reason: 'tie_100_turns', turns: 100};
      }
      const adjusted = input.allowTies ? roll / 0.965 : roll;
      return {
        outcome: adjusted < input.pWin ? 'W' : 'L',
        reason: 'win',
        turns: 20 + rng(28),
      };
    };
    const g1 = sampleGame();
    const g2 = sampleGame();
    const cat = `${g1.outcome}${g2.outcome}` as ratings.MatchCategory;

    let p1TeamLabel = input.p1TeamLabel;
    let p2TeamLabel = input.p2TeamLabel;
    if (
      input.ladderId === 'gen9championsvgc2026regmc' &&
      p1TeamLabel === undefined &&
      p2TeamLabel === undefined
    ) {
      const a1 = agentIdByVersion.get(input.p1VersionId);
      const a2 = agentIdByVersion.get(input.p2VersionId);
      if (a1 !== undefined && a2 !== undefined) {
        const sampled = samplePoolsPair(vgcPool, a1, a2, rng);
        p1TeamLabel = sampled.t1Label;
        p2TeamLabel = sampled.t2Label;
      }
    }

    db.recordCompletedMatch({
      match: {
        id: matchId,
        ladderId: input.ladderId,
        p1VersionId: input.p1VersionId,
        p2VersionId: input.p2VersionId,
        seed: `100,200,300,${matchSeq}`,
        p1TeamLabel,
        p2TeamLabel,
        game1Outcome: g1.outcome,
        game2Outcome: g2.outcome,
        category: cat,
        game1Turns: g1.turns,
        game2Turns: g2.turns,
        game1EndReason: input.game1EndReason ?? g1.reason,
        game2EndReason: input.game2EndReason ?? g2.reason,
        p1PeakRam: 720 + (input.p1VersionId * 47) % 980,
        p2PeakRam: 720 + (input.p2VersionId * 53) % 980,
        p1Game1BankSeconds: 95 + rng(55),
        p1Game2BankSeconds: 90 + rng(55),
        p2Game1BankSeconds: 92 + rng(55),
        p2Game2BankSeconds: 88 + rng(55),
        p1MeanTurnMillis: 230 + (input.p1VersionId * 29) % 240,
        p2MeanTurnMillis: 240 + (input.p2VersionId * 31) % 240,
        completedAt: input.completedAt,
      },
    });
    return matchId;
  };

  interface CompetitorSpec {
    versionId: number;
    name: string;
    skill: number;
  }

  // Interleaved round-robin generator across `rounds` cycles spanned over `[startAt, endAt]`
  // so every UTC day records rating snapshots for the Top 5 chart and every pair in the 10x10
  // matrix accumulates realistic WW / WT / split / TL / LL counts.
  const runRoundRobin = (config: {
    ladderId: string;
    prefix: string;
    competitors: CompetitorSpec[];
    rounds: number;
    startAt: number;
    endAt: number;
    allowTies?: boolean;
    matchupTweaks?: Map<string, number>;
  }) => {
    const pairs: Array<[CompetitorSpec, CompetitorSpec]> = [];
    for (let i = 0; i < config.competitors.length; i++) {
      for (let j = i + 1; j < config.competitors.length; j++) {
        pairs.push([config.competitors[i], config.competitors[j]]);
      }
    }
    const totalMatches = pairs.length * config.rounds;
    const span = Math.max(config.endAt - config.startAt, totalMatches);
    let idx = 0;
    for (let r = 0; r < config.rounds; r++) {
      for (const [c1, c2] of pairs) {
        const at = config.startAt + Math.floor((idx * span) / totalMatches);
        idx++;
        const tweak =
          config.matchupTweaks?.get(`${c1.versionId}:${c2.versionId}`) ??
          -(config.matchupTweaks?.get(`${c2.versionId}:${c1.versionId}`) ?? 0);
        const diff = c1.skill - c2.skill + tweak;
        const pWin = 1 / (1 + Math.exp(-diff));
        playSimulatedMatch({
          ladderId: config.ladderId,
          prefix: config.prefix,
          p1VersionId: c1.versionId,
          p2VersionId: c2.versionId,
          pWin,
          allowTies: config.allowTies,
          completedAt: at,
        });
      }
    }
  };

  // 1. Settle initial cohort (Days -25 .. -13) across all 5 ladders (10 settled per ladder)
  runRoundRobin({
    ladderId: 'gen1ou20261109',
    prefix: 'gen1ou',
    competitors: [
      {versionId: jaxV1.id, name: 'Jaxcalibur', skill: 1.05},
      {versionId: zV100.id, name: '0 ERROR', skill: 0.85},
      {versionId: mnV1.id, name: 'MissingNo.Zero', skill: 0.72},
      {versionId: xzV1.id, name: 'Xatu Zero', skill: 0.48},
      {versionId: eeveV1.id, name: 'eevenator', skill: 0.25},
      {versionId: mmV1.id, name: 'Metamon', skill: 0.0},
      {versionId: fpV1.id, name: 'Foul Play', skill: -0.22},
      {versionId: awrV1.id, name: 'AWRorus', skill: -0.52},
      {versionId: windV1.id, name: 'MysteriousWind', skill: -0.82},
      {versionId: mikuV1.id, name: 'mikumiku', skill: -1.15},
    ],
    rounds: 10,
    startAt: now - 25 * 86400,
    endAt: now - 13 * 86400,
    allowTies: true,
  });

  runRoundRobin({
    ladderId: 'gen3ou20261109',
    prefix: 'gen3ou',
    competitors: [
      {versionId: jaxV1.id, name: 'Jaxcalibur', skill: 1.25},
      {versionId: mmV1.id, name: 'Metamon', skill: 0.95},
      {versionId: zV100.id, name: '0 ERROR', skill: 0.68},
      {versionId: xzV1.id, name: 'Xatu Zero', skill: 0.42},
      {versionId: eeveV1.id, name: 'eevenator', skill: 0.18},
      {versionId: fpV1.id, name: 'Foul Play', skill: 0.0},
      {versionId: mnV1.id, name: 'MissingNo.Zero', skill: -0.28},
      {versionId: awrV1.id, name: 'AWRorus', skill: -0.58},
      {versionId: windV1.id, name: 'MysteriousWind', skill: -0.88},
      {versionId: prV1.id, name: 'pokerus', skill: -1.18},
    ],
    rounds: 10,
    startAt: now - 25 * 86400,
    endAt: now - 1 * 86400,
    allowTies: true,
  });

  runRoundRobin({
    ladderId: 'gen9ou20261109',
    prefix: 'gen9ou',
    competitors: [
      {versionId: mtV1.id, name: "Mew's Truck", skill: 1.10},
      {versionId: zV100.id, name: '0 ERROR', skill: 0.82},
      {versionId: jaxV1.id, name: 'Jaxcalibur', skill: 0.64},
      {versionId: xzV1.id, name: 'Xatu Zero', skill: 0.38},
      {versionId: eeveV1.id, name: 'eevenator', skill: 0.16},
      {versionId: fpV1.id, name: 'Foul Play', skill: 0.0},
      {versionId: mmV1.id, name: 'Metamon', skill: -0.24},
      {versionId: awrV1.id, name: 'AWRorus', skill: -0.55},
      {versionId: windV1.id, name: 'MysteriousWind', skill: -0.86},
      {versionId: mikuV1.id, name: 'mikumiku', skill: -1.18},
    ],
    rounds: 10,
    startAt: now - 25 * 86400,
    endAt: now - 13 * 86400,
    allowTies: true,
  });

  runRoundRobin({
    ladderId: 'gen9randombattle20261109',
    prefix: 'gen9rand',
    competitors: [
      {versionId: mnV1.id, name: 'MissingNo.Zero', skill: 1.28},
      {versionId: zV100.id, name: '0 ERROR', skill: 0.92},
      {versionId: jaxV1.id, name: 'Jaxcalibur', skill: 0.65},
      {versionId: mtV1.id, name: "Mew's Truck", skill: 0.40},
      {versionId: eeveV1.id, name: 'eevenator', skill: 0.18},
      {versionId: fpV1.id, name: 'Foul Play', skill: 0.0},
      {versionId: xzV1.id, name: 'Xatu Zero', skill: -0.26},
      {versionId: awrV1.id, name: 'AWRorus', skill: -0.56},
      {versionId: windV1.id, name: 'MysteriousWind', skill: -0.85},
      {versionId: prV1.id, name: 'pokerus', skill: -1.16},
    ],
    rounds: 10,
    startAt: now - 25 * 86400,
    endAt: now - 1 * 86400,
  });

  runRoundRobin({
    ladderId: 'gen9championsvgc2026regmc',
    prefix: 'vgc',
    competitors: [
      {versionId: mtV1.id, name: "Mew's Truck", skill: 1.35},
      {versionId: zV100.id, name: '0 ERROR', skill: 0.98},
      {versionId: jaxV1.id, name: 'Jaxcalibur', skill: 0.72},
      {versionId: mnV1.id, name: 'MissingNo.Zero', skill: 0.45},
      {versionId: eeveV1.id, name: 'eevenator', skill: 0.22},
      {versionId: fpV1.id, name: 'Foul Play', skill: 0.0},
      {versionId: xzV1.id, name: 'Xatu Zero', skill: -0.28},
      {versionId: awrV1.id, name: 'AWRorus', skill: -0.58},
      {versionId: windV1.id, name: 'MysteriousWind', skill: -0.88},
      {versionId: prV1.id, name: 'pokerus', skill: -1.20},
    ],
    rounds: 10,
    startAt: now - 25 * 86400,
    endAt: now - 1 * 86400,
  });

  // 2. Upgrade 0 ERROR -> 1.1.0 (Day -12) -> 1.2.0 (Day -4, retiring 1.0.0 on RBY & SV)
  const zV110 = submitAndPass({
    agentId: zeroAgent.id,
    developerId: scheiboDev.id,
    version: '1.1.0',
    pkg: 'bundle',
    url: 'https://r2.pkmn.cc/0-error-1.1.0.tar.zst',
    ladders: ['gen1ou20261109', 'gen9ou20261109'],
    at: now - 12 * 86400,
    bytes: 192 * 1024 * 1024,
    durationMillis: 2200,
    turnMillis: 295,
    ram: 860,
  });

  for (const [oppId, pWin] of [
    [jaxV1.id, 0.56], [mnV1.id, 0.62], [xzV1.id, 0.66],
    [eeveV1.id, 0.72], [mmV1.id, 0.76], [fpV1.id, 0.80],
  ] as const) {
    for (let k = 0; k < 15; k++) {
      playSimulatedMatch({
        ladderId: 'gen1ou20261109',
        prefix: 'gen1ou',
        p1VersionId: zV110.id,
        p2VersionId: oppId,
        pWin,
        allowTies: true,
        completedAt: now - 11 * 86400 + k * 5400,
      });
    }
  }
  for (const [oppId, pWin] of [
    [mtV1.id, 0.54], [jaxV1.id, 0.64], [xzV1.id, 0.68],
    [eeveV1.id, 0.74], [fpV1.id, 0.78], [mmV1.id, 0.82],
  ] as const) {
    for (let k = 0; k < 15; k++) {
      playSimulatedMatch({
        ladderId: 'gen9ou20261109',
        prefix: 'gen9ou',
        p1VersionId: zV110.id,
        p2VersionId: oppId,
        pWin,
        allowTies: true,
        completedAt: now - 11 * 86400 + k * 5400,
      });
    }
  }

  db.refundCooldown('0-error', now - 5 * 86400);
  const zV120 = submitAndPass({
    agentId: zeroAgent.id,
    developerId: scheiboDev.id,
    version: '1.2.0',
    pkg: 'bundle',
    url: 'https://r2.pkmn.cc/0-error-1.2.0.tar.zst',
    ladders: ['gen1ou20261109', 'gen9ou20261109'],
    at: now - 4 * 86400,
    bytes: 198 * 1024 * 1024,
    durationMillis: 2100,
    turnMillis: 280,
    ram: 890,
    retiredByLadder: {
      gen1ou20261109: zV100.id,
      gen9ou20261109: zV100.id,
    },
  });

  // Play >= 10 matches against rivals for 0 ERROR 1.2.0 on RBY (including stylistic H2H residuals:
  // dominates Jaxcalibur as Best Matchup, drops extra games to Xatu Zero as Nemesis) and SV.
  const rbyV120Schedule: Array<[number, number, number]> = [
    [jaxV1.id, 12, 0.90], // Best Matchup (positive residual above Elo expectation)
    [mnV1.id, 10, 0.80],
    [xzV1.id, 12, 0.50], // Nemesis (negative residual below Elo expectation)
    [eeveV1.id, 8, 0.86],
    [mmV1.id, 8, 0.88],
    [fpV1.id, 8, 0.90],
    [awrV1.id, 6, 0.92],
    [windV1.id, 6, 0.94],
    [mikuV1.id, 6, 0.96],
  ];
  let stepIdx = 0;
  for (const [oppId, count, pWin] of rbyV120Schedule) {
    for (let k = 0; k < count; k++) {
      stepIdx++;
      playSimulatedMatch({
        ladderId: 'gen1ou20261109',
        prefix: 'gen1ou',
        p1VersionId: zV120.id,
        p2VersionId: oppId,
        pWin,
        allowTies: true,
        completedAt: now - 4 * 86400 + stepIdx * 3600,
      });
    }
  }

  stepIdx = 0;
  for (const [oppId, count, pWin] of [
    [mtV1.id, 12, 0.78],
    [jaxV1.id, 10, 0.84],
    [xzV1.id, 10, 0.54],
    [eeveV1.id, 8, 0.86],
    [fpV1.id, 8, 0.88],
    [mmV1.id, 6, 0.90],
    [awrV1.id, 6, 0.92],
    [windV1.id, 6, 0.95],
  ] as const) {
    for (let k = 0; k < count; k++) {
      stepIdx++;
      playSimulatedMatch({
        ladderId: 'gen9ou20261109',
        prefix: 'gen9ou',
        p1VersionId: zV120.id,
        p2VersionId: oppId,
        pWin,
        allowTies: true,
        completedAt: now - 4 * 86400 + stepIdx * 3800,
      });
    }
  }

  // 3. Provisional entrants (< 10 matches) + crisp closing streaks (`W5`, `L4`) per ladder
  for (let k = 0; k < 5; k++) {
    playSimulatedMatch({
      ladderId: 'gen1ou20261109',
      prefix: 'gen1ou',
      p1VersionId: prV1.id,
      p2VersionId: fpV1.id,
      pWin: 0.5,
      completedAt: now - 7200 + k * 300,
    });
    playSimulatedMatch({
      ladderId: 'gen3ou20261109',
      prefix: 'gen3ou',
      p1VersionId: mikuV1.id,
      p2VersionId: fpV1.id,
      pWin: 0.5,
      completedAt: now - 7200 + k * 300,
    });
    playSimulatedMatch({
      ladderId: 'gen9ou20261109',
      prefix: 'gen9ou',
      p1VersionId: prV1.id,
      p2VersionId: fpV1.id,
      pWin: 0.5,
      completedAt: now - 7200 + k * 300,
    });
    playSimulatedMatch({
      ladderId: 'gen9randombattle20261109',
      prefix: 'gen9rand',
      p1VersionId: mikuV1.id,
      p2VersionId: fpV1.id,
      pWin: 0.5,
      completedAt: now - 7200 + k * 300,
    });
    playSimulatedMatch({
      ladderId: 'gen9championsvgc2026regmc',
      prefix: 'vgc',
      p1VersionId: mikuV1.id,
      p2VersionId: fpV1.id,
      pWin: 0.5,
      completedAt: now - 7200 + k * 300,
    });
  }

  // Guarantee visible hot/cold streak badges (`W4`, `L4`) at the top and bottom of RBY & VGC
  for (let k = 0; k < 4; k++) {
    playSimulatedMatch({
      ladderId: 'gen1ou20261109',
      prefix: 'gen1ou',
      p1VersionId: zV120.id,
      p2VersionId: mikuV1.id,
      pWin: 1.0,
      completedAt: now - 1200 + k * 120,
    });
    playSimulatedMatch({
      ladderId: 'gen9championsvgc2026regmc',
      prefix: 'vgc',
      p1VersionId: mtV1.id,
      p2VersionId: prV1.id,
      pWin: 1.0,
      completedAt: now - 1140 + k * 120,
    });
  }

  // Include recent abnormal-termination examples (`crash`, `timeout`) and a deterministic
  // VGC pool-hash battle (`unknown` third-party team + `P1:`-owned team) at the top of `/battles/`.
  playSimulatedMatch({
    ladderId: 'gen9ou20261109',
    prefix: 'gen9ou',
    p1VersionId: eeveV1.id,
    p2VersionId: awrV1.id,
    pWin: 1.0,
    completedAt: now - 300,
    game2EndReason: 'crash',
  });
  const zeroTeamEntry = vgcPool.find(e => e.owners.has(zeroAgent.id))!;
  const jaxTeamEntry = vgcPool.find(e => e.owners.has(jaxAgent.id))!;
  const mtTeamEntry = vgcPool.find(e => e.owners.has(mtAgent.id))!;
  const featuredBattleId = playSimulatedMatch({
    ladderId: 'gen9championsvgc2026regmc',
    prefix: 'vgc',
    p1VersionId: jaxV1.id,
    p2VersionId: mnV1.id,
    pWin: 1.0,
    completedAt: now - 180,
    p1TeamLabel: hashTeam(zeroTeamEntry.canonicalPacked),
    p2TeamLabel: formatPoolTeamLabel(jaxTeamEntry.canonicalPacked, 'P1'),
    game2EndReason: 'timeout',
  });

  // 4. Tournaments:
  //   #1 Completed ("Tournament #1: Gen 9 OU", 6 entrants)
  //   #2 Running   ("Tournament #2: VGC 2026 Reg M-C OTS BO3", 6 entrants -> site-wide #topbar)
  //   #3 Scheduled ("Tournament #3: VGC 2026 Reg M-D OTS BO3", open for /account OCI registration)
  db.upsertTournament({
    id: '1',
    name: 'Tournament #1: Gen 9 OU',
    format: 'gen9ou',
    gamesPerMatchup: 8,
    parallelTables: 2,
    hardware: 'GCP L4 Spot · 24 vCPU · 48 GB RAM',
    status: 'completed',
    startsAt: now - 90 * 86400,
    completedAt: now - 88 * 86400,
  });
  const springEntrants = [
    {
      agent: mtAgent.id, ver: mtV1.id, seed: 1, rank: 1,
      elo: 1712, se: 22, w: 31, l: 7, t: 2, pts: 32, sb: 584.5,
    },
    {
      agent: zeroAgent.id, ver: zV100.id, seed: 2, rank: 2,
      elo: 1668, se: 23, w: 27, l: 11, t: 2, pts: 28, sb: 492.0,
    },
    {
      agent: jaxAgent.id, ver: jaxV1.id, seed: 3, rank: 3,
      elo: 1614, se: 24, w: 23, l: 15, t: 2, pts: 24, sb: 410.5,
    },
    {
      agent: xzAgent.id, ver: xzV1.id, seed: 4, rank: 4,
      elo: 1548, se: 24, w: 18, l: 20, t: 2, pts: 19, sb: 318.0,
    },
    {
      agent: fpAgent.id, ver: fpV1.id, seed: 5, rank: 5,
      elo: 1492, se: 25, w: 13, l: 25, t: 2, pts: 14, sb: 226.5,
    },
    {
      agent: mmAgent.id, ver: mmV1.id, seed: 6, rank: 6,
      elo: 1418, se: 26, w: 6, l: 32, t: 2, pts: 7, sb: 112.0,
    },
  ];
  for (const ent of springEntrants) {
    db.upsertTournamentEntrant({
      tournamentId: '1',
      agentId: ent.agent,
      versionId: ent.ver,
      seed: ent.seed,
      finalRank: ent.rank,
      elo: ent.elo,
      se: ent.se,
      gameWins: ent.w,
      gameLosses: ent.l,
      gameTies: ent.t,
      points: ent.pts,
      sonnebornBerger: ent.sb,
    });
  }
  const packedSix = (names: string[]) => names.map(n => `|${n}`).join(']');
  const ouTeams = [
    packedSix([
      'Great Tusk', 'Kingambit', 'Gholdengo', 'Dragapult', 'Ogerpon-Wellspring', 'Gliscor',
    ]),
    packedSix([
      'Zamazenta', 'Darkrai', 'Ting-Lu', 'Raging Bolt', 'Hatterene', 'Samurott-Hisui',
    ]),
    packedSix([
      'Dragapult', 'Kingambit', 'Great Tusk', 'Slowking-Galar', 'Corviknight', 'Kyurem',
    ]),
    packedSix([
      'Gliscor', 'Gholdengo', 'Ting-Lu', 'Iron Valiant', 'Cinderace', 'Primarina',
    ]),
  ];
  let springGameSeq = 0;
  for (let i = 0; i < springEntrants.length; i++) {
    for (let j = i + 1; j < springEntrants.length; j++) {
      for (let g = 1; g <= 4; g++) {
        springGameSeq++;
        const outcome: 'W' | 'L' | 'T' = g === 4 && (i + j) % 3 === 0 ? 'L' : 'W';
        db.upsertTournamentGame({
          id: `spring26-rr-${springGameSeq}`,
          tournamentId: '1',
          stage: 'Round Robin',
          cycle: g,
          matchupGame: g,
          p1VersionId: springEntrants[i].ver,
          p2VersionId: springEntrants[j].ver,
          seed: `10,20,30,${springGameSeq}`,
          p1Team: ouTeams[(i + g) % ouTeams.length],
          p2Team: ouTeams[(j + g + 1) % ouTeams.length],
          outcome,
          endReason: 'win',
          turns: 26 + ((springGameSeq * 5) % 24),
          p1BankSeconds: 70 + (springGameSeq % 40),
          p2BankSeconds: 55 + ((springGameSeq * 3) % 40),
          status: 'completed',
          completedAt: now - 89 * 86400 + springGameSeq * 300,
        });
      }
    }
  }
  db.upsertTournamentGame({
    id: 'spring26-sf1',
    tournamentId: '1',
    stage: 'Superfinal',
    cycle: 1,
    matchupGame: 1,
    p1VersionId: mtV1.id,
    p2VersionId: zV100.id,
    seed: '10,20,30,999',
    p1Team: ouTeams[0],
    p2Team: ouTeams[1],
    outcome: 'W',
    endReason: 'win',
    turns: 34,
    p1BankSeconds: 88,
    p2BankSeconds: 64,
    status: 'completed',
    completedAt: now - 88 * 86400 - 300,
  });

  db.upsertTournament({
    id: '2',
    name: 'Tournament #2: VGC 2026 Reg M-C OTS BO3',
    format: 'gen9championsvgc2026regmc',
    gamesPerMatchup: 8,
    parallelTables: 2,
    hardware: 'GCP L4 Spot · 24 vCPU · 48 GB RAM',
    status: 'running',
    startsAt: now - 7200,
  });
  const autumnEntrants = [
    {agent: zeroAgent.id, ver: zV120.id, seed: 1, elo: 1664, se: 36, w: 12, l: 3, pts: 12, sb: 64},
    {agent: mtAgent.id, ver: mtV1.id, seed: 2, elo: 1648, se: 37, w: 11, l: 4, pts: 11, sb: 58},
    {agent: jaxAgent.id, ver: jaxV1.id, seed: 3, elo: 1582, se: 38, w: 9, l: 6, pts: 9, sb: 44},
    {agent: mnAgent.id, ver: mnV1.id, seed: 4, elo: 1528, se: 39, w: 7, l: 8, pts: 7, sb: 32},
    {agent: eeveAgent.id, ver: eeveV1.id, seed: 5, elo: 1476, se: 40, w: 4, l: 11, pts: 4, sb: 18},
    {agent: fpAgent.id, ver: fpV1.id, seed: 6, elo: 1422, se: 42, w: 2, l: 13, pts: 2, sb: 9},
  ];
  for (const ent of autumnEntrants) {
    db.upsertTournamentEntrant({
      tournamentId: '2',
      agentId: ent.agent,
      versionId: ent.ver,
      seed: ent.seed,
      elo: ent.elo,
      se: ent.se,
      gameWins: ent.w,
      gameLosses: ent.l,
      gameTies: 0,
      points: ent.pts,
      sonnebornBerger: ent.sb,
    });
  }
  const vgcPackedTeams = [
    packedSix(['Incineroar', 'Rillaboom', 'Archaludon', 'Pelipper', 'Basculegion', 'Farigiraf']),
    packedSix(['Garchomp', 'Talonflame', 'Gholdengo', 'Kingambit', 'Amoonguss', 'Sneasler']),
    packedSix(['Dragonite', 'Arcanine-Hisui', 'Politoed', 'Grimmsnarl', 'Sylveon', 'Metagross']),
  ];
  let autumnGameSeq = 0;
  for (let i = 0; i < autumnEntrants.length; i++) {
    for (let j = i + 1; j < autumnEntrants.length; j++) {
      for (let g = 1; g <= 3; g++) {
        autumnGameSeq++;
        db.upsertTournamentGame({
          id: `autumn26-rr-${autumnGameSeq}`,
          tournamentId: '2',
          stage: 'Round Robin',
          cycle: g,
          matchupGame: g,
          p1VersionId: autumnEntrants[i].ver,
          p2VersionId: autumnEntrants[j].ver,
          seed: `40,50,60,${autumnGameSeq}`,
          p1Team: vgcPackedTeams[(i + g) % vgcPackedTeams.length],
          p2Team: vgcPackedTeams[(j + g + 1) % vgcPackedTeams.length],
          outcome: g === 2 && (i + j) % 2 === 1 ? 'L' : 'W',
          endReason: 'win',
          turns: 8 + (autumnGameSeq % 9),
          p1BankSeconds: 96 + (autumnGameSeq % 30),
          p2BankSeconds: 82 + ((autumnGameSeq * 2) % 30),
          status: 'completed',
          completedAt: now - 6800 + autumnGameSeq * 120,
        });
      }
    }
  }

  db.upsertTournament({
    id: '3',
    name: 'Tournament #3: VGC 2026 Reg M-D OTS BO3',
    format: 'gen9championsvgc2026regmc',
    gamesPerMatchup: 8,
    parallelTables: 2,
    hardware: 'GCP L4 Spot · 24 vCPU · 48 GB RAM',
    status: 'scheduled',
    startsAt: now + 14 * 86400,
  });
  const pmarigliaDev = db.getDeveloperByGitHub('pmariglia')!;
  submitAndPass({
    agentId: fpAgent.id,
    developerId: pmarigliaDev.id,
    version: '1.4.1-t3',
    pkg: 'oci',
    url: 'ghcr.io/pmariglia/foul-play:1.4.1-t3',
    ladders: [],
    tournaments: ['3'],
    at: now - 3600,
    bytes: 264 * 1024 * 1024,
    durationMillis: 2300,
    turnMillis: 270,
    ram: 710,
  });

  const liveMatch: arena.LiveMatch = {
    heartbeatSeq: 42,
    matchId: 'vgc-0009999',
    ladderId: 'gen9championsvgc2026regmc',
    slot: 'vgc',
    format: 'gen9championsvgc2026regmc',
    game: 2,
    turn: 9,
    activeSlot: 'p2',
    turnStartedAt: now - 4,
    turnBudgetSeconds: 138,
    incrementSeconds: 25,
    game1Summary: {winnerSlot: 'p1', turns: 11},
    p1: {
      slug: '0-error',
      name: '0 ERROR',
      version: '1.0.0',
      bankSeconds: 142,
      lastTurnMillis: 290,
      meanTurnMillis: 280,
      ram: 890,
      team: hashTeam(mtTeamEntry.canonicalPacked),
    },
    p2: {
      slug: 'jaxcalibur',
      name: 'Jaxcalibur',
      version: '1.3.0',
      bankSeconds: 128,
      lastTurnMillis: 340,
      meanTurnMillis: 315,
      ram: 1920,
      team: formatPoolTeamLabel(zeroTeamEntry.canonicalPacked, 'P1'),
    },
  };

  const countsBySlot = db.getMatchCountsBySlot();
  const recentRaw = db.getRecentMatches(50);
  const targetPublic = options.publicDir ?? render.PUBLIC_DIR;
  const liveDoc: arena.LiveDocument = {
    updatedAt: now,
    stale: false,
    live: liveMatch,
    pageSize: 50,
    totalMatches: countsBySlot.all ?? recentRaw.length,
    countsBySlot,
    historyEndpoint: '/api/battles.json',
    recentMatches: recentRaw.map(m => arena.enrichMatchView(targetPublic, m)),
  };

  const tournamentBroadcast: tournaments.LiveBroadcast = {
    tournamentId: '2',
    tables: [
      {label: "Table 1 · 0 ERROR vs Mew's Truck"},
      {label: 'Table 2 · Jaxcalibur vs MissingNo.Zero'},
    ],
    seriesLeftHtml: 'Round Robin · Cycle 4 · Game 4',
    seriesRightHtml: "0 ERROR <code>1.2.0</code> vs Mew's Truck <code>1.0.0</code>",
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
      "|player|p2|Mew's Truck|2",
      '|gametype|doubles',
      '|gen|9',
      '|tier|[Gen 9 Champions] VGC 2026 Reg M-C',
      '|turn|1',
    ],
    live: true,
  };

  if (options.render !== false && options.publicDir) {
    const t1Dir = path.join(options.publicDir, 'arena', 'tournaments', '1');
    fs.mkdirSync(t1Dir, {recursive: true});
    const sf1Log = [
      "|player|p1|Mew's Truck|1",
      '|player|p2|0 ERROR|2',
      '|gametype|singles',
      '|gen|9',
      '|tier|[Gen 9] OU',
      '|poke|p1|Great Tusk|',
      '|poke|p1|Gholdengo|',
      '|poke|p2|Kingambit, M|',
      '|poke|p2|Dragapult, F|',
      '|teampreview',
      "|c|☆Mew's Truck|{\"team 1\":0.685,\"team 2\":0.315}",
      '|c|☆0 ERROR|{"team 1":0.55,"team 2":0.45}',
      '|start',
      '|switch|p1a: Great Tusk|Great Tusk|100/100',
      '|switch|p2a: Dragapult|Dragapult, F|100/100',
      '|turn|1',
      "|c|☆Mew's Truck|{\"move 1\":0.625,\"move 2\":0.25,\"switch 2\":0.125}",
      '|c|☆0 ERROR|{"move 1":0.55,"move 3":0.3,"switch 2":0.15}',
      '|move|p2a: Dragapult|U-turn|p1a: Great Tusk',
      '|-resisted|p1a: Great Tusk',
      '|-damage|p1a: Great Tusk|92/100',
      '|move|p1a: Great Tusk|Knock Off|p2a: Dragapult',
      '|-supereffective|p2a: Dragapult',
      '|-damage|p2a: Dragapult|0 fnt',
      '|faint|p2a: Dragapult',
      "|win|Mew's Truck",
    ].join('\n');
    fs.writeFileSync(path.join(t1Dir, 'spring26-sf1.log'), `${sf1Log}\n`, 'utf8');
    fs.writeFileSync(
      path.join(t1Dir, '1-replays.7z'),
      Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04])
    );

    render.renderArenaPages({
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

  return {liveDoc, tournamentBroadcast, featuredBattleId};
}

interface RemotePendingLadder {
  id: string;
  slot: LadderSlot;
  name: string;
  format: string;
  team: TeamMode;
  min: number;
  teams?: number;
  status: LadderStatus;
}

export interface RemotePendingSubmission {
  versionId: number;
  agentId: number;
  agentSlug: string;
  agentName: string;
  version: string;
  package: 'bundle' | 'oci';
  url: string;
  sha256: string;
  authToken?: string;
  ladders: string[];
  tournaments?: string[];
  teamsByLadder: Record<string, string[]>;
}

interface LocalVersionEntry {
  versionId: number;
  agentId: number;
  agentSlug: string;
  agentName: string;
  version: string;
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
  pairs: Map<string, ratings.PairMatchCounts>;
  teamsByAgent: Map<number, {agentName: string; teams: string[]}>;
  lastMatchNumber: number;
}

export interface SmokeDecision {
  smokeStatus: 'passed' | 'failed' | 'quarantined';
  smokeError?: string;
  unpackedBytes?: number;
  smokeDurationMillis?: number;
  smokeTurnMillis?: number;
  smokePeakRam?: number;
}

export interface ClientOptions {
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
  private readonly getNowSeconds: () => number;
  private readonly decideSmoke: (sub: RemotePendingSubmission) => SmokeDecision;
  private readonly ladders = new Map<string, LocalLadderState>();
  private heartbeatSeq = 0;
  private globalMatchSeq = 0;

  constructor(options: ClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.arenaSecret = options.arenaSecret;
    this.rng = createRng(options.seed ?? 20261110);
    this.getNowSeconds = options.now ?? (() => Math.floor(Date.now() / 1000));
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
    const pairList: ratings.PairMatchCounts[] = [];
    for (const [key, counts] of ladder.pairs) {
      const [lowStr, highStr] = key.split(':');
      const i = indexByVersion.get(Number(lowStr));
      const j = indexByVersion.get(Number(highStr));
      if (i !== undefined && j !== undefined) {
        pairList.push({...counts, i, j});
      }
    }
    const anchorIdx = ladder.entries.findIndex(e => e.isAnchor);
    const res = ratings.computeDavidsonRatings(M, pairList, anchorIdx, 1500);
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

  setAnchor(ladderId: string, agentSlug: string, version: string) {
    const ladder = this.ladders.get(ladderId);
    if (!ladder) return;
    for (const entry of ladder.entries) {
      entry.isAnchor = entry.agentSlug === agentSlug && entry.version === version;
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
          teamsByAgent: new Map(),
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
          const submittedTeams = sub.teamsByLadder[ladderId];
          if (submittedTeams?.length) {
            ladder.teamsByAgent.set(sub.agentId, {
              agentName: sub.agentName,
              teams: submittedTeams,
            });
          }

          this.recomputeLocalLadder(ladder);
          const otherActive = ladder.entries
            .filter(e => e.agentId === sub.agentId && e.active && e.versionId !== sub.versionId)
            .sort((a, b) => a.ratingLcb - b.ratingLcb || a.versionId - b.versionId);

          while (otherActive.length >= 2) {
            const weakest = otherActive.shift()!;
            weakest.active = false;
            retiredByLadder[ladderId] = weakest.versionId;
          }

          if (!ladder.entries.some(e => e.versionId === sub.versionId)) {
            const bias = (((sub.agentId * 31 + sub.versionId * 17) % 11) - 5) * 0.12;
            ladder.entries.push({
              versionId: sub.versionId,
              agentId: sub.agentId,
              agentSlug: sub.agentSlug,
              agentName: sub.agentName,
              version: sub.version,
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
        versionId: sub.versionId,
        smokeStatus: decision.smokeStatus,
        unpackedBytes: decision.unpackedBytes ?? 196 * 1024 * 1024,
        smokeDurationMillis: decision.smokeDurationMillis ?? 2100,
        smokeTurnMillis: decision.smokeTurnMillis ?? 300,
        smokePeakRam: decision.smokePeakRam ?? 840,
        ...(decision.smokeError !== undefined ? {smokeError: decision.smokeError} : {}),
        retiredVersionIdsByLadder: retiredByLadder,
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
      versionId,
      smokeStatus: 'quarantined',
      smokeError: reason,
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
    p1VersionId: number;
    p2VersionId: number;
    p1TeamLabel?: string;
    p2TeamLabel?: string;
    archivedLadder: boolean;
  } | undefined> {
    const candidateStates: ratings.LadderMatchState[] = [];

    for (const [ladderId, ladder] of this.ladders) {
      if (options.ladderId && ladderId !== options.ladderId) continue;
      if (ladder.meta.status !== 'active' && ladder.meta.status !== 'settling') continue;

      const activeEntries = ladder.entries.filter(e => e.active);
      const distinctAgents = new Set(activeEntries.map(e => e.agentId));
      if (distinctAgents.size < ladder.meta.min) continue;

      if (ladder.meta.status === 'settling' && activeEntries.every(e => e.settled)) {
        continue;
      }

      this.recomputeLocalLadder(ladder);
      const M = ladder.entries.length;
      const activeIndices: number[] = [];
      const theta = new Float64Array(M);
      const sigma = new Float64Array(M);
      const agentMatches = new Int32Array(M);
      const pairMatches = new Int32Array(M * M);

      for (let i = 0; i < M; i++) {
        const e = ladder.entries[i];
        if (e.active) activeIndices.push(i);
        theta[i] = (e.ratingElo - 1500) / ratings.ELO_SCALE;
        sigma[i] = e.ratingSe / ratings.ELO_SCALE;
        agentMatches[i] = e.matchesPlayed;
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
        activeAgentIndices: activeIndices,
        theta,
        sigma,
        agentMatches,
        pairMatches,
        lastMatchNumber: ladder.lastMatchNumber,
      });
    }

    if (!candidateStates.length) return undefined;

    const choice = ratings.selectNextArenaMatch(candidateStates, this.globalMatchSeq + 1);
    if (!choice) return undefined;

    const ladder = this.ladders.get(choice.ladderId)!;
    let e1 = ladder.entries[choice.agentI];
    let opponent = ladder.entries[choice.agentJ];
    // Never pair two versions of the same project; keep the less-settled version!
    if (e1.agentId === opponent.agentId) {
      if (opponent.matchesPlayed < e1.matchesPlayed) {
        e1 = opponent;
      }
      const alt = ladder.entries
        .filter(e => e.active && e.agentId !== e1.agentId)
        .sort((a, b) => a.matchesPlayed - b.matchesPlayed)[0];
      if (!alt) return undefined;
      opponent = alt;
    }

    let p1TeamLabel: string | undefined;
    let p2TeamLabel: string | undefined;
    if (ladder.meta.team === 'pools') {
      const activeAgentIds = new Set(ladder.entries.filter(e => e.active).map(e => e.agentId));
      const pool = buildCanonicalTeamPool(
        [...ladder.teamsByAgent.entries()]
          .filter(([agentId]) => activeAgentIds.has(agentId))
          .map(([agentId, data]) => ({agentId, agentName: data.agentName, teams: data.teams})),
        ladder.meta.format
      );
      const sampled = samplePoolsPair(pool, e1.agentId, opponent.agentId, this.rng);
      p1TeamLabel = sampled.t1Label;
      p2TeamLabel = sampled.t2Label;
    }

    this.globalMatchSeq++;
    ladder.lastMatchNumber = this.globalMatchSeq;
    const matchId = `${ladder.meta.format}-${String(this.globalMatchSeq).padStart(7, '0')}`;
    const nowSec = this.getNowSeconds();

    const diff = e1.strengthBias - opponent.strengthBias;
    const pWin = 1 / (1 + Math.exp(-diff));
    const sampleGame = (): ratings.GameOutcome => (this.rng(1000) / 1000 < pWin ? 'W' : 'L');
    const g1 = sampleGame();
    const g2 = sampleGame();
    const cat = `${g1}${g2}` as ratings.MatchCategory;

    if (options.emitHeartbeats !== false) {
      this.heartbeatSeq++;
      await this.requestJson('POST', '/api/arena/heartbeat', {
        heartbeatSeq: this.heartbeatSeq,
        matchId,
        ladderId: ladder.meta.id,
        format: ladder.meta.format,
        game: 1,
        turn: 14,
        activeSlot: 'p1',
        turnStartedAt: nowSec,
        turnBudgetSeconds: 145,
        incrementSeconds: ladder.meta.slot === 'vgc' ? 25 : 10,
        p1: {
          slug: e1.agentSlug,
          name: e1.agentName,
          version: e1.version,
          bankSeconds: 145,
          lastTurnMillis: 280,
          meanTurnMillis: 295,
          ram: 840,
          ...(p1TeamLabel ? {team: p1TeamLabel} : {}),
        },
        p2: {
          slug: opponent.agentSlug,
          name: opponent.agentName,
          version: opponent.version,
          bankSeconds: 142,
          lastTurnMillis: 310,
          meanTurnMillis: 305,
          ram: 790,
          ...(p2TeamLabel ? {team: p2TeamLabel} : {}),
        },
      });

      this.heartbeatSeq++;
      await this.requestJson('POST', '/api/arena/heartbeat', {
        heartbeatSeq: this.heartbeatSeq,
        matchId,
        ladderId: ladder.meta.id,
        format: ladder.meta.format,
        game: 2,
        turn: 21,
        activeSlot: 'p2',
        turnStartedAt: nowSec,
        turnBudgetSeconds: 136,
        incrementSeconds: ladder.meta.slot === 'vgc' ? 25 : 10,
        game1Summary: {winnerSlot: g1 === 'W' ? 'p1' : 'p2', turns: 28},
        p1: {
          slug: e1.agentSlug,
          name: e1.agentName,
          version: e1.version,
          bankSeconds: 138,
          lastTurnMillis: 275,
          meanTurnMillis: 290,
          ram: 850,
          ...(p2TeamLabel ? {team: p2TeamLabel} : {}),
        },
        p2: {
          slug: opponent.agentSlug,
          name: opponent.agentName,
          version: opponent.version,
          bankSeconds: 136,
          lastTurnMillis: 325,
          meanTurnMillis: 310,
          ram: 800,
          ...(p1TeamLabel ? {team: p1TeamLabel} : {}),
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
      archivedLadder: boolean;
    }>('POST', '/api/arena/match-complete', {
      match: {
        id: matchId,
        ladderId: ladder.meta.id,
        p1VersionId: e1.versionId,
        p2VersionId: opponent.versionId,
        seed: `100,200,300,${this.globalMatchSeq}`,
        ...(p1TeamLabel !== undefined ? {p1TeamLabel} : {}),
        ...(p2TeamLabel !== undefined ? {p2TeamLabel} : {}),
        game1Outcome: g1,
        game2Outcome: g2,
        category: cat,
        game1Turns: 28,
        game2Turns: 26,
        game1EndReason: 'win',
        game2EndReason: 'win',
        p1PeakRam: 850,
        p2PeakRam: 800,
        p1Game1BankSeconds: 140,
        p1Game2BankSeconds: 138,
        p2Game1BankSeconds: 136,
        p2Game2BankSeconds: 134,
        p1MeanTurnMillis: 290,
        p2MeanTurnMillis: 310,
        completedAt: nowSec,
      },
      ...(shouldArchive ? {ladderStatus: 'archived' as const} : {}),
    });

    if (res.archivedLadder) {
      ladder.meta.status = 'archived';
    }

    return {
      matchId,
      ladderId: ladder.meta.id,
      p1VersionId: e1.versionId,
      p2VersionId: opponent.versionId,
      p1TeamLabel,
      p2TeamLabel,
      archivedLadder: res.archivedLadder,
    };
  }
}

const CLI_USAGE = [
  'Usage: mock <seed|step|run> [options]',
  '',
  'Commands:',
  '  seed [--db <path>] [--public-dir <dir>] [--now <unix_seconds>]',
  '  step [--server <url>] [--secret <token>] [--matches <n>] [--smoke <pass|fail>]',
  '  run  [--server <url>] [--secret <token>] [--interval-millis <ms>] [--smoke <pass|fail>]',
].join('\n');

export async function runMockCli(argv: string[]): Promise<void> {
  const {positionals, values} = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: {type: 'string'},
      'public-dir': {type: 'string'},
      server: {type: 'string'},
      secret: {type: 'string'},
      matches: {type: 'string'},
      'interval-millis': {type: 'string'},
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
    const publicDir = values['public-dir'] ?? render.PUBLIC_DIR;
    const now = values.now ? Number(values.now) : Math.floor(Date.now() / 1000);
    if (dbPath !== ':memory:') {
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${dbPath}${suffix}`, {force: true});
      }
    }

    const useMockDir = !values.db;
    const mockRoot = useMockDir
      ? root('.mock')
      : fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-mock-static-'));
    if (useMockDir) {
      fs.rmSync(mockRoot, {recursive: true, force: true});
      fs.mkdirSync(mockRoot, {recursive: true});
    }
    const staticDir = useMockDir ? path.join(mockRoot, 'static') : mockRoot;
    const avatarsDir = path.join(staticDir, 'avatars');
    const laddersFile = root('config', 'ladders.yml');
    const db = new Database(dbPath);
    try {
      prepareMockStaticDir(staticDir, avatarsDir);
      if (useMockDir) {
        const rawLadders = fs.readFileSync(laddersFile, 'utf8');
        fs.writeFileSync(
          path.join(mockRoot, 'ladders.yml'),
          rawLadders.replace(/status:\s*upcoming/g, 'status: active'),
          'utf8'
        );
        fs.writeFileSync(
          path.join(mockRoot, 'vgc-teams.txt'),
          `${generateValidVgcTeams(20, 42).join('\n\n')}\n`,
          'utf8'
        );
        seedMockWiki(path.join(mockRoot, 'wiki'));
      }
      seedMockArena({
        db,
        publicDir,
        staticDir,
        avatarsDir,
        laddersFile,
        now,
        render: true,
      });
      console.log(`Seeded mock Arena DB at ${dbPath} and rendered pages into ${publicDir}`);
    } finally {
      db.close();
      if (!useMockDir) {
        fs.rmSync(mockRoot, {recursive: true, force: true});
      }
    }
    return;
  }

  const serverUrl = values.server ?? process.env.ARENA_SERVER_URL ?? 'http://127.0.0.1:1234';
  const arenaSecret = values.secret ?? process.env.ARENA_SECRET ?? '';
  if (!arenaSecret) {
    throw new Error('Missing ARENA_SECRET (pass --secret or set ARENA_SECRET in .env)');
  }
  const smokeMode = values.smoke === 'fail' ? 'failed' : 'passed';
  const client = new MockArenaClient({
    serverUrl,
    arenaSecret,
    decideSmoke: () => ({
      smokeStatus: smokeMode,
      smokeError: smokeMode === 'failed' ? 'Simulated smoke test failure' : undefined,
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
    const intervalMillis = values['interval-millis'] ? Number(values['interval-millis']) : 2000;
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
      await new Promise(resolve => setTimeout(resolve, intervalMillis));
    }
    return;
  }

  throw new Error(`Unknown command "${cmd}"\n\n${CLI_USAGE}`);
}

if (require.main === module) {
  require('source-map-support').install();
  runMockCli(process.argv.slice(2)).catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
