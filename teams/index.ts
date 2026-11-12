/**
 * Tournament Team Uniqueness Checker
 *
 * Given a single candidate team file and a directory of blocklist teams, computes
 * the 1-Nearest-Neighbor (1-NN) distance d_1NN(T, P) = min_{B in P} D(T, B) in [0, 6]
 * against the pool and checks whether it meets the tournament threshold (D >= 1.30).
 *
 * Competitors building a multi-team submission (e.g. 20 teams) can check a
 * candidate team against the pool, add the passing team file into their pool
 * directory, and repeat iteratively for each subsequent team.
 *
 * Usage:
 *   bun index.ts <team-file> <pool-dir...> --format=<format>
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {Dex, ID, ModData, ModdedDex, Nature, StatID, toID} from '@pkmn/dex';
import * as champions from '@pkmn/mods/champions';
import * as championsregmb from '@pkmn/mods/championsregmb';
import {PokemonSet, Team} from '@pkmn/sets';

// Minimum required 1-NN distance D(A, B) in [0, 6] to every team in the blocklist pool.
// Chosen just above the bottom of the IQR (Q1 = 1.20, ~28th percentile) on the initial
// deduplicated 592-team Reg M-C pool (~41st percentile across the expanded 10,108-team
// pool), and sized so that against a 5/6-shared-species neighbor (+1.00), a candidate
// team cannot pass by changing only 1 item (+0.20) or 2 moves (+0.20), requiring at
// least +0.30 in set changes across the shared Pokemon (e.g. 3 moves, or 1 item + 1 move).
export const THRESHOLD = 1.3;

// Maximum distance contributed by two sets of the same canonical species (default/Champions).
// Kept strictly below 1.0 in modern gens so changing a Pokemon species (1.0) outweighs
// overhauling the moves/item/ability/EVs of the same species, while scaling up in early
// gens (Gen 1-2) where small viable pools ("Big 4") mean teams differentiate via movesets,
// and scaling down in high-diversity gens (Gen 6-9 OU) to force greater species creativity.
export const SAME_SPECIES_CAP = 0.8;

const GEN_SPECIES_CAPS: Record<number, number> = {
  1: 1.8, // 1 move = 0.45 -> 3 move diffs across the Big 4 (1.35) passes 1.30 threshold
  2: 1.2, // 1 move = 0.25, 1 item = 0.20 (with wItem = 0.10)
  3: 0.9,
  4: 0.8,
  5: 0.75,
  6: 0.65,
  7: 0.6,
  8: 0.65,
  9: 0.65,
};

// Dedicated lead distance in pre-Team-Preview generations (Gen 1-4), where slot 0
// is fixed on Turn 1.
const GEN_LEAD_BONUS: Record<number, number> = {
  1: 0.45,
  2: 0.25,
  3: 0.2,
  4: 0.2,
};

export function sameSpeciesCap(dex: ModdedDex): number {
  const isChamp = Boolean((dex as {modid?: string}).modid?.startsWith('champions'));
  return isChamp ? SAME_SPECIES_CAP : (GEN_SPECIES_CAPS[dex.gen] ?? SAME_SPECIES_CAP);
}

/**
 * Collapses cosmetic and mechanically identical formes (e.g. Gastrodon-East -> Gastrodon,
 * Keldeo-Resolute -> Keldeo, Sinistcha-Masterpiece -> Sinistcha, Maushold-Four -> Maushold,
 * Greninja-Bond -> Greninja, Toxtricity-Low-Key -> Toxtricity) to their base species ID.
 */
export function canonSpecies(dex: ModdedDex, speciesId?: string): ID {
  if (!speciesId) return toID(speciesId);
  const sp = dex.species.get(speciesId);
  const base = dex.species.get(sp.baseSpecies);
  if (
    base.cosmeticFormes?.includes(sp.name) ||
    sp.id === 'greninjabond' ||
    sp.id === 'toxtricitylowkey' ||
    (STATS.every(st => sp.baseStats[st] === base.baseStats[st]) &&
      sp.types.length === base.types.length &&
      sp.types.every((t, i) => t === base.types[i]) &&
      Object.values(sp.abilities).join('|') === Object.values(base.abilities).join('|'))
  ) {
    return base.id;
  }
  return sp.id;
}

export const STATS: readonly StatID[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

// Abilities that trigger on switch-in / prior to Mega Evolution. If two sets share
// the same species and Mega Stone, differing base abilities only count toward set
// distance when at least one of the two abilities is in this set.
const ENTRY_ABILITIES = new Set([
  'airlock', 'anticipation', 'asoneglastrier', 'asonespectrier', 'cloudnine',
  'curiousmedicine', 'dauntlessshield', 'download', 'drizzle', 'drought',
  'electricterrain', 'electricsurge', 'forewarn', 'frisk', 'grassysurge',
  'hadronengine', 'hospitality', 'imposter', 'intimidate', 'intrepidsword',
  'mistysurge', 'moldbreaker', 'neutralizinggas', 'orichalcumpulse', 'pressure',
  'protosynthesis', 'psychicsurge', 'quarkdrive', 'sandstream', 'screencleaner',
  'snowwarning', 'supersweetsyrup', 'supremeoverlord', 'teravolt', 'trace',
  'turboblaze', 'unnerve',
]);

// Matches `pkmn/teams` content-addressed filenames (`[0-9a-f]{12}`, 48-bit SHA-256 prefix over the
// canonical packed team string).
export const TEAM_HASH_LEN = 12;

export function hashTeam(packedCanonicalTeam: string): string {
  return crypto.createHash('sha256').update(packedCanonicalTeam).digest('hex')
    .slice(0, TEAM_HASH_LEN);
}

const CHAMPIONS_DEX = Dex.mod('champions' as ID, champions as unknown as ModData);
const CHAMPIONS_REGMB_DEX =
  Dex.mod('championsregmb' as ID, championsregmb as unknown as ModData);

/**
 * Initializes the Dex instance for a given format string.
 */
export function getDex(format: string): ModdedDex {
  const id = toID(format);
  if (id.includes('champions')) {
    return id.includes('regmb') ? CHAMPIONS_REGMB_DEX : CHAMPIONS_DEX;
  }
  const genMatch = /^gen(\d)/.exec(id);
  return genMatch ? Dex.forGen(Number(genMatch[1])) : Dex;
}

/**
 * Returns the Mega forme ID if `itemId` is a Mega Stone that Mega Evolves `speciesId`,
 * or `undefined` otherwise.
 */
export function getMegaSpeciesId(
  dex: ModdedDex,
  speciesId?: string,
  itemId?: string
): ID | undefined {
  if (!speciesId || !itemId) return undefined;
  const item = dex.items.get(itemId);
  if (!item.exists || !item.megaStone) return undefined;
  const sp = dex.species.get(speciesId);
  const target = item.megaStone[sp.name];
  return target ? toID(target) : undefined;
}

/**
 * Computes a single real stat at `level` (50 for VGC/Champions, 100 otherwise),
 * accounting for Champions EV scaling (`2 * ev - 1`) vs standard (`floor(ev / 4)`).
 */
function calcStat(
  gen: number,
  stat: StatID,
  base: number,
  iv = 31,
  ev = 0,
  level = 50,
  nature: Nature | undefined = undefined,
  isChamp = true
): number {
  const tr = (n: number, b = 0) => (b ? (n >>> 0) % (2 ** b) : n >>> 0);
  if (gen < 3) {
    iv = Math.floor(iv / 2) * 2;
    nature = undefined;
  }
  const e = isChamp ? Math.max(2 * ev - 1, 0) : tr(ev / 4);
  if (stat === 'hp') {
    return base === 1 ? base : tr((tr(2 * base + iv + e + 100) * level) / 100 + 10);
  }
  const val = tr((tr(2 * base + iv + e) * level) / 100 + 5);
  if (nature?.plus === stat) return tr(tr(val * 110, 16) / 100);
  if (nature?.minus === stat) return tr(tr(val * 90, 16) / 100);
  return val;
}

/**
 * Computes the 6-element relative stat investment vector for `set`:
 *   vec[stat] = (actualStat - uninvestedNeutralStat) / uninvestedNeutralStat
 * Comparing actual computed stats (rather than raw EVs) ensures that 4-EV tweaks,
 * IV + EV compensation tricks, and nature swaps with matching stats are measured
 * by their true mechanical effect.
 */
function getStatVector(
  dex: ModdedDex,
  set: Partial<PokemonSet>,
  defaultLevel = 50
): Record<StatID, number> {
  const sp = dex.species.get(set.species!);
  const nat = dex.gen >= 3 ? dex.natures.get(set.nature || 'serious') : undefined;
  const isChamp = Boolean((dex as {modid?: string}).modid?.startsWith('champions'));
  const level = set.level || defaultLevel;
  const defaultEv = dex.gen < 3 ? 252 : 0;
  const vec = {} as Record<StatID, number>;
  for (const st of STATS) {
    const iv = set.ivs?.[st] ?? 31;
    const ev = set.evs?.[st] ?? defaultEv;
    const actual = calcStat(dex.gen, st, sp.baseStats[st], iv, ev, level, nat, isChamp);
    const base = calcStat(dex.gen, st, sp.baseStats[st], 31, defaultEv, level, undefined, isChamp);
    vec[st] = (actual - base) / base;
  }
  return vec;
}

/**
 * Normalizes functionally equivalent moves so trivial swaps cannot game uniqueness:
 * - Return <-> Frustration -> 'return' as ID
 * - All stalling Protect variants (Protect, Detect, Spiky Shield, Baneful Bunker,
 *   Burning Bulwark, Silk Trap, King's Shield, Obstruct, Max Guard) -> 'protect' as ID
 */
function canonMove(dex: ModdedDex, m: string): ID {
  const id = toID(m);
  if (id === 'frustration') return 'return' as ID;
  const mv = dex.moves.get(id);
  return mv.exists && mv.stallingMove ? ('protect' as ID) : id;
}

/**
 * Computes the distance in [0, sameSpeciesCap(dex)] between two sets of the same canonical species:
 *   - Moves:   weight 0.50
 *   - Item:    weight 0.10 in Gen 2 (Leftovers ubiquity), 0.25 in Gen 3+
 *   - Ability: weight 0.10 (active in Gen 3+, ignores non-entry pre-Mega abilities)
 *   - Stats:   weight 0.15 (active in Gen 3+, with two-tier deadband)
 *   - Tera:    weight 0.10 (active only in standard Gen 9 formats with Terastallization)
 * If a feature does not exist in `dex.gen`, its weight is 0 and the remaining weights renormalize.
 */
export function setDistance(
  dex: ModdedDex,
  a: Partial<PokemonSet>,
  b: Partial<PokemonSet>,
  defaultLevel = 50
): number {
  if (a.species !== b.species) return 1.0;
  const isChamp = Boolean((dex as {modid?: string}).modid?.startsWith('champions'));

  const wMoves = 0.50;
  const wItem = dex.gen === 2 ? 0.10 : dex.gen >= 3 ? 0.25 : 0;
  const wAbil = dex.gen >= 3 ? 0.10 : 0;
  const wStats = dex.gen >= 3 ? 0.15 : 0;
  const wTera = dex.gen === 9 && !isChamp ? 0.10 : 0;
  const totalW = wMoves + wItem + wAbil + wStats + wTera;

  // 1. Moveset distance: fraction of unshared canonicalized moves
  const movesA = new Set((a.moves || []).map(m => canonMove(dex, m)));
  const movesB = new Set((b.moves || []).map(m => canonMove(dex, m)));
  let sharedMoves = 0;
  for (const m of movesA) if (movesB.has(m)) sharedMoves++;
  const dMoves = 1 - sharedMoves / Math.max(movesA.size, movesB.size, 1);

  // 2. Held item distance
  const itemA = toID(a.item);
  const itemB = toID(b.item);
  const dItem = wItem > 0 ? (itemA === itemB ? 0 : 1.0) : 0;

  // 3. Ability distance (ignoring non-entry base abilities when both hold the same Mega Stone)
  let dAbil = 0;
  if (wAbil > 0 && a.ability !== b.ability) {
    const abilA = toID(a.ability);
    const abilB = toID(b.ability);
    const ignoreMegaAbil =
      itemA === itemB &&
      Boolean(getMegaSpeciesId(dex, a.species, itemA)) &&
      !ENTRY_ABILITIES.has(abilA) &&
      !ENTRY_ABILITIES.has(abilB);
    dAbil = ignoreMegaAbil ? 0 : 1.0;
  }

  // 4. Tera Type distance (only for non-Champions Gen 9 formats)
  const dTera = wTera > 0 ? (toID(a.teraType) === toID(b.teraType) ? 0 : 1.0) : 0;

  // 5. Stat distance with two-tier anti-EV-gaming deadband:
  //    - If moves, item, ability, and Tera are all identical, require L1 > 0.30 (a full
  //      role/nature overhaul) before stats contribute any distance.
  //    - Otherwise use a minor-creep deadband of L1 <= 0.08, scaling linearly to 1.0 at L1 = 0.50.
  let dStats = 0;
  if (wStats > 0) {
    const vecA = getStatVector(dex, a, defaultLevel);
    const vecB = getStatVector(dex, b, defaultLevel);
    let statL1 = 0;
    for (const st of STATS) statL1 += Math.abs(vecA[st] - vecB[st]);
    const nonStatDiff = dMoves + dItem + dAbil + dTera;
    const deadband = nonStatDiff === 0 ? 0.30 : 0.08;
    dStats = statL1 <= deadband ? 0 : Math.min(1.0, (statL1 - deadband) / (0.50 - deadband));
  }

  const weighted =
    wMoves * dMoves + wItem * dItem + wAbil * dAbil + wStats * dStats + wTera * dTera;
  return (weighted / totalW) * sameSpeciesCap(dex);
}

/**
 * Computes the total team distance D(A, B) between two canonicalized teams.
 * Every unshared species contributes 1.0; each shared species contributes
 * setDistance(sA, sB) in [0, sameSpeciesCap(dex)]. In pre-Team-Preview generations
 * (Gen 1-4), differing dedicated leads (slot 0) contribute an additional lead distance.
 */
export function teamDistance(
  dex: ModdedDex,
  teamA: Partial<PokemonSet>[],
  teamB: Partial<PokemonSet>[],
  defaultLevel = 50
): number {
  const mapA = new Map(teamA.map(s => [s.species, s]));
  const mapB = new Map(teamB.map(s => [s.species, s]));
  let dist = 0;
  for (const [sp, sA] of mapA) {
    const sB = mapB.get(sp);
    dist += !sB ? 1.0 : setDistance(dex, sA, sB, defaultLevel);
  }
  const leadBonus = GEN_LEAD_BONUS[dex.gen] || 0;
  const leadA = teamA[0]?.species;
  const leadB = teamB[0]?.species;
  if (leadBonus > 0 && leadA && leadB && leadA !== leadB && (mapB.has(leadA) || mapA.has(leadB))) {
    dist += leadBonus;
  }
  return dist;
}

/**
 * Parses a single team (Pokepaste / Showdown export / packed format) from `text`
 * and canonicalizes it via `@pkmn/sets` plus `canonSpecies`.
 */
export function parseTeam(dex: ModdedDex, text: string): Partial<PokemonSet>[] {
  const t = Team.import(text.trim(), dex);
  const sets = Team.canonicalize((t?.team || []).filter(s => s?.moves?.length), dex);
  for (const s of sets) s.species = canonSpecies(dex, s.species);
  return sets;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const flags = args.filter(a => a.startsWith('--'));
  const positional = args.filter(a => !a.startsWith('--'));

  const formatFlag = flags.find(f => f.startsWith('--format='))?.slice('--format='.length);
  const [teamFile, ...blocklistDirs] = positional;

  const format = toID(formatFlag);

  if (!teamFile || !blocklistDirs.length || !format) {
    console.error('Usage: bun index.ts <team-file> <pool-dir...> --format=<format>');
    process.exit(1);
  }

  const dex = getDex(format);
  const defaultLevel =
    format.includes('vgc') || format.includes('bss') || format.includes('champions') ? 50 : 100;

  const candidate = parseTeam(dex, fs.readFileSync(teamFile, 'utf8'));

  let minD = Infinity;
  let closestId = '';
  for (const blocklistDir of blocklistDirs) {
    const blocklistFiles = fs
      .readdirSync(blocklistDir)
      .filter(f => !f.startsWith('.') && f !== 'README.md');
    for (const id of blocklistFiles) {
      const poolTeam = parseTeam(dex, fs.readFileSync(path.join(blocklistDir, id), 'utf8'));
      const d = teamDistance(dex, candidate, poolTeam, defaultLevel);
      if (d < minD) {
        minD = d;
        closestId = id;
      }
    }
  }

  const pass = minD >= THRESHOLD;
  const status = pass ? 'PASS' : 'FAIL';
  const name = path.basename(teamFile);
  const dStr = `distance=${minD.toFixed(3)}`;
  console.log(
    `${status} ${name}: ${dStr} (threshold=${THRESHOLD.toFixed(2)}, closest=${closestId})`
  );
  process.exit(pass ? 0 : 1);
}

export {toID};
