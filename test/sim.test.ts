import * as fs from 'fs';
import {DatabaseSync} from 'node:sqlite';
import * as os from 'os';
import * as path from 'path';

import {Database} from '../db';
import {LADDERS_FILE, SIM_VERSION, parseLaddersYaml} from '../db/ladders';
import * as sim from '../server/sim';
import {root} from '../static/util';

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
});
