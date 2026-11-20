// Server-side validation and 1-NN uniqueness checking for competitor-submitted team pools.
//
// Ladders using `team: pools` (e.g. Gen 9 OU, VGC OTS, Gen 1 OU) require each agent submission
// to supply `teams` (default 20) legal 6-Pokémon teams that are pairwise distinct from both the
// public reference pool (`teams/...`) and every earlier team in the same submission (`D >= 1.30`).
//
// Zero-oracle sequential uniqueness: we intentionally check ONLY against the public reference
// pool and the agent's own submitted batch — NEVER against other competitors' private submitted
// pools — because rejecting a submission for colliding with another agent's secret pool would
// create a membership-inference oracle leaking private tournament teams.

import * as fs from 'fs';
import * as path from 'path';

import {ModdedDex} from '@pkmn/dex';
import * as champions from '@pkmn/mods/champions';
import * as championsregmb from '@pkmn/mods/championsregmb';
import {TeamGenerators} from '@pkmn/randoms';
import {PokemonSet, Team} from '@pkmn/sets';
import * as sim from '@pkmn/sim';

import {SIM_VERSION} from '../db/ladders';
import {toID} from '../static/util';
import * as teams from '../teams';

import {validateTeam} from './sim';
import * as simOps from './sim-ops';

// `@pkmn/mods` requires parent mods (`champions`) to be registered on `@pkmn/sim`'s `Dex`
// before child mods (`championsregmb`). We also extend the base `sim.Dex.formats` table so
// `BattleStreams.BattleStream()` and `sim.TeamValidator` resolve VGC Champions formats
// (`gen9championsvgc2026regmc`), and register `@pkmn/randoms` so `sim.Teams.generate` works for
// Random Battle ladders.
let simConfigured = false;
export function ensureSimConfigured() {
  if (simConfigured) return;
  simConfigured = true;
  simOps.configureSimMod(sim, {
    champions,
    championsregmb,
    teamGenerators: TeamGenerators,
  });
}

ensureSimConfigured();

function getValidator(format: string): sim.TeamValidator {
  ensureSimConfigured();
  const id = toID(format);
  const resolved = sim.Dex.formats.get(id);
  if (!resolved.exists) {
    throw new Error(`Unknown format '${format}'.`);
  }
  return new sim.TeamValidator(resolved);
}

interface PoolEntry {
  id: string;
  sets: Partial<PokemonSet>[];
  speciesSet: Set<string>;
}

const MAX_SPECIES_CACHE_SIZE = 10_000;
const poolCache = new Map<string, PoolEntry[]>();
const speciesCache = new Map<string, string[]>();

function cacheSpeciesIds(cacheKey: string, ids: string[]) {
  if (speciesCache.size >= MAX_SPECIES_CACHE_SIZE) {
    const oldestKey = speciesCache.keys().next().value;
    if (oldestKey !== undefined) speciesCache.delete(oldestKey);
  }
  speciesCache.set(cacheKey, ids);
}

export function clearReferencePoolCache() {
  poolCache.clear();
  speciesCache.clear();
}

export const TEAM_HASH_LEN = teams.TEAM_HASH_LEN;
export const hashTeam = teams.hashTeam;

export interface CanonicalPoolOwner {
  agentName: string;
  slotIndex: number;
}

export interface CanonicalPoolEntry {
  canonicalPacked: string;
  speciesIds: string[];
  owners: Map<number, CanonicalPoolOwner>;
}

export interface SampledPoolPair {
  t1Packed: string;
  t2Packed: string;
  t1Label: string;
  t2Label: string;
}

export interface RosterEntry {
  agentId: number;
  agentName: string;
  teams: string[];
}

export interface HarvestedPoolEntry {
  id: string;
  canonicalPacked: string;
  speciesIds: string[];
}

export function formatPoolTeamLabel(packedCanonicalTeam: string, owner?: 'P1' | 'P2'): string {
  const shortHash = teams.hashTeam(packedCanonicalTeam);
  return owner ? `${owner}:${shortHash}` : shortHash;
}

export function extractSpeciesIdsFromPacked(packed: string, format: string): string[] {
  const cacheKey = `${format}:${packed}`;
  const cached = speciesCache.get(cacheKey);
  if (cached) return cached;

  try {
    const dex = teams.getDex(format);
    const parsed = teams.parseTeam(dex, packed);
    if (parsed.length > 0) {
      const ids = parsed.map(s => toID(s.species ?? s.name ?? 'unknown')).sort();
      cacheSpeciesIds(cacheKey, ids);
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
  cacheSpeciesIds(cacheKey, fallback);
  return fallback;
}

function normalizeCanonicalPacked(rawTeam: string, format: string): string {
  const trimmed = rawTeam.trim();
  if (!trimmed.includes('\n')) return trimmed;
  try {
    const dex = teams.getDex(format);
    const imported = Team.import(trimmed, dex);
    const sets = Team.canonicalize((imported?.team || []).filter(s => s?.moves?.length), dex);
    if (sets.length > 0) return new Team(sets, dex).pack();
  } catch {}
  return trimmed;
}

function canonicalDedupeKey(canonicalPacked: string, format: string): string {
  try {
    const cleanFormat = toID(format);
    const dex = teams.getDex(cleanFormat);
    const defaultLevel = teams.defaultLevelForFormat(cleanFormat);
    const imported = Team.import(canonicalPacked, dex);
    const raw = (imported?.team || []).filter(s => s?.moves?.length);
    if (raw.length > 0) {
      for (const s of raw) {
        s.species = dex.species.get(teams.canonSpecies(dex, s.species)).name;
        // Strip shiny, gender, and over-50 levels strictly for cross-competitor deduplication
        // while keeping them intact on `canonicalPacked` for legality and battle mechanics.
        s.shiny = undefined;
        s.gender = undefined;
        if (defaultLevel === 50 && (s.level ?? defaultLevel) > defaultLevel) {
          s.level = defaultLevel;
        }
      }
      const sets = Team.canonicalize(raw, dex);
      return new Team(sets, dex).pack();
    }
  } catch {}
  return canonicalPacked;
}

export function buildCanonicalTeamPool(
  teamsByAgent: Iterable<RosterEntry>,
  format = 'gen9championsvgc2026regmc'
): CanonicalPoolEntry[] {
  const byPacked = new Map<string, CanonicalPoolEntry>();
  for (const {agentId, agentName, teams: rawTeams} of teamsByAgent) {
    for (let idx = 0; idx < rawTeams.length; idx++) {
      const canonicalPacked = normalizeCanonicalPacked(rawTeams[idx], format);
      if (!canonicalPacked) continue;
      const dedupeKey = canonicalDedupeKey(canonicalPacked, format);
      let entry = byPacked.get(dedupeKey);
      if (!entry) {
        entry = {
          canonicalPacked,
          speciesIds: extractSpeciesIdsFromPacked(canonicalPacked, format),
          owners: new Map(),
        };
        byPacked.set(dedupeKey, entry);
      }
      if (!entry.owners.has(agentId)) {
        entry.owners.set(agentId, {agentName, slotIndex: idx + 1});
      }
    }
  }
  return [...byPacked.values()];
}

function isSameSpeciesSix(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, idx) => s === b[idx]);
}

function isValidPoolsPair(
  t1: CanonicalPoolEntry,
  t2: CanonicalPoolEntry,
  agentAId: number,
  agentBId: number
): boolean {
  if (t1.canonicalPacked === t2.canonicalPacked) return false;
  if (isSameSpeciesSix(t1.speciesIds, t2.speciesIds)) return false;
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
//   - When `agentAId !== agentBId`, samples unordered distinct roster pair `{I, J}` with exact
//     marginal `2 / N` per agent (`2/N` `{A, C}`, `2/N` `{B, C}`, `(N-4)/N` `{C1, C2}`).
//     Allowing at most one active competitor per match to receive a team from their own submitted
//     roster is INTENTIONAL: never dealing competitors their own teams would remove
//     skin-in-the-game and incentivize poisoning the shared pool with weak/sabotage teams that
//     the author never has to pilot themselves. Because every ladder match is a 2-game mirror pair
//     where P1 and P2 swap teams in Game 2, any single-game hidden-information asymmetry cancels
//     across the pair.
//   - When `agentAId === agentBId` (Champion vs Challenger of the same project), both versions
//     share that project's seasonal pool, so `{C1, C2}` is drawn uniformly from distinct third
//     parties (`N - 1 >= 3`) to keep both teams blind to both sides.
export function samplePoolsPair(
  pool: CanonicalPoolEntry[],
  agentAId: number,
  agentBId: number,
  rngNextInt: (max: number) => number,
  minAgents = 4
): SampledPoolPair {
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

  const sameAgent = agentAId === agentBId;
  const thirdParties = [...rosters.keys()]
    .filter(id => id !== agentAId && id !== agentBId)
    .sort((a, b) => a - b);
  const totalAgents = rosters.size;
  const requiredAgents = Math.max(4, minAgents);
  if (
    totalAgents < requiredAgents ||
    !rosters.get(agentAId)?.length ||
    !rosters.get(agentBId)?.length ||
    thirdParties.length < 2
  ) {
    throw new Error(
      `Insufficient third-party teams in pool (pools ladders require min >= ${requiredAgents})`
    );
  }

  const formatProvenanceLabel = (entry: CanonicalPoolEntry): string => {
    const owner = sameAgent
      ? undefined
      : entry.owners.has(agentAId)
        ? 'P1'
        : entry.owners.has(agentBId)
          ? 'P2'
          : undefined;
    return formatPoolTeamLabel(entry.canonicalPacked, owner);
  };

  for (let attempt = 0; attempt < 256; attempt++) {
    let firstAgentId: number;
    let secondAgentId: number;
    if (sameAgent) {
      const i1 = rngNextInt(thirdParties.length);
      let i2 = rngNextInt(thirdParties.length - 1);
      if (i2 >= i1) i2++;
      firstAgentId = thirdParties[i1];
      secondAgentId = thirdParties[i2];
    } else {
      const roll = rngNextInt(totalAgents);
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
    }
    if (rngNextInt(2) === 1) {
      [firstAgentId, secondAgentId] = [secondAgentId, firstAgentId];
    }

    const r1 = rosters.get(firstAgentId)!;
    const r2 = rosters.get(secondAgentId)!;
    for (let pairTry = 0; pairTry < 16; pairTry++) {
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
  }

  // Deterministic exhaustive fallback for degenerate synthetic pools with heavy duplicate overlap.
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

export function sampleHarvestedPair(
  pool: HarvestedPoolEntry[],
  rngNextInt: (max: number) => number
): {t1Packed: string; t2Packed: string} {
  if (pool.length < 2) {
    throw new Error('Harvested team pool requires at least 2 distinct teams');
  }
  const t1 = pool[rngNextInt(pool.length)];
  for (let attempt = 0; attempt < 64; attempt++) {
    const t2 = pool[rngNextInt(pool.length)];
    if (
      t2.canonicalPacked !== t1.canonicalPacked &&
      !isSameSpeciesSix(t1.speciesIds, t2.speciesIds)
    ) {
      return {t1Packed: t1.canonicalPacked, t2Packed: t2.canonicalPacked};
    }
  }
  const nonMirror = pool.filter(
    e => e.canonicalPacked !== t1.canonicalPacked && !isSameSpeciesSix(t1.speciesIds, e.speciesIds)
  );
  const candidates = nonMirror.length > 0
    ? nonMirror
    : pool.filter(e => e.canonicalPacked !== t1.canonicalPacked);
  const t2 = candidates[rngNextInt(candidates.length)];
  return {t1Packed: t1.canonicalPacked, t2Packed: t2.canonicalPacked};
}

export function sampleRandomPair(
  format: string,
  seed1: sim.PRNGSeed,
  seed2: sim.PRNGSeed
): {t1Packed: string; t2Packed: string} {
  return simOps.sampleRandomPairWithSim(sim, format, seed1, seed2);
}

export function loadReferencePool(format: string, pools: string[]): PoolEntry[] {
  const cleanFormat = toID(format);
  const resolvedDirs = pools.map(d => path.resolve(d));
  const cacheKey = `${cleanFormat}::${resolvedDirs.join('|')}`;
  const cached = poolCache.get(cacheKey);
  if (cached) return cached;

  const dex = teams.getDex(cleanFormat);
  const entries: PoolEntry[] = [];

  for (const dir of resolvedDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir)
      .filter(f => !f.startsWith('.') && f !== 'README.md')
      .sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        if (!fs.statSync(full).isFile()) continue;
        const sets = teams.parseTeam(dex, fs.readFileSync(full, 'utf8'));
        if (!sets.length) continue;
        entries.push({
          id: file,
          sets,
          speciesSet: new Set(sets.map(s => String(s.species ?? ''))),
        });
      } catch {
        continue;
      }
    }
  }

  poolCache.set(cacheKey, entries);
  return entries;
}

export function splitSubmittedTeams(raw: string | string[]): string[] {
  if (Array.isArray(raw)) {
    return raw.map(t => String(t ?? '').trim()).filter(Boolean);
  }
  const trimmed = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!trimmed) return [];

  // 1. Standard Pokémon Showdown Teambuilder backup format: === [format] name ===
  if (/^===.*===\s*$/m.test(trimmed)) {
    return trimmed
      .split(/^===.*===\s*$/m)
      .map(chunk => chunk.trim())
      .filter(Boolean);
  }

  // 2. Packed teams: one team per line containing ']' and '|'
  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1 && lines.some(l => l.includes(']') && l.includes('|'))) {
    return lines;
  }

  // 3. Plain Showdown pastes without === headers: group every 6 Pokémon blocks
  const blocks = trimmed.split(/\n\s*\n+/).map(b => b.trim()).filter(Boolean);
  if (blocks.length > 6 && blocks.length % 6 === 0) {
    const grouped: string[] = [];
    for (let i = 0; i < blocks.length; i += 6) {
      grouped.push(blocks.slice(i, i + 6).join('\n\n'));
    }
    return grouped;
  }

  return [trimmed];
}

function validateAndCanonicalizeSingleTeam(
  dex: ModdedDex,
  validator: sim.TeamValidator,
  rawTeam: string,
  teamIndex: number,
  options?: {requireFullMoveset?: boolean; defaultLevel?: number}
): {canonicalPacked: string; uniquenessSets: Partial<PokemonSet>[]; speciesSet: Set<string>} {
  const label = `Team #${teamIndex + 1}`;
  const imported = Team.import(rawTeam.trim(), dex);
  const rawSets = (imported?.team ?? []).filter(s => s && (s.species || s.name));

  // VGC formats on Showdown allow 4-6 Pokémon per team (`minTeamSize = 4`), whereas Arena
  // pools require full 6-Pokémon teams both by tournament rule and because `teamDistance` in
  // `[0, 6]` sums species contributions over all 6 slots.
  if (rawSets.length !== 6) {
    throw new Error(`${label} must contain 6 Pokémon (found ${rawSets.length}).`);
  }

  // `TeamValidator.validateTeam` normalizes sets in place (clamping over-50 levels to 50 in
  // VGC/Champions, correcting spoofed single-option abilities like Wonder Guard on Terapagos, and
  // clearing illegal fields) while checking learnsets, banlists, Species/Item Clauses, and Stat
  // Point caps. Retain `validatedSets` so downstream canonicalization packs the normalized sets!
  const validatedSets = structuredClone(rawSets) as sim.PokemonSet[];
  const problems = validator.validateTeam(validatedSets);
  if (problems?.length) {
    throw new Error(`${label} is illegal in ${validator.format.name}: ${problems.join('; ')}`);
  }

  // Prevent move-deletion gaming of `dMoves` on competitor-submitted `pools` rosters by requiring
  // 4 distinct moves unless the species has fewer than 4 legal moves in the format (e.g. Ditto).
  if (options?.requireFullMoveset) {
    for (const s of validatedSets) {
      const distinctMoves = new Set((s.moves ?? []).map(m => toID(m)).filter(Boolean));
      if (distinctMoves.size < 4) {
        const required = simOps.maxLegalMovesForSpecies(validator, s);
        if (distinctMoves.size < required) {
          const spName = dex.species.get(s.species || s.name || '').name || 'Pokémon';
          throw new Error(
            `${label}: ${spName} must have ${required} moves (found ${distinctMoves.size}).`
          );
        }
      }
    }
  }

  // `@pkmn/sets` `Team.canonicalize` sorts all 6 team slots and 4 move slots into a deterministic
  // canonical order for packed storage (neutralizing Team Preview slot-order watermarking) and
  // preserves explicit under-leveled sets (`s.level = s.level || (champions ? 50 : 100)`), `shiny`,
  // `gender`, and non-`battleOnly` visual/cosmetic formes (e.g. Gastrodon-East,
  // Sinistcha-Masterpiece, Maushold-Four) for legality and battle mechanics. For 1-NN uniqueness
  // checking and cross-competitor pool ownership deduplication, `canonSpecies` collapses cosmetic
  // and ability-identical formes to their base species ID.
  const canonicalSets = Team.canonicalize(validatedSets, dex);
  const canonicalPacked = new Team(canonicalSets, dex).pack();
  const entry = toUniquenessEntry(dex, canonicalSets, label, options?.defaultLevel);

  return {
    canonicalPacked,
    uniquenessSets: entry.sets,
    speciesSet: entry.speciesSet,
  };
}

function toUniquenessEntry(
  dex: ModdedDex,
  sets: Partial<PokemonSet>[],
  id: string,
  defaultLevel?: number
): PoolEntry {
  const uniquenessSets = structuredClone(sets);
  for (const s of uniquenessSets) {
    s.species = teams.canonSpecies(dex, s.species);
    s.shiny = undefined;
    s.gender = undefined;
    if (defaultLevel === 50 && (s.level ?? 50) > 50) {
      s.level = 50;
    }
  }
  const speciesSet = new Set(uniquenessSets.map(s => String(s.species ?? '')));
  return {id, sets: uniquenessSets, speciesSet};
}

function minDistanceAgainstPool(
  dex: ModdedDex,
  candidate: {sets: Partial<PokemonSet>[]; speciesSet: Set<string>},
  pool: PoolEntry[],
  defaultLevel: number
): {minD: number; closestId: string} {
  let minD = Infinity;
  let closestId = '';

  for (const entry of pool) {
    // Lower bound: each species in `candidate` absent from `entry` contributes +1.0 to
    // `teamDistance`, allowing us to prune pairs that cannot beat the running `minD`.
    let unshared = 0;
    for (const sp of candidate.speciesSet) {
      if (!entry.speciesSet.has(sp)) unshared++;
    }
    if (unshared >= minD) continue;

    const d = teams.teamDistance(dex, candidate.sets, entry.sets, defaultLevel);
    if (d < minD) {
      minD = d;
      closestId = entry.id;
    }
  }

  return {minD, closestId};
}

export interface Options {
  format: string;
  pools: string[];
  teams: number;
}

export interface RejectedTeam {
  index: number;
  reason: string;
  closestId?: string;
  distance?: number;
}

export interface IncrementalValidationResult {
  allSaved: string[];
  newlySavedCount: number;
  requiredCount: number;
  remainingCount: number;
  rejections: RejectedTeam[];
  complete: boolean;
}

export function validateCompetitorTeamsIncremental(
  rawInput: string | string[],
  options: Options,
  existingSavedPacked: string[] = []
): IncrementalValidationResult {
  const requiredCount = options.teams;
  const threshold = teams.THRESHOLD;
  const format = toID(options.format);
  const dex = teams.getDex(format);
  const validator = getValidator(format);
  const defaultLevel = teams.defaultLevelForFormat(format);

  const refPool = loadReferencePool(format, options.pools);
  const workingPool: PoolEntry[] = [...refPool];
  const allSaved = [...existingSavedPacked];
  const preExistingSet = new Set(existingSavedPacked);
  const seenExistingInPaste = new Set<string>();

  for (let i = 0; i < existingSavedPacked.length; i++) {
    const sets = teams.parseTeam(dex, existingSavedPacked[i]);
    workingPool.push(toUniquenessEntry(dex, sets, `saved-team-${i + 1}`, defaultLevel));
  }

  const chunks = splitSubmittedTeams(rawInput);
  const maxChunks = Math.max(50, requiredCount * 2);
  const boundedChunks = chunks.length > maxChunks ? chunks.slice(0, maxChunks) : chunks;
  const rejections: RejectedTeam[] = [];
  let newlySavedCount = 0;

  for (let i = 0; i < boundedChunks.length; i++) {
    try {
      const {canonicalPacked, uniquenessSets, speciesSet} = validateAndCanonicalizeSingleTeam(
        dex,
        validator,
        boundedChunks[i],
        i,
        {requireFullMoveset: true, defaultLevel}
      );

      // Re-uploading a full .txt after replacing bad teams keeps already-saved distinct teams,
      // while a second duplicate copy within the same paste is still checked and rejected.
      if (preExistingSet.has(canonicalPacked) && !seenExistingInPaste.has(canonicalPacked)) {
        seenExistingInPaste.add(canonicalPacked);
        continue;
      }

      if (allSaved.length >= requiredCount) {
        rejections.push({
          index: i + 1,
          reason:
            `Team #${i + 1} skipped: ${requiredCount}/${requiredCount} distinct teams ` +
            'already saved.',
        });
        continue;
      }

      if (workingPool.length > 0) {
        const {minD, closestId} = minDistanceAgainstPool(
          dex,
          {sets: uniquenessSets, speciesSet},
          workingPool,
          defaultLevel
        );
        if (minD < threshold) {
          rejections.push({
            index: i + 1,
            reason:
              `Team #${i + 1} failed uniqueness check: distance=${minD.toFixed(3)} < ` +
              `${threshold.toFixed(2)} (closest=${closestId}).`,
            closestId,
            distance: minD,
          });
          continue;
        }
      }

      const nextSlot = allSaved.length + 1;
      workingPool.push({
        id: `submitted-team-${nextSlot}`,
        sets: uniquenessSets,
        speciesSet,
      });
      allSaved.push(canonicalPacked);
      newlySavedCount++;
    } catch (err: any) {
      rejections.push({
        index: i + 1,
        reason: err?.message || `Team #${i + 1} is invalid.`,
      });
    }
  }

  if (chunks.length > maxChunks) {
    rejections.push({
      index: maxChunks + 1,
      reason:
        `Teams #${maxChunks + 1}–#${chunks.length} skipped: ` +
        `paste at most ${maxChunks} teams per validation request.`,
    });
  }

  const remainingCount = Math.max(0, requiredCount - allSaved.length);
  return {
    allSaved,
    newlySavedCount,
    requiredCount,
    remainingCount,
    rejections,
    complete: remainingCount === 0 && allSaved.length === requiredCount,
  };
}

export function validateHarvestedTeams(rawInput: string | string[], formatId: string): string[] {
  const format = toID(formatId);
  const dex = teams.getDex(format);
  const validator = getValidator(format);
  const chunks = splitSubmittedTeams(rawInput);

  if (chunks.length < 2) {
    throw new Error(
      `Harvested ladder ${formatId} requires at least 2 valid teams (received ${chunks.length}).`
    );
  }

  const packedOut: string[] = [];
  const distinctSpeciesSets = new Set<string>();
  for (let i = 0; i < chunks.length; i++) {
    const {canonicalPacked, speciesSet} = validateAndCanonicalizeSingleTeam(
      dex,
      validator,
      chunks[i],
      i
    );
    packedOut.push(canonicalPacked);
    distinctSpeciesSets.add([...speciesSet].sort().join('|'));
  }

  if (distinctSpeciesSets.size < 2) {
    throw new Error(
      `Harvested ladder ${formatId} requires at least 2 non-mirror teams with distinct species.`
    );
  }

  return packedOut;
}

export async function validateHarvestedTeamsForVersion(
  rawInput: string | string[],
  formatId: string,
  version = SIM_VERSION
): Promise<string[]> {
  if (version === SIM_VERSION) {
    return validateHarvestedTeams(rawInput, formatId);
  }
  const format = toID(formatId);
  const dex = teams.getDex(format);
  const defaultLevel = teams.defaultLevelForFormat(format);
  const chunks = splitSubmittedTeams(rawInput);

  if (chunks.length < 2) {
    throw new Error(
      `Harvested ladder ${formatId} requires at least 2 valid teams (received ${chunks.length}).`
    );
  }

  const packedOut: string[] = [];
  const distinctSpeciesSets = new Set<string>();
  for (let i = 0; i < chunks.length; i++) {
    const label = `Team #${i + 1}`;
    const check = await validateTeam(formatId, chunks[i], version, {
      requireSixPokemon: true,
      canonicalize: true,
    });
    if (check.problems?.length || !check.packed) {
      const formatName = check.formatName || formatId;
      const details = check.problems?.join('; ') || 'Empty or unparseable team.';
      throw new Error(`${label} is illegal in ${formatName}: ${details}`);
    }
    const sets = teams.parseTeam(dex, check.packed);
    const entry = toUniquenessEntry(dex, sets, label, defaultLevel);
    packedOut.push(check.packed);
    distinctSpeciesSets.add([...entry.speciesSet].sort().join('|'));
  }

  if (distinctSpeciesSets.size < 2) {
    throw new Error(
      `Harvested ladder ${formatId} requires at least 2 non-mirror teams with distinct species.`
    );
  }

  return packedOut;
}

export async function validateCompetitorTeamsIncrementalForVersion(
  rawInput: string | string[],
  options: Options,
  existingSavedPacked: string[] = [],
  version = SIM_VERSION
): Promise<IncrementalValidationResult> {
  if (version === SIM_VERSION) {
    return validateCompetitorTeamsIncremental(rawInput, options, existingSavedPacked);
  }
  const requiredCount = options.teams;
  const threshold = teams.THRESHOLD;
  const format = toID(options.format);
  const dex = teams.getDex(format);
  const defaultLevel = teams.defaultLevelForFormat(format);

  const refPool = loadReferencePool(format, options.pools);
  const workingPool: PoolEntry[] = [...refPool];
  const allSaved = [...existingSavedPacked];
  const preExistingSet = new Set(existingSavedPacked);
  const seenExistingInPaste = new Set<string>();

  for (let i = 0; i < existingSavedPacked.length; i++) {
    const sets = teams.parseTeam(dex, existingSavedPacked[i]);
    workingPool.push(toUniquenessEntry(dex, sets, `saved-team-${i + 1}`, defaultLevel));
  }

  const chunks = splitSubmittedTeams(rawInput);
  const maxChunks = Math.max(50, requiredCount * 2);
  const boundedChunks = chunks.length > maxChunks ? chunks.slice(0, maxChunks) : chunks;
  const rejections: RejectedTeam[] = [];
  let newlySavedCount = 0;

  for (let i = 0; i < boundedChunks.length; i++) {
    const label = `Team #${i + 1}`;
    try {
      const check = await validateTeam(options.format, boundedChunks[i], version, {
        requireSixPokemon: true,
        requireFullMoveset: true,
        canonicalize: true,
      });
      if (check.problems?.length || !check.packed) {
        const formatName = check.formatName || options.format;
        const details = check.problems?.join('; ') || 'Empty or unparseable team.';
        throw new Error(`${label} is illegal in ${formatName}: ${details}`);
      }
      const canonicalPacked = check.packed;
      const canonicalSets = teams.parseTeam(dex, canonicalPacked);
      const entry = toUniquenessEntry(dex, canonicalSets, label, defaultLevel);

      if (preExistingSet.has(canonicalPacked) && !seenExistingInPaste.has(canonicalPacked)) {
        seenExistingInPaste.add(canonicalPacked);
        continue;
      }

      if (allSaved.length >= requiredCount) {
        rejections.push({
          index: i + 1,
          reason:
            `Team #${i + 1} skipped: ${requiredCount}/${requiredCount} distinct teams ` +
            'already saved.',
        });
        continue;
      }

      if (workingPool.length > 0) {
        const {minD, closestId} = minDistanceAgainstPool(
          dex,
          {sets: entry.sets, speciesSet: entry.speciesSet},
          workingPool,
          defaultLevel
        );
        if (minD < threshold) {
          rejections.push({
            index: i + 1,
            reason:
              `Team #${i + 1} failed uniqueness check: distance=${minD.toFixed(3)} < ` +
              `${threshold.toFixed(2)} (closest=${closestId}).`,
            closestId,
            distance: minD,
          });
          continue;
        }
      }

      const nextSlot = allSaved.length + 1;
      workingPool.push({
        id: `submitted-team-${nextSlot}`,
        sets: entry.sets,
        speciesSet: entry.speciesSet,
      });
      allSaved.push(canonicalPacked);
      newlySavedCount++;
    } catch (err: any) {
      rejections.push({
        index: i + 1,
        reason: err?.message || `Team #${i + 1} is invalid.`,
      });
    }
  }

  if (chunks.length > maxChunks) {
    rejections.push({
      index: maxChunks + 1,
      reason:
        `Teams #${maxChunks + 1}–#${chunks.length} skipped: ` +
        `paste at most ${maxChunks} teams per validation request.`,
    });
  }

  const remainingCount = Math.max(0, requiredCount - allSaved.length);
  return {
    allSaved,
    newlySavedCount,
    requiredCount,
    remainingCount,
    rejections,
    complete: remainingCount === 0 && allSaved.length === requiredCount,
  };
}
