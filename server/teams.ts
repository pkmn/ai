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
import {PokemonSet, Team} from '@pkmn/sets';
import * as sim from '@pkmn/sim';

import {toID} from '../static/util';
import * as teams from '../teams';

// `@pkmn/mods` requires parent mods (`champions`) to be registered on `@pkmn/sim`'s `Dex`
// before child mods (`championsregmb`), attaching format rules to the returned `ModdedDex`.
const CHAMPIONS_SIM_DEX = sim.Dex.mod('champions', champions as unknown as sim.ModData);
const CHAMPIONS_REGMB_SIM_DEX =
  sim.Dex.mod('championsregmb', championsregmb as unknown as sim.ModData);

function getValidator(format: string): sim.TeamValidator {
  const id = toID(format);
  const simDex = id.includes('champions')
    ? (id.includes('regmb') ? CHAMPIONS_REGMB_SIM_DEX : CHAMPIONS_SIM_DEX)
    : sim.Dex;
  const resolved = simDex.formats.get(id);
  if (!resolved.exists) {
    throw new Error(`Unknown format "${format}".`);
  }
  return new sim.TeamValidator(resolved, simDex);
}

interface PoolEntry {
  id: string;
  sets: Partial<PokemonSet>[];
  speciesSet: Set<string>;
}

const poolCache = new Map<string, PoolEntry[]>();

export function clearReferencePoolCache() {
  poolCache.clear();
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
  if (lines.length > 1 && lines.every(l => l.includes(']') && l.includes('|'))) {
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
  teamIndex: number
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

  // `TeamValidator.validateTeam` mutates sets in place while checking learnsets, format
  // banlists, Species/Item Clauses, and Champions Stat Point caps, so validate a clone.
  const problems = validator.validateTeam(structuredClone(rawSets) as sim.PokemonSet[]);
  if (problems?.length) {
    throw new Error(`${label} is illegal in ${validator.format.name}: ${problems.join('; ')}`);
  }

  // `@pkmn/sets` `Team.canonicalize` sorts team members and moves into a deterministic canonical
  // order for packed storage, while intentionally preserving non-`battleOnly` visual/cosmetic
  // formes (e.g. Gastrodon-East, Sinistcha-Masterpiece, Maushold-Four) for battle presentation.
  // For 1-NN uniqueness checking, we clone `canonicalSets` and collapse cosmetic/mechanically
  // identical formes via `canonSpecies` so forme swaps cannot game species distance.
  const canonicalSets = Team.canonicalize(structuredClone(rawSets), dex);
  const canonicalPacked = new Team(canonicalSets, dex).pack();

  const uniquenessSets = structuredClone(canonicalSets);
  for (const s of uniquenessSets) {
    s.species = teams.canonSpecies(dex, s.species);
  }
  const speciesSet = new Set(uniquenessSets.map(s => String(s.species ?? '')));

  return {canonicalPacked, uniquenessSets, speciesSet};
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
  threshold?: number;
}

export function validateCompetitorTeams(
  rawInput: string | string[],
  options: Options
): string[] {
  const expectedCount = options.teams;
  const threshold = options.threshold ?? teams.THRESHOLD;
  const format = toID(options.format);
  const dex = teams.getDex(format);
  const validator = getValidator(format);
  const defaultLevel =
    format.includes('vgc') || format.includes('bss') || format.includes('champions')
      ? 50
      : 100;

  const chunks = splitSubmittedTeams(rawInput);
  if (chunks.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} teams for ${options.format}, received ${chunks.length}.`
    );
  }

  const refPool = loadReferencePool(format, options.pools);
  const workingPool: PoolEntry[] = [...refPool];
  const packedOut: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const {canonicalPacked, uniquenessSets, speciesSet} = validateAndCanonicalizeSingleTeam(
      dex,
      validator,
      chunks[i],
      i
    );

    if (workingPool.length > 0) {
      const {minD, closestId} = minDistanceAgainstPool(
        dex,
        {sets: uniquenessSets, speciesSet},
        workingPool,
        defaultLevel
      );
      if (minD < threshold) {
        throw new Error(
          `Team #${i + 1} failed uniqueness check: distance=${minD.toFixed(3)} < ` +
          `${threshold.toFixed(2)} (closest=${closestId}).`
        );
      }
    }

    // Append each accepted team to `workingPool` sequentially so team `k` must also be
    // >= 1.30 away from teams `1..k-1` within the same submission.
    workingPool.push({
      id: `submitted-team-${i + 1}`,
      sets: uniquenessSets,
      speciesSet,
    });
    packedOut.push(canonicalPacked);
  }

  return packedOut;
}
