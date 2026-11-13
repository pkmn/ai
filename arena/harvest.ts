import * as crypto from 'crypto';
import * as fs from 'fs';

import {Team} from '@pkmn/sets';
import {Dex, PokemonSet, TeamValidator, Teams} from '@pkmn/sim';

import {toID} from '../static/util';
import * as teams from '../teams';

export interface HarvestedSideCandidate {
  sets: PokemonSet[];
  elo: number;
  won: boolean;
}

export interface HarvestOptions {
  formatId: string;
  gen: number;
  minElo?: number;
  targetPoolSize?: number;
  maxCoreShare?: number; // Default 0.08 (max 8% of pool sharing any 4-Pokemon core)
}

function canonicalTeamHash(sets: PokemonSet[], formatId: string): {
  hash: string;
  packed: string;
} {
  const dex = teams.getDex(formatId);
  const canonical = Team.canonicalize(
    sets.map(s => structuredClone(s)),
    dex
  );
  const packed = new Team(canonical, dex).pack() || Teams.pack(sets);
  const hash = crypto.createHash('sha256').update(packed).digest('hex');
  return {hash, packed};
}

function getFourMonCores(sets: PokemonSet[]): string[] {
  const species = sets.map(s => toID(s.species || s.name)).sort();
  const cores: string[] = [];
  for (let a = 0; a < 6; a++) {
    for (let b = a + 1; b < 6; b++) {
      for (let c = b + 1; c < 6; c++) {
        for (let d = c + 1; d < 6; d++) {
          cores.push(`${species[a]}|${species[b]}|${species[c]}|${species[d]}`);
        }
      }
    }
  }
  return cores;
}

export function filterAndRankHarvestedTeams(
  candidates: Iterable<HarvestedSideCandidate>,
  opts: HarvestOptions
): string[] {
  const minElo = opts.minElo ?? 1650;
  const targetSize = opts.targetPoolSize ?? 1000;
  const maxCoreCount = Math.max(1, Math.floor(targetSize * (opts.maxCoreShare ?? 0.08)));
  const validator = new TeamValidator(opts.formatId);

  const byHash = new Map<string, {
    packed: string;
    cores: string[];
    wins: number;
    games: number;
    maxElo: number;
  }>();

  for (const cand of candidates) {
    // 1. Rating floor
    if (cand.elo < minElo) continue;

    // 2. Full 6-Pokemon, 4-move reveal check
    if (cand.sets.length !== 6) continue;
    const fullyRevealed = cand.sets.every(s => {
      if (!s.species || !Array.isArray(s.moves) || s.moves.length !== 4) return false;
      if (opts.gen >= 2 && !s.item) return false;
      if (opts.gen >= 3 && !s.ability) return false;
      return true;
    });
    if (!fullyRevealed) continue;

    // 3. Format legality check
    const problems = validator.validateTeam(cand.sets.map(s => structuredClone(s)));
    if (problems && problems.length > 0) continue;

    // 4. Canonicalize & deduplicate
    const {hash, packed} = canonicalTeamHash(cand.sets, opts.formatId);
    const existing = byHash.get(hash);
    if (existing) {
      existing.games += 1;
      if (cand.won) existing.wins += 1;
      if (cand.elo > existing.maxElo) existing.maxElo = cand.elo;
    } else {
      byHash.set(hash, {
        packed,
        cores: getFourMonCores(cand.sets),
        wins: cand.won ? 1 : 0,
        games: 1,
        maxElo: cand.elo,
      });
    }
  }

  // 5. Rank by Laplace-smoothed win rate (w + 1) / (n + 2), breaking ties by peak Elo then hash
  const ranked = [...byHash.entries()].sort((a, b) => {
    const scoreA = (a[1].wins + 1) / (a[1].games + 2);
    const scoreB = (b[1].wins + 1) / (b[1].games + 2);
    if (scoreB !== scoreA) return scoreB - scoreA;
    if (b[1].maxElo !== a[1].maxElo) return b[1].maxElo - a[1].maxElo;
    return a[0].localeCompare(b[0]);
  });

  // 6. Greedy selection enforcing 4-Pokemon core diversity cap
  const coreCounts = new Map<string, number>();
  const selected: string[] = [];

  for (const [, entry] of ranked) {
    if (selected.length >= targetSize) break;
    if (entry.cores.some(c => (coreCounts.get(c) ?? 0) >= maxCoreCount)) {
      continue;
    }
    selected.push(entry.packed);
    for (const c of entry.cores) {
      coreCounts.set(c, (coreCounts.get(c) ?? 0) + 1);
    }
  }

  return selected;
}

interface RevealedMonState {
  species: string;
  item: string;
  ability: string;
  teraType: string;
  moves: Set<string>;
}

// Extracts revealed sides from a single raw Showdown battle log for Pass 1 of the harvester.
// Populates default competitive spreads (252 HP / 4 Def / 252 Spe, Serious nature, 31 IVs)
// when hidden EVs/IVs are absent from public battle logs.
export function extractRevealedTeamsFromLog(
  logText: string,
  formatId: string
): HarvestedSideCandidate[] {
  const dex = Dex.forFormat(formatId);
  const mons: Record<'p1' | 'p2', Map<string, RevealedMonState>> = {
    p1: new Map(),
    p2: new Map(),
  };
  const identToSpecies: Record<'p1' | 'p2', Map<string, string>> = {
    p1: new Map(),
    p2: new Map(),
  };
  const names: Record<'p1' | 'p2', string> = {p1: 'p1', p2: 'p2'};
  const elos: Record<'p1' | 'p2', number> = {p1: 0, p2: 0};
  let winnerName: string | undefined;
  let forfeited = false;

  const ensureMon = (side: 'p1' | 'p2', rawSpecies: string): RevealedMonState | undefined => {
    const clean = rawSpecies.split(',')[0].trim();
    let sp = dex.species.get(clean);
    if (!sp.exists) return undefined;
    const requiredItem = sp.requiredItem;
    if (sp.battleOnly) {
      const outOfBattle = Array.isArray(sp.battleOnly) ? sp.battleOnly[0] : sp.battleOnly;
      const baseSp = dex.species.get(outOfBattle);
      if (baseSp.exists) sp = baseSp;
    } else if (sp.baseSpecies && sp.baseSpecies !== sp.name) {
      const basePlaceholder = mons[side].get(sp.baseSpecies);
      if (
        basePlaceholder?.moves.size === 0 &&
        !basePlaceholder.item &&
        !basePlaceholder.ability &&
        !mons[side].has(sp.name)
      ) {
        mons[side].delete(sp.baseSpecies);
        basePlaceholder.species = sp.name;
        basePlaceholder.teraType = sp.types[0];
        mons[side].set(sp.name, basePlaceholder);
      }
    }
    let entry = mons[side].get(sp.name);
    if (!entry) {
      entry = {
        species: sp.name,
        item: requiredItem || '',
        ability: '',
        teraType: sp.types[0],
        moves: new Set(),
      };
      mons[side].set(sp.name, entry);
    } else if (requiredItem && !entry.item) {
      entry.item = requiredItem;
    }
    return entry;
  };

  const resolveIdent = (ident: string): {side: 'p1' | 'p2'; mon?: RevealedMonState} | undefined => {
    const side = ident.startsWith('p1') ? 'p1' : ident.startsWith('p2') ? 'p2' : undefined;
    if (!side) return undefined;
    const colon = ident.indexOf(':');
    const nick = colon >= 0 ? ident.slice(colon + 1).trim() : ident;
    const mapped = identToSpecies[side].get(nick) ?? nick;
    return {side, mon: mons[side].get(mapped) ?? ensureMon(side, mapped)};
  };

  for (const rawLine of logText.split(/\r?\n/)) {
    if (!rawLine.startsWith('|')) continue;
    const parts = rawLine.split('|');
    const cmd = parts[1];

    if (cmd === 'player') {
      const side = parts[2] === 'p1' ? 'p1' : parts[2] === 'p2' ? 'p2' : undefined;
      if (side) {
        if (parts[3]) names[side] = parts[3].trim();
        const rating = Number(parts[5]);
        if (Number.isFinite(rating) && rating > 0) elos[side] = rating;
      }
    } else if (cmd === 'poke') {
      const side = parts[2] === 'p1' ? 'p1' : parts[2] === 'p2' ? 'p2' : undefined;
      if (side && parts[3]) ensureMon(side, parts[3]);
    } else if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace') {
      const ident = parts[2] ?? '';
      const details = parts[3] ?? '';
      const side = ident.startsWith('p1') ? 'p1' : ident.startsWith('p2') ? 'p2' : undefined;
      if (side && details) {
        const mon = ensureMon(side, details);
        const colon = ident.indexOf(':');
        if (mon && colon >= 0) {
          identToSpecies[side].set(ident.slice(colon + 1).trim(), mon.species);
        }
      }
    } else if (cmd === 'move') {
      const resolved = resolveIdent(parts[2] ?? '');
      const moveName = (parts[3] ?? '').trim();
      if (resolved?.mon && moveName && !rawLine.includes('[from]')) {
        const mv = dex.moves.get(moveName);
        if (mv.exists && mv.id !== 'struggle' && resolved.mon.moves.size < 4) {
          resolved.mon.moves.add(mv.name);
        }
      }
    } else if (cmd === '-item' || cmd === '-enditem') {
      const resolved = resolveIdent(parts[2] ?? '');
      const itemName = (parts[3] ?? '').trim();
      if (resolved?.mon && itemName && !resolved.mon.item) {
        const it = dex.items.get(itemName);
        if (it.exists) resolved.mon.item = it.name;
      }
    } else if (cmd === '-ability') {
      const resolved = resolveIdent(parts[2] ?? '');
      const abilName = (parts[3] ?? '').trim();
      if (resolved?.mon && abilName && !resolved.mon.ability) {
        const ab = dex.abilities.get(abilName);
        if (ab.exists) resolved.mon.ability = ab.name;
      }
    } else if (cmd === '-terastallize') {
      const resolved = resolveIdent(parts[2] ?? '');
      const tType = (parts[3] ?? '').trim();
      if (resolved?.mon && tType) {
        resolved.mon.teraType = tType;
      }
    } else if (cmd === '-message') {
      const msg = (parts[2] ?? '').trim();
      if (/(?:forfeited|lost due to inactivity)\.?$/i.test(msg)) {
        forfeited = true;
      }
    } else if (cmd === 'forfeit') {
      forfeited = true;
    } else if (cmd === 'win') {
      winnerName = (parts[2] ?? '').trim();
    }
  }

  if (forfeited) return [];

  const out: HarvestedSideCandidate[] = [];
  for (const side of ['p1', 'p2'] as const) {
    if (mons[side].size !== 6) continue;
    const sets: PokemonSet[] = [];
    for (const m of mons[side].values()) {
      const sp = dex.species.get(m.species);
      const ability = m.ability || (dex.gen >= 3 ? sp.abilities['0'] : '');
      const moves = [...m.moves];
      let hasPhysical = false;
      let hasSpecial = false;
      for (const moveName of moves) {
        const mv = dex.moves.get(moveName);
        if (mv.category === 'Physical') hasPhysical = true;
        else if (mv.category === 'Special') hasSpecial = true;
      }
      let nature = '';
      let evs = {hp: 252, atk: 252, def: 252, spa: 252, spd: 252, spe: 252};
      if (dex.gen >= 3) {
        if (hasPhysical && !hasSpecial) {
          nature = 'Jolly';
          evs = {hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252};
        } else if (hasSpecial && !hasPhysical) {
          nature = 'Timid';
          evs = {hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252};
        } else if (hasPhysical && hasSpecial) {
          nature = 'Naive';
          evs = {hp: 0, atk: 252, def: 0, spa: 4, spd: 0, spe: 252};
        } else {
          nature = 'Timid';
          evs = {hp: 252, atk: 0, def: 4, spa: 0, spd: 0, spe: 252};
        }
      }
      sets.push({
        name: '',
        species: sp.name,
        item: m.item,
        ability,
        moves,
        nature,
        gender: '',
        evs,
        ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
        level: 100,
        ...(dex.gen === 9 ? {teraType: m.teraType} : {}),
      });
    }
    out.push({
      sets,
      elo: elos[side],
      won: winnerName !== undefined && winnerName === names[side],
    });
  }
  return out;
}

export function writeHarvestedPoolFile(filePath: string, packedTeams: readonly string[]) {
  fs.writeFileSync(filePath, `${packedTeams.join('\n')}\n`, 'utf8');
}
