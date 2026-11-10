import * as fs from 'fs';
import * as path from 'path';

import type {ID, ModdedDex} from '@pkmn/dex';
import {type PokemonSet, Team} from '@pkmn/sets';

import {toID} from '../static/util';
import {
  STATS,
  THRESHOLD,
  canonSpecies,
  getDex,
  parseTeam,
  teamDistance,
} from '../teams';

interface PoolEntry {
  id: string;
  sets: Partial<PokemonSet>[];
  speciesSet: Set<string>;
}

const poolCache = new Map<string, PoolEntry[]>();

export function clearReferencePoolCache() {
  poolCache.clear();
}

export function loadReferencePool(formatId: string, poolDirs: string[]): PoolEntry[] {
  const cleanFormat = toID(formatId);
  const resolvedDirs = poolDirs.map(d => path.resolve(d));
  const cacheKey = `${cleanFormat}::${resolvedDirs.join('|')}`;
  const cached = poolCache.get(cacheKey);
  if (cached) return cached;

  const dex = getDex(cleanFormat);
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
        const sets = parseTeam(dex, fs.readFileSync(full, 'utf8'));
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

  // 2. Packed teams: one team per line containing ']'
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
  formatId: string,
  rawTeam: string,
  teamIndex: number
): {canonicalPacked: string; uniquenessSets: Partial<PokemonSet>[]; speciesSet: Set<string>} {
  const label = `Team #${teamIndex + 1}`;
  const imported = Team.import(rawTeam.trim(), dex);
  const rawSets = (imported?.team ?? []).filter(s => s && (s.species || s.name));

  if (rawSets.length !== 6) {
    throw new Error(`${label} must contain 6 Pokémon (found ${rawSets.length}).`);
  }

  const isVgc = formatId.includes('vgc') || formatId.includes('champions');
  const dexNums = new Set<number>();
  const heldItems = new Set<ID>();

  for (let slot = 0; slot < rawSets.length; slot++) {
    const s = rawSets[slot];
    const sp = dex.species.get(s.species || s.name || '');
    if (!sp.exists || sp.isNonstandard || sp.tier === 'Illegal' || sp.tier === 'Unreleased') {
      throw new Error(
        `${label} slot ${slot + 1}: "${s.species || s.name || '?'}" is not legal in ${formatId}.`
      );
    }

    if (dexNums.has(sp.num)) {
      throw new Error(`${label} violates Species Clause (duplicate #${sp.num} ${sp.name}).`);
    }
    dexNums.add(sp.num);

    if (s.item) {
      const it = dex.items.get(s.item);
      if (!it.exists || it.isNonstandard) {
        throw new Error(`${label} (${sp.name}): invalid item "${s.item}".`);
      }
      if (isVgc && heldItems.has(it.id)) {
        throw new Error(`${label} violates Item Clause (duplicate ${it.name}).`);
      }
      heldItems.add(it.id);
    }

    const ab = dex.abilities.get(s.ability || '');
    const allowedAbilities = Object.values(sp.abilities).map(a => toID(a));
    if (!ab.exists || ab.isNonstandard || !allowedAbilities.includes(ab.id)) {
      throw new Error(
        `${label} (${sp.name}): illegal ability "${s.ability || '(missing)'}".`
      );
    }

    const moves = s.moves ?? [];
    if (moves.length < 1 || moves.length > 4) {
      throw new Error(`${label} (${sp.name}) must have 1 to 4 moves.`);
    }
    const moveIds = new Set<ID>();
    for (const rawMove of moves) {
      const mv = dex.moves.get(rawMove);
      if (!mv.exists || mv.isNonstandard) {
        throw new Error(`${label} (${sp.name}): invalid move "${rawMove}".`);
      }
      if (moveIds.has(mv.id)) {
        throw new Error(`${label} (${sp.name}): duplicate move "${mv.name}".`);
      }
      moveIds.add(mv.id);
    }

    if (s.evs) {
      let evTotal = 0;
      for (const st of STATS) {
        const v = s.evs[st] ?? 0;
        if (!Number.isInteger(v) || v < 0 || v > 252) {
          throw new Error(`${label} (${sp.name}): invalid ${st.toUpperCase()} EV "${v}".`);
        }
        evTotal += v;
      }
      if (dex.gen >= 3 && evTotal > 510) {
        throw new Error(`${label} (${sp.name}): EV total ${evTotal} exceeds 510.`);
      }
    }

    if (s.ivs) {
      for (const st of STATS) {
        const v = s.ivs[st] ?? 31;
        if (!Number.isInteger(v) || v < 0 || v > 31) {
          throw new Error(`${label} (${sp.name}): invalid ${st.toUpperCase()} IV "${v}".`);
        }
      }
    }

    if (s.level !== undefined && (!Number.isInteger(s.level) || s.level < 1 || s.level > 100)) {
      throw new Error(`${label} (${sp.name}): invalid level "${s.level}".`);
    }
  }

  const canonicalSets = Team.canonicalize(rawSets, dex);
  const canonicalPacked = new Team(canonicalSets, dex).pack();

  const uniquenessSets = Team.canonicalize(rawSets, dex);
  for (const s of uniquenessSets) {
    s.species = canonSpecies(dex, s.species);
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
    // Lower bound: each species in candidate absent from entry contributes +1.0 to teamDistance.
    let unshared = 0;
    for (const sp of candidate.speciesSet) {
      if (!entry.speciesSet.has(sp)) unshared++;
    }
    if (unshared >= minD) continue;

    const d = teamDistance(dex, candidate.sets, entry.sets, defaultLevel);
    if (d < minD) {
      minD = d;
      closestId = entry.id;
    }
  }

  return {minD, closestId};
}

export interface TeamPoolValidationOptions {
  formatId: string;
  poolDirs: string[];
  teamCount: number;
  threshold?: number;
}

export function validateCompetitorTeams(
  rawInput: string | string[],
  options: TeamPoolValidationOptions
): string[] {
  const expectedCount = options.teamCount;
  const threshold = options.threshold ?? THRESHOLD;
  const formatId = toID(options.formatId);
  const dex = getDex(formatId);
  const defaultLevel =
    formatId.includes('vgc') || formatId.includes('bss') || formatId.includes('champions')
      ? 50
      : 100;

  const chunks = splitSubmittedTeams(rawInput);
  if (chunks.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} teams for ${options.formatId}, received ${chunks.length}.`
    );
  }

  const refPool = loadReferencePool(formatId, options.poolDirs);
  const workingPool: PoolEntry[] = [...refPool];
  const packedOut: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const {canonicalPacked, uniquenessSets, speciesSet} = validateAndCanonicalizeSingleTeam(
      dex,
      formatId,
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

    workingPool.push({
      id: `submitted-team-${i + 1}`,
      sets: uniquenessSets,
      speciesSet,
    });
    packedOut.push(canonicalPacked);
  }

  return packedOut;
}
