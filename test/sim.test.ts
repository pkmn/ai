import * as fs from 'fs';
import {DatabaseSync} from 'node:sqlite';
import * as os from 'os';
import * as path from 'path';

import {Database} from '../db';
import {LADDERS_FILE, SIM_VERSION, parseLaddersYaml} from '../db/ladders';
import * as sim from '../server/sim';
import * as teams from '../server/teams';
import {root} from '../static/util';
import {runPkmnCli} from '../tools/pkmn';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

afterAll(async () => {
  await sim.closeAllWorkers();
});

describe('multi-version @pkmn/sim support', () => {
  test('config/ladders.yml defaults version to 0.11.0 and db/ladders syncs + rotates it', () => {
    const raw = fs.readFileSync(LADDERS_FILE, 'utf8');
    const parsed = parseLaddersYaml(raw);
    expect(parsed.length).toBeGreaterThan(0);
    for (const entry of parsed) {
      expect(entry.version).toBe(SIM_VERSION);
    }

    expect(() => parseLaddersYaml(`
- name: RBY
  format: gen1ou
  version: ../bad
  id: gen1ou20261109
  team: harvested
`)).toThrow(/Invalid version/);

    const db = new Database(':memory:');
    try {
      db.syncLadders(LADDERS_FILE, 1_760_000_000);
      const vgc = db.getLadder('gen9championsvgc2026regmc');
      expect(vgc?.version).toBe('0.11.0');

      const rotated = db.rotateLadder({
        oldLadderId: 'gen9championsvgc2026regmc',
        archivedName: 'VGC Reg M-C',
        next: {
          id: 'gen9championsvgc2026regmd',
          format: 'gen9championsvgc2026regmd',
          version: '0.12.0',
        },
        now: 1_760_000_100,
      });
      expect(rotated.oldLadder.version).toBe('0.11.0');
      expect(rotated.newLadder?.version).toBe('0.12.0');
    } finally {
      db.close();
    }
  });

  test('0001-sim-version.sql migrates existing ladders and tournaments tables', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-sim-mig-'));
    tempDirs.push(tmpDir);
    const dbPath = path.join(tmpDir, 'legacy.sqlite');

    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      CREATE TABLE ladders (
        id TEXT PRIMARY KEY,
        slot TEXT NOT NULL,
        name TEXT NOT NULL,
        format TEXT NOT NULL,
        team TEXT NOT NULL,
        min INTEGER NOT NULL,
        teams INTEGER,
        discord TEXT,
        status TEXT NOT NULL DEFAULT 'upcoming',
        created_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE TABLE tournaments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        format TEXT NOT NULL,
        team TEXT,
        rules_json TEXT NOT NULL DEFAULT '[]',
        games_per_matchup INTEGER NOT NULL,
        batch_size INTEGER NOT NULL DEFAULT 10,
        parallel_tables INTEGER NOT NULL,
        hardware TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled',
        starts_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      INSERT INTO ladders (id, slot, name, format, team, min, status, created_at)
      VALUES ('gen1ou20261109', 'rby', 'RBY', 'gen1ou', 'harvested', 2, 'active', 1760000000);
    `);
    rawDb.close();

    const migDir = path.join(tmpDir, 'migration');
    fs.mkdirSync(migDir, {recursive: true});
    fs.copyFileSync(
      root('db', 'migration', '0001-sim-version.sql'),
      path.join(migDir, '0001-sim-version.sql')
    );

    const db = new Database(dbPath, {backupBeforeMigrate: false, migrationDir: migDir});
    try {
      expect(db.getLadder('gen1ou20261109')?.version).toBe(SIM_VERSION);
    } finally {
      db.close();
    }
  });

  test('runs isolated workers concurrently for different @pkmn/sim directories', async () => {
    const testSimDir = root('sim', '0.99.0-test');
    tempDirs.push(testSimDir);
    const simPkgDir = path.join(testSimDir, 'node_modules', '@pkmn', 'sim');
    fs.mkdirSync(simPkgDir, {recursive: true});
    fs.writeFileSync(path.join(testSimDir, 'package.json'), JSON.stringify({name: 'sim-test'}));
    fs.writeFileSync(
      path.join(simPkgDir, 'package.json'),
      JSON.stringify({name: '@pkmn/sim', version: '0.99.0-test', main: 'index.js'})
    );
    fs.writeFileSync(
      path.join(simPkgDir, 'index.js'),
      [
        'exports.Dex = {',
        '  mod() {},',
        '  formats: { extend() {}, get(id) { return {exists: true, id, team: false}; } },',
        '};',
        'exports.Teams = {',
        '  setGeneratorFactory() {},',
        '  generate() { return []; },',
        '  pack() { return ""; },',
        '};',
        'exports.BattleStreams = { BattleStream: class {}, getPlayerStreams() { return {}; } };',
      ].join('\n')
    );

    const [defaultVer, customVer] = await Promise.all([
      sim.getWorkerSimVersion(SIM_VERSION),
      sim.getWorkerSimVersion('0.99.0-test'),
    ]);
    expect(defaultVer).toBe(SIM_VERSION);
    expect(customVer).toBe('0.99.0-test');

    const resolved = await sim.resolveArenaFormatId('gen9ou', SIM_VERSION);
    expect(resolved).toBe('gen9ou');
  });

  test('validateTeam resolves formats containing custom rules after @@@', async () => {
    const ouTeam =
      'Pikachu||lightball|static|thunderbolt,surf,voltswitch,protect|Timid|,,4,252,,252|||||';
    const ouRes = await sim.validateTeam('gen9ou@@@Force Open Team Sheets', ouTeam, SIM_VERSION);
    expect(ouRes.problems).toBeUndefined();
    expect(ouRes.packed).toBeTruthy();

    const vgcFormat = await sim.resolveArenaFormatId(
      'gen9championsvgc2026regmc@@@Open Team Sheets,Best of = 3',
      SIM_VERSION
    );
    expect(vgcFormat).toContain('@@@');
    const vgcRes = await sim.validateTeam(vgcFormat, ouTeam, SIM_VERSION);
    expect(vgcRes.problems).toBeDefined();
  });

  test('pkmn install-sim runs before opening the central SQLite database', async () => {
    await expect(runPkmnCli(['install-sim'])).rejects.toThrow(/Usage: pkmn install-sim/);
  });

  function installCustomFormatSim(version: string, formatName: string) {
    const testSimDir = root('sim', version);
    tempDirs.push(testSimDir);
    const simPkgDir = path.join(testSimDir, 'node_modules', '@pkmn', 'sim');
    fs.mkdirSync(simPkgDir, {recursive: true});
    fs.writeFileSync(path.join(testSimDir, 'package.json'), JSON.stringify({name: 'sim-custom'}));
    fs.writeFileSync(
      path.join(simPkgDir, 'package.json'),
      JSON.stringify({name: '@pkmn/sim', version, main: 'index.js'})
    );
    const rootSimEntry = JSON.stringify(root('node_modules', '@pkmn', 'sim'));
    fs.writeFileSync(
      path.join(simPkgDir, 'index.js'),
      [
        `const realSim = require(${rootSimEntry});`,
        `realSim.Dex.formats.extend([{name: ${JSON.stringify(formatName)}, mod: 'gen9', ` +
          "ruleset: ['Standard']}]);",
        'module.exports = realSim;',
      ].join('\n')
    );
  }

  const SAMPLE_TEAM_A = [
    'Zapdos @ Heavy-Duty Boots',
    'Ability: Static',
    'EVs: 252 HP / 252 Def / 4 Spe',
    'Bold Nature',
    '- Volt Switch',
    '- Roost',
    '- Hurricane',
    '- Discharge',
    '',
    'Alomomola @ Heavy-Duty Boots',
    'Ability: Regenerator',
    'EVs: 252 HP / 252 Def / 4 SpD',
    'Impish Nature',
    '- Wish',
    '- Protect',
    '- Flip Turn',
    '- Scald',
    '',
    'Blissey @ Heavy-Duty Boots',
    'Ability: Natural Cure',
    'EVs: 252 HP / 252 Def / 4 SpD',
    'Bold Nature',
    '- Soft-Boiled',
    '- Seismic Toss',
    '- Stealth Rock',
    '- Calm Mind',
    '',
    'Clefable @ Leftovers',
    'Ability: Magic Guard',
    'EVs: 252 HP / 252 Def / 4 SpD',
    'Bold Nature',
    '- Moonblast',
    '- Moonlight',
    '- Stealth Rock',
    '- Knock Off',
    '',
    'Dondozo @ Leftovers',
    'Ability: Unaware',
    'EVs: 252 HP / 252 Def / 4 SpD',
    'Impish Nature',
    '- Waterfall',
    '- Rest',
    '- Sleep Talk',
    '- Curse',
    '',
    'Garganacl @ Leftovers',
    'Ability: Purifying Salt',
    'EVs: 252 HP / 4 Def / 252 SpD',
    'Careful Nature',
    '- Salt Cure',
    '- Recover',
    '- Protect',
    '- Iron Defense',
  ].join('\n');

  const SAMPLE_TEAM_B = [
    'Tyranitar @ Smooth Rock',
    'Ability: Sand Stream',
    'EVs: 252 HP / 4 Def / 252 SpD',
    'Careful Nature',
    '- Knock Off',
    '- Stone Edge',
    '- Stealth Rock',
    '- Thunder Wave',
    '',
    'Excadrill @ Leftovers',
    'Ability: Sand Rush',
    'EVs: 252 Atk / 4 SpD / 252 Spe',
    'Jolly Nature',
    '- Earthquake',
    '- Iron Head',
    '- Rapid Spin',
    '- Swords Dance',
    '',
    'Corviknight @ Rocky Helmet',
    'Ability: Pressure',
    'EVs: 252 HP / 252 Def / 4 SpD',
    'Impish Nature',
    '- Brave Bird',
    '- Roost',
    '- Defog',
    '- U-turn',
    '',
    'Slowking-Galar @ Heavy-Duty Boots',
    'Ability: Regenerator',
    'EVs: 252 HP / 4 Def / 252 SpD',
    'Sassy Nature',
    '- Future Sight',
    '- Sludge Bomb',
    '- Chilly Reception',
    '- Flamethrower',
    '',
    'Dragapult @ Choice Specs',
    'Ability: Infiltrator',
    'EVs: 252 SpA / 4 SpD / 252 Spe',
    'Timid Nature',
    '- Draco Meteor',
    '- Shadow Ball',
    '- Flamethrower',
    '- U-turn',
    '',
    'Kingambit @ Black Glasses',
    'Ability: Supreme Overlord',
    'EVs: 252 Atk / 4 Def / 252 Spe',
    'Adamant Nature',
    '- Sucker Punch',
    '- Kowtow Cleave',
    '- Iron Head',
    '- Swords Dance',
  ].join('\n');

  test('validateCompetitorTeamsIncrementalForVersion validates custom worker formats', async () => {
    installCustomFormatSim('0.99.1-custom', '[Gen 9] Future OU');
    const first = await teams.validateCompetitorTeamsIncrementalForVersion(
      SAMPLE_TEAM_A,
      {format: 'gen9futureou', pools: [], teams: 2},
      [],
      '0.99.1-custom'
    );
    expect(first.rejections).toEqual([]);
    expect(first.newlySavedCount).toBe(1);
    expect(first.allSaved).toHaveLength(1);
    // Canonicalized order puts Alomomola first (sorted alphabetically for Gen 5+)
    expect(first.allSaved[0].startsWith('alomomola|')).toBe(true);

    // Re-pasting the same uncanonicalized export matches the saved canonical packed team
    const second = await teams.validateCompetitorTeamsIncrementalForVersion(
      `${SAMPLE_TEAM_A}\n\n===\n\n${SAMPLE_TEAM_B}`,
      {format: 'gen9futureou', pools: [], teams: 2},
      first.allSaved,
      '0.99.1-custom'
    );
    expect(second.rejections).toEqual([]);
    expect(second.newlySavedCount).toBe(1);
    expect(second.complete).toBe(true);
  });

  test('pkmn upload-ladder-teams validates harvested teams against ladder version', async () => {
    installCustomFormatSim('0.99.2-custom', '[Gen 9] Harvest Future');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-harvest-ver-'));
    tempDirs.push(tmpDir);
    const teamsFile = path.join(tmpDir, 'teams.txt');
    fs.writeFileSync(teamsFile, `=== [gen9harvestfuture] A ===\n\n${SAMPLE_TEAM_A}\n\n` +
      `=== [gen9harvestfuture] B ===\n\n${SAMPLE_TEAM_B}\n`);

    const db = new Database(':memory:');
    try {
      db.syncLadders(LADDERS_FILE, 1_760_000_000);
      db.rotateLadder({
        oldLadderId: 'gen9ou20261109',
        archivedName: 'SV Old',
        next: {
          id: 'gen9harvestfuture20261109',
          format: 'gen9harvestfuture',
          version: '0.99.2-custom',
          team: 'harvested',
        },
        now: 1_760_000_100,
      });
      await runPkmnCli(['upload-ladder-teams', 'gen9harvestfuture20261109', teamsFile], {
        db,
        log: () => undefined,
      });
      const stored = db.getLadderTeams('gen9harvestfuture20261109');
      expect(stored).toHaveLength(2);
      expect(stored[0].startsWith('alomomola|')).toBe(true);
    } finally {
      db.close();
    }
  });
});
