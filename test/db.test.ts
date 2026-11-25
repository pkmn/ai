import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {Teams} from '@pkmn/sim';

import * as database from '../db';
import * as arena from '../server/arena';
import * as smogon from '../server/smogon';
import {validateHarvestedTeams} from '../server/teams';
import {root, validateAgentName, validateVersion} from '../static/util';
import {generateValidHarvestedTeams, generateValidVgcTeams} from '../tools/mock';
import {runPkmnCli} from '../tools/pkmn';

import {compareDatabaseSchemas} from './schema-helpers';

describe('schema migrations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-migration-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  function createMigrationFixture() {
    const schemaDir = path.join(tmpDir, 'schema');
    const migrationDir = path.join(tmpDir, 'migration');
    fs.mkdirSync(schemaDir, {recursive: true});
    fs.mkdirSync(migrationDir, {recursive: true});

    fs.writeFileSync(path.join(schemaDir, 'items.sql'), `
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL
      );
    `);
    fs.writeFileSync(path.join(schemaDir, 'refs.sql'), `
      CREATE TABLE IF NOT EXISTS refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES items(id)
      );
    `);

    const dbFile = path.join(tmpDir, 'test.sqlite');
    const db1 = new database.Database(dbFile, {schemaDir, migrationDir, now: 1000});
    db1.db.exec(
      "INSERT INTO items (id, name) VALUES (1, 'alpha'); INSERT INTO refs VALUES (10, 1);"
    );
    db1.close();

    fs.writeFileSync(
      path.join(migrationDir, '0001-add-tag.sql'),
      "ALTER TABLE items ADD COLUMN tag TEXT NOT NULL DEFAULT 'v1';"
    );
    fs.writeFileSync(
      path.join(migrationDir, '0002-rebuild-items.sql'),
      `
      CREATE TABLE items_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        tag TEXT NOT NULL DEFAULT 'v1'
      );
      INSERT INTO items_new (id, name, tag) SELECT id, name, tag FROM items;
      DROP TABLE items;
      ALTER TABLE items_new RENAME TO items;
      CREATE INDEX idx_items_tag ON items(tag);
      `
    );
    fs.writeFileSync(path.join(schemaDir, 'items.sql'), `
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        tag TEXT NOT NULL DEFAULT 'v1'
      );
      CREATE INDEX IF NOT EXISTS idx_items_tag ON items(tag);
    `);

    return {dbFile, schemaDir, migrationDir};
  }

  test('loads individual .sql table definitions from db/schema/', () => {
    const schemaFiles = fs.readdirSync(database.SCHEMA_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();
    expect(schemaFiles).toEqual([
      'agent-ladder-stats.sql',
      'agent-ladder-teams.sql',
      'agent-ladders.sql',
      'agent-versions.sql',
      'agents.sql',
      'config.sql',
      'developers.sql',
      'discord-members.sql',
      'discord-watches.sql',
      'ladder-entries.sql',
      'ladder-teams.sql',
      'ladders.sql',
      'matches.sql',
      'pair-aggregates.sql',
      'rating-snapshots.sql',
      'schema-migrations.sql',
      'smoke-diagnostics.sql',
      'tournament-entrants.sql',
      'tournament-games.sql',
      'tournament-matches.sql',
      'tournaments.sql',
    ]);

    const db = new database.Database(':memory:');
    try {
      const tables = db.db.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name ASC`
      ).all() as Array<{name: string}>;
      const expectedTables = schemaFiles
        .map(f => f.replace(/\.sql$/, '').replace(/-/g, '_'))
        .sort();
      expect(tables.map(t => t.name)).toEqual(expectedTables);
    } finally {
      db.close();
    }
  });

  test('applies sequential migrations with pre-migration backup files', () => {
    const {dbFile, schemaDir, migrationDir} = createMigrationFixture();
    const db = new database.Database(dbFile, {schemaDir, migrationDir, now: 2000});
    try {
      expect(fs.existsSync(`${dbFile}.pre-0001-add-tag.bak`)).toBe(true);
      expect(db.getAppliedMigrations()).toEqual([
        {version: '0001-add-tag.sql', appliedAt: 2000},
        {version: '0002-rebuild-items.sql', appliedAt: 2000},
      ]);
      expect(db.db.prepare('SELECT id, name, tag FROM items WHERE id = 1').get()).toEqual({
        id: 1,
        name: 'alpha',
        tag: 'v1',
      });
    } finally {
      db.close();
    }
  });

  test('marks existing migrations applied on fresh databases without running ALTER', () => {
    const {schemaDir, migrationDir} = createMigrationFixture();
    const freshDb = new database.Database(':memory:', {schemaDir, migrationDir, now: 3000});
    try {
      expect(freshDb.getAppliedMigrations()).toEqual([
        {version: '0001-add-tag.sql', appliedAt: 3000},
        {version: '0002-rebuild-items.sql', appliedAt: 3000},
      ]);
    } finally {
      freshDb.close();
    }
  });

  test('rolls back migrations that violate foreign-key integrity', () => {
    const {dbFile, schemaDir, migrationDir} = createMigrationFixture();
    const db2 = new database.Database(dbFile, {schemaDir, migrationDir, now: 2000});
    db2.close();

    fs.writeFileSync(
      path.join(migrationDir, '0003-break-fk.sql'),
      'DELETE FROM items WHERE id = 1;'
    );
    expect(() => new database.Database(dbFile, {schemaDir, migrationDir, now: 4000}))
      .toThrow(/Foreign key check failed in migration "0003-break-fk.sql"/);

    fs.rmSync(path.join(migrationDir, '0003-break-fk.sql'));
    const db3 = new database.Database(dbFile, {schemaDir, migrationDir, now: 5000});
    try {
      expect(db3.db.prepare('SELECT name FROM items WHERE id = 1').get()).toEqual({name: 'alpha'});
      expect(db3.getAppliedMigrations().map(m => m.version)).toEqual([
        '0001-add-tag.sql',
        '0002-rebuild-items.sql',
      ]);
    } finally {
      db3.close();
    }
  });

  test('rolls back inner SAVEPOINT failures while preserving outer transaction writes', () => {
    const db = new database.Database(':memory:');
    try {
      db.syncProjectsFromYaml(`
- name: Good Proj
  active: 2026
  arena:
    owners:
      goodgh: good.777
`, undefined, 1_760_000_000);
      db.inTransaction(() => {
        db.refundCooldown('good-proj', 1_760_000_200);
        expect(() => db.inTransaction(() => {
          db.refundCooldown('good-proj', 1_760_000_999);
          throw new Error('abort inner');
        })).toThrow('abort inner');
      });
      expect(db.getAgentBySlug('good-proj')?.cooldownRefundedAt).toBe(1_760_000_200);
    } finally {
      db.close();
    }
  });

  test('classifyMigrationSql distinguishes additive from destructive statements', () => {
    expect(database.classifyMigrationSql(`
      -- Add column and index
      ALTER TABLE items ADD COLUMN tag TEXT NOT NULL DEFAULT 'v1';
      CREATE INDEX idx_items_tag ON items(tag);
    `)).toBe('additive');

    expect(database.classifyMigrationSql(`
      DROP INDEX IF EXISTS idx_items_tag;
      ALTER TABLE items DROP COLUMN tag;
    `)).toBe('destructive');
  });

  test('classifyMigrationSql recognizes SQLite four-step table rebuild as destructive', () => {
    expect(database.classifyMigrationSql(`
      CREATE TABLE items_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      );
      INSERT INTO items_new (id, name) SELECT id, name FROM items;
      DROP TABLE items;
      ALTER TABLE items_new RENAME TO items;
      CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);
    `)).toBe('destructive');
  });

  test('classifyMigrationSql flags combined additive with destructive changes as mixed', () => {
    expect(database.classifyMigrationSql(`
      ALTER TABLE items ADD COLUMN extra TEXT;
      DROP TABLE old_items;
    `)).toBe('mixed');
  });

  test('compareDatabaseSchemas verifies migrated database matches declarative schema', () => {
    const schemaDir = path.join(tmpDir, 'schema-eq');
    const migrationDir = path.join(tmpDir, 'migration-eq');
    fs.mkdirSync(schemaDir, {recursive: true});
    fs.mkdirSync(migrationDir, {recursive: true});

    fs.writeFileSync(path.join(schemaDir, 'items.sql'), `
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL
      );
    `);
    const migratedFile = path.join(tmpDir, 'migrated.sqlite');
    const dbInit = new database.Database(migratedFile, {schemaDir, migrationDir, now: 1000});
    dbInit.close();

    fs.writeFileSync(
      path.join(migrationDir, '0001-add-tag.sql'),
      "ALTER TABLE items ADD COLUMN tag TEXT NOT NULL DEFAULT 'v1';"
    );
    fs.writeFileSync(path.join(schemaDir, 'items.sql'), `
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        tag TEXT NOT NULL DEFAULT 'v1'
      );
    `);

    const migratedDb = new database.Database(migratedFile, {schemaDir, migrationDir, now: 2000});
    const freshDb = new database.Database(':memory:', {schemaDir, migrationDir, now: 2000});
    try {
      expect(compareDatabaseSchemas(migratedDb.db, freshDb.db)).toEqual([]);
    } finally {
      migratedDb.close();
      freshDb.close();
    }
  });

  test('pkmn.ai-server.service sets UMask=0027 so nginx group pkmn can serve written files', () => {
    const unit = fs.readFileSync(root('config', 'pkmn.ai-server.service'), 'utf8');
    expect(unit).toContain('UMask=0027');
  });

  test('migration VACUUM INTO backup restricts permissions to 0600', () => {
    const schemaDir = path.join(tmpDir, 'schema-mode');
    const migrationDir = path.join(tmpDir, 'migration-mode');
    fs.mkdirSync(schemaDir, {recursive: true});
    fs.mkdirSync(migrationDir, {recursive: true});
    fs.writeFileSync(
      path.join(schemaDir, 'items.sql'),
      'CREATE TABLE items (id INTEGER PRIMARY KEY);'
    );

    const dbFile = path.join(tmpDir, 'mode.sqlite');
    const initial = new database.Database(dbFile, {schemaDir, migrationDir, now: 1000});
    initial.close();
    expect(fs.statSync(dbFile).mode & 0o777).toBe(0o600);

    fs.writeFileSync(
      path.join(migrationDir, '0001-add-note.sql'),
      'ALTER TABLE items ADD COLUMN note TEXT;'
    );
    const migrated = new database.Database(dbFile, {schemaDir, migrationDir, now: 2000});
    migrated.close();
    const bakFile = `${dbFile}.pre-0001-add-note.bak`;
    expect(fs.statSync(bakFile).mode & 0o777).toBe(0o600);
  });

  test('compareDatabaseSchemas detects missing indexes across databases', () => {
    const schemaDirA = path.join(tmpDir, 'schema-idx-a');
    const schemaDirB = path.join(tmpDir, 'schema-idx-b');
    const migrationDir = path.join(tmpDir, 'migration-idx');
    fs.mkdirSync(schemaDirA, {recursive: true});
    fs.mkdirSync(schemaDirB, {recursive: true});
    fs.mkdirSync(migrationDir, {recursive: true});

    fs.writeFileSync(path.join(schemaDirA, 'items.sql'), `
      CREATE TABLE items (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('open', 'closed'))
      );
      CREATE INDEX idx_items_status ON items(status DESC);
    `);
    fs.writeFileSync(path.join(schemaDirB, 'items.sql'), `
      CREATE TABLE items (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('open', 'closed'))
      );
    `);

    const dbA = new database.Database(':memory:', {schemaDir: schemaDirA, migrationDir});
    const dbB = new database.Database(':memory:', {schemaDir: schemaDirB, migrationDir});
    try {
      expect(compareDatabaseSchemas(dbA.db, dbB.db).length).toBeGreaterThan(0);
    } finally {
      dbA.close();
      dbB.close();
    }
  });
});

describe('competitor saved teams lifecycle', () => {
  let db: database.Database;

  beforeEach(() => {
    db = new database.Database(':memory:');
    db.syncLadders(database.LADDERS_FILE, 1_760_000_000);
    db.syncProjectsFromYaml(`
      - name: 0 ERROR
        active: 2026
        arena:
          owners:
            pre: pre.10544
    `, undefined, 1_760_000_000);
    db.setAgentLadders('0-error', database.ALL_SLOTS, 1_760_000_000);
  });

  afterEach(() => {
    db.close();
  });

  test('replaces or clears saved teams on a pools ladder', () => {
    const agent = db.getAgentBySlug('0-error')!;
    db.replaceSavedTeams(
      'gen9championsvgc2026regmc',
      agent.id,
      ['t1', 't2', 't3'],
      1_760_000_010
    );
    expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'saved')).toEqual([
      't1', 't2', 't3',
    ]);

    db.clearSavedTeams('gen9championsvgc2026regmc', agent.id);
    expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'saved')).toEqual([]);
  });

  test('promotes saved teams to pending on submission then purges on smoke failure', () => {
    const agent = db.getAgentBySlug('0-error')!;
    const dev = db.getDeveloperByGitHub('pre')!;
    db.replaceSavedTeams('gen9championsvgc2026regmc', agent.id, ['s1', 's2'], 1_760_000_020);

    const created = db.createSubmission({
      agentId: agent.id,
      developerId: dev.id,
      version: '1.0.0',
      package: 'oci',
      url: 'ghcr.io/pkmn/0-error:1.0.0',
      sha256: 'a'.repeat(64),
      ladderIds: ['gen9championsvgc2026regmc'],
      teamsByLadder: {gen9championsvgc2026regmc: ['p1', 'p2', 'p3']},
      now: 1_760_000_030,
    });

    expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'saved')).toEqual([]);
    expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'pending')).toEqual([
      'p1', 'p2', 'p3',
    ]);

    db.applySubmissionStatus({
      versionId: created.id,
      smokeStatus: 'failed',
      smokeError: 'boom',
      now: 1_760_000_040,
    });
    expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id)).toEqual([]);
  });
});

describe('ladders configuration', () => {
  test('syncs canonical config/ladders.yml with inferred slots', () => {
    const db = new database.Database(':memory:');
    try {
      db.syncLadders(database.LADDERS_FILE, 1_760_000_000);
      expect(db.getActiveLadders()).toEqual([]);
      expect(db.getCurrentLadders().map(l => ({
        id: l.id,
        slot: l.slot,
        name: l.name,
        format: l.format,
        team: l.team,
        min: l.min,
        discord: l.discord,
        status: l.status,
      }))).toEqual([
        {
          id: 'gen1ou20261109',
          slot: 'rby',
          name: 'RBY',
          format: 'gen1ou',
          team: 'harvested',
          min: 2,
          discord: '1563716887131459685',
          status: 'upcoming',
        },
        {
          id: 'gen3ou20261109',
          slot: 'adv',
          name: 'ADV',
          format: 'gen3ou',
          team: 'harvested',
          min: 2,
          discord: '1563717163481825472',
          status: 'upcoming',
        },
        {
          id: 'gen9ou20261109',
          slot: 'sv',
          name: 'SV',
          format: 'gen9ou',
          team: 'harvested',
          min: 2,
          discord: '1563717708720377977',
          status: 'upcoming',
        },
        {
          id: 'gen9randombattle20261109',
          slot: 'rand',
          name: 'RAND',
          format: 'gen9randombattle',
          team: 'random',
          min: 2,
          discord: '1563718027994992752',
          status: 'upcoming',
        },
        {
          id: 'gen9championsvgc2026regmc',
          slot: 'vgc',
          name: 'VGC',
          format: 'gen9championsvgc2026regmc',
          team: 'pools',
          min: 4,
          discord: '1564121375558340768',
          status: 'upcoming',
        },
      ]);
    } finally {
      db.close();
    }
  });

  test('rejects pools ladders missing a positive teams count', () => {
    expect(() => database.parseLaddersYaml(`
- name: VGC
  format: gen9championsvgc2026regmc
  version: '0.11.0'
  id: gen9championsvgc2026regmc
  team: pools
  status: active
`)).toThrow(/must specify a positive teams count/);
  });

  test('derives minimum active agents strictly from team mode (4 for pools, 2 otherwise)', () => {
    const db = new database.Database(':memory:');
    try {
      db.syncLaddersFromYaml(`
- name: VGC
  format: gen9championsvgc2026regmc
  id: gen9championsvgc2026regmc
  team: pools
  status: active
  teams: 20
- name: RBY
  format: gen1ou
  id: gen1ou20261109
  team: harvested
  status: active
- name: RAND
  format: gen9randombattle
  id: gen9randombattle20261109
  team: random
  status: active
`, 1_760_000_000);
      expect(db.getLadder('gen9championsvgc2026regmc')?.min).toBe(4);
      expect(db.getLadder('gen1ou20261109')?.min).toBe(2);
      expect(db.getLadder('gen9randombattle20261109')?.min).toBe(2);
    } finally {
      db.close();
    }
  });

  test('rejects multiple current ladders sharing the same slot', () => {
    expect(() => database.parseLaddersYaml(`
- name: VGC
  format: gen9championsvgc2026regmc
  version: '0.11.0'
  id: gen9championsvgc2026regmc
  team: pools
  status: active
  teams: 20
- name: VGC
  format: gen9championsvgc2026regmd
  version: '0.11.0'
  id: gen9championsvgc2026regmd
  team: pools
  status: active
  teams: 20
`)).toThrow(/Multiple current ladders configured for slot "vgc"/);
  });

  test('syncs archived seasons alongside active slot replacements', () => {
    const db = new database.Database(':memory:');
    try {
      db.syncLaddersFromYaml(`
- name: VGC 2026 Reg M-C
  format: gen9championsvgc2026regmc
  version: '0.11.0'
  id: gen9championsvgc2026regmc
  team: pools
  status: archived
  teams: 20
- name: VGC
  format: gen9championsvgc2026regmd
  version: '0.11.0'
  id: gen9championsvgc2026regmd
  team: pools
  status: active
  teams: 20
`, 1_765_000_000);

      const currentVgc = db.getActiveLadderBySlot('vgc')!;
      expect(currentVgc.id).toBe('gen9championsvgc2026regmd');
      expect(currentVgc.teams).toBe(20);
      const old = db.getLadder('gen9championsvgc2026regmc')!;
      expect(old.slot).toBe('vgc');
      expect(old.status).toBe('archived');
      expect(old.name).toBe('VGC 2026 Reg M-C');
      expect(old.archivedAt).toBe(1_765_000_000);
    } finally {
      db.close();
    }
  });

  test('preserves rotated archived ladder titles across subsequent YAML syncs', () => {
    const db = new database.Database(':memory:');
    try {
      const laddersYaml = `
- name: VGC
  format: gen9championsvgc2026regmc
  version: '0.11.0'
  id: gen9championsvgc2026regmc
  team: pools
  teams: 20
  status: active
  min: 4
`;
      db.syncLaddersFromYaml(laddersYaml, 1_760_000_000);
      db.rotateLadder({
        oldLadderId: 'gen9championsvgc2026regmc',
        archivedName: 'VGC 2026 Reg M-C',
        next: {id: 'gen9championsvgc2026regmd'},
        now: 1_765_000_000,
      });
      db.syncLaddersFromYaml(laddersYaml, 1_766_000_000);
      const oldVgc = db.getLadder('gen9championsvgc2026regmc')!;
      expect(oldVgc.name).toBe('VGC 2026 Reg M-C');
      expect(oldVgc.status).toBe('archived');
      expect(oldVgc.archivedAt).toBe(1_765_000_000);
    } finally {
      db.close();
    }
  });

  test('derives min agents automatically from team mode when rotating ladders', () => {
    const db = new database.Database(':memory:');
    try {
      db.syncLaddersFromYaml(`
- name: VGC
  format: gen9championsvgc2026regmc
  id: gen9championsvgc2026regmc
  team: pools
  teams: 20
  status: active
`, 1_760_000_000);
      expect(db.getLadder('gen9championsvgc2026regmc')!.version).toBe('0.11.0');
      expect(db.getLadder('gen9championsvgc2026regmc')!.min).toBe(4);
      const rotated = db.rotateLadder({
        oldLadderId: 'gen9championsvgc2026regmc',
        archivedName: 'VGC 2026 Reg M-C',
        next: {id: 'gen9championsvgc2026regmd'},
        now: 1_765_000_000,
      });
      expect(rotated.newLadder!.min).toBe(4);
    } finally {
      db.close();
    }
  });

  function seedTwoProjectsWithFourActiveVersions(db: database.Database) {
    db.syncLaddersFromYaml(`
- name: VGC
  format: gen9championsvgc2026regmc
  version: '0.11.0'
  id: gen9championsvgc2026regmc
  team: pools
  status: active
  min: 4
  teams: 20
`, 1_760_000_000);
    db.syncProjectsFromYaml(`
- name: 0 ERROR
  active: 2026
  arena:
    owners:
      pre: pre.10544
- name: Foul Play
  active: 2026
  arena:
    owners:
      pmariglia: pmariglia.100001
`, undefined, 1_760_000_000);
    db.setAgentLadders('0-error', database.ALL_SLOTS, 1_760_000_000);
    db.setAgentLadders('foul-play', database.ALL_SLOTS, 1_760_000_000);

    const zero = db.getAgentBySlug('0-error')!;
    const fp = db.getAgentBySlug('foul-play')!;
    const ladderId = 'gen9championsvgc2026regmc';
    const dummyTeams = Array.from({length: 20}, (_, i) => `Pikachu|||static|||||||]${i}`);

    let seq = 1;
    for (const agent of [zero, fp]) {
      const sub1 = db.createSubmission({
        agentId: agent.id,
        version: '1.0.0',
        package: 'bundle',
        url: `https://github.com/pkmn/${agent.slug}-1.0.0.tar.zst`,
        sha256: String(seq++).padStart(64, '0'),
        ladderIds: [ladderId],
        teamsByLadder: {[ladderId]: dummyTeams},
        now: 1_760_000_000 + seq * 1000,
      });
      db.applySubmissionStatus({
        versionId: sub1.id,
        smokeStatus: 'passed',
        now: 1_760_000_010 + seq * 1000,
      });
      db.quarantineVersion(
        agent.slug,
        '1.0.0',
        'Transient infra glitch',
        1_760_000_020 + seq * 1000
      );
      db.refundCooldown(agent.slug, 1_760_000_025 + seq * 1000);
      const sub2 = db.createSubmission({
        agentId: agent.id,
        version: '1.1.0',
        package: 'bundle',
        url: `https://github.com/pkmn/${agent.slug}-1.1.0.tar.zst`,
        sha256: String(seq++).padStart(64, '0'),
        ladderIds: [ladderId],
        now: 1_760_000_030 + seq * 1000,
      });
      db.applySubmissionStatus({
        versionId: sub2.id,
        smokeStatus: 'passed',
        now: 1_760_000_040 + seq * 1000,
      });
      db.unquarantineVersion(agent.slug, '1.0.0', 1_760_000_050 + seq * 1000);
    }
    return ladderId;
  }

  test('counts distinct active projects rather than version rows for min gating', () => {
    const db = new database.Database(':memory:');
    try {
      const ladderId = seedTwoProjectsWithFourActiveVersions(db);
      const entries = db.getLeaderboardEntries(ladderId);
      expect(entries.filter(e => e.role !== 'retired')).toHaveLength(4);
      expect(
        arena.buildLadderMatchState({
          ladder: db.getLadder(ladderId)!,
          entries,
          pairs: db.getPairAggregatesForLadder(ladderId),
        })
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('retains 14-day cooldown after self-quarantine until refunded', () => {
    const db = new database.Database(':memory:');
    try {
      db.syncLaddersFromYaml(`
- name: RAND
  format: gen9randombattle
  version: '0.11.0'
  id: gen9randombattle
  team: random
  status: active
`, 1_760_000_000);
      db.syncProjectsFromYaml(`
- name: 0 ERROR
  active: 2026
  arena:
    owners:
      pre: pre.10544
`, undefined, 1_760_000_000);
      db.setAgentLadders('0-error', database.ALL_SLOTS, 1_760_000_000);
      const zero = db.getAgentBySlug('0-error')!;
      const sub = db.createSubmission({
        agentId: zero.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
        sha256: '1'.repeat(64),
        ladderIds: ['gen9randombattle'],
        now: 1_760_001_000,
      });
      db.applySubmissionStatus({versionId: sub.id, smokeStatus: 'passed', now: 1_760_001_010});
      db.quarantineVersion('0-error', '1.0.0', 'Self quarantine', 1_760_001_020);
      expect(db.computeAgentSubmissionStatus(zero.id, 1_760_001_025).reason).toContain(
        '14-day cooldown active'
      );
      db.refundCooldown('0-error', 1_760_001_030);
      expect(db.computeAgentSubmissionStatus(zero.id, 1_760_001_035).canSubmit).toBe(true);
    } finally {
      db.close();
    }
  });

  test('archives outgoing ladder immediately on rotation when distinct projects < min', () => {
    const db = new database.Database(':memory:');
    try {
      const ladderId = seedTwoProjectsWithFourActiveVersions(db);
      const rotated = db.rotateLadder({
        oldLadderId: ladderId,
        archivedName: 'VGC 2026 Reg M-C',
        next: {id: 'gen9championsvgc2026regmd'},
        now: 1_766_000_000,
      });
      expect(rotated.oldLadder.status).toBe('archived');
      expect(db.getLeaderboardEntries(ladderId).every(e => e.role === 'retired')).toBe(true);
    } finally {
      db.close();
    }
  });

  test('keeps settling pools ladder active when one of four projects is quarantined', () => {
    const db = new database.Database(':memory:');
    try {
      db.syncLaddersFromYaml(`
- name: VGC
  format: gen9championsvgc2026regmc
  version: '0.11.0'
  id: gen9championsvgc2026regmc
  team: pools
  status: active
  min: 4
  teams: 20
`, 1_760_000_000);
      db.syncProjectsFromYaml(`
- name: 0 ERROR
  active: 2026
  arena:
    owners:
      pre: pre.10544
- name: Foul Play
  active: 2026
  arena:
    owners:
      pmariglia: pmariglia.100001
- name: PokeChamp
  active: 2026
  arena:
    owners:
      seth: seth.100002
- name: Metamon
  active: 2026
  arena:
    owners:
      jake: jake.100003
`, undefined, 1_760_000_000);
      for (const s of ['0-error', 'foul-play', 'pokechamp', 'metamon']) {
        db.setAgentLadders(s, database.ALL_SLOTS, 1_760_000_000);
      }

      const ladderId = 'gen9championsvgc2026regmc';
      const dummyTeams = Array.from({length: 20}, (_, i) => `Pikachu|||static|||||||]${i}`);
      let seq = 1;
      for (const slug of ['0-error', 'foul-play', 'pokechamp', 'metamon']) {
        const agent = db.getAgentBySlug(slug)!;
        const sub = db.createSubmission({
          agentId: agent.id,
          version: '1.0.0',
          package: 'bundle',
          url: `https://github.com/pkmn/${slug}-1.0.0.tar.zst`,
          sha256: String(seq++).padStart(64, '0'),
          ladderIds: [ladderId],
          teamsByLadder: {[ladderId]: dummyTeams},
          now: 1_760_000_000 + seq * 1000,
        });
        db.applySubmissionStatus({
          versionId: sub.id,
          smokeStatus: 'passed',
          now: 1_760_000_010 + seq * 1000,
        });
      }

      const rotated = db.rotateLadder({
        oldLadderId: ladderId,
        archivedName: 'VGC 2026 Reg M-C',
        next: {id: 'gen9championsvgc2026regmd'},
        now: 1_766_000_000,
      });
      expect(rotated.oldLadder.status).toBe('settling');

      db.quarantineVersion('0-error', '1.0.0', 'Strategic crash', 1_766_000_100);
      const ladderAfter = db.getLadder(ladderId)!;
      expect(ladderAfter.status).toBe('settling');

      const rosterIds = new Set(db.getActiveRosterForLadder(ladderId).map(r => r.agentId));
      expect(rosterIds.size).toBe(4);
      expect(arena.buildLadderMatchState({
        ladder: ladderAfter,
        entries: db.getLeaderboardEntries(ladderId),
        pairs: db.getPairAggregatesForLadder(ladderId),
        rosterAgentIds: rosterIds,
      })).toBeDefined();
    } finally {
      db.close();
    }
  });
});

describe('Smogon lookup', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubSmogonTooltipFetch() {
    globalThis.fetch = ((input: URL | RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.toString() : input.url;
      expect(url).toContain('__scraper-token=test-token');
      if (url.includes('members/?username=pre')) {
        return Promise.resolve(new Response(null, {
          status: 303,
          headers: {location: 'https://www.smogon.com/forums/members/pre.10544/'},
        }));
      }
      if (url.includes('?tooltip=1')) {
        const hdrs = new Headers(init?.headers);
        expect(hdrs.get('accept')).toBe('application/json');
        expect(hdrs.get('x-requested-with')).toBe('XMLHttpRequest');
      }
      if (url.includes('members/10544/?tooltip=1')) {
        return Promise.resolve(new Response(JSON.stringify({
          status: 'ok',
          html: {
            content: `
              <h4 class="memberTooltip-name">
                <span class="memberTooltip-nameWrapper">
                  <a href="/forums/members/pre.10544/" class="username "
                     data-user-id="10544">pre</a>
                </span>
              </h4>`,
          },
        }), {status: 200, headers: {'content-type': 'application/json'}}));
      }
      if (url.includes('members/1/?tooltip=1')) {
        return Promise.resolve(new Response(JSON.stringify({
          status: 'ok',
          html: {
            content: `
              <h4 class="memberTooltip-name">
                <a href="/forums/members/chaos.1/" class="username ">
                  <span class="username--staff username--admin">chaos &amp; co&#039;s</span>
                </a>
              </h4>`,
          },
        }), {status: 200, headers: {'content-type': 'application/json'}}));
      }
      if (url.includes('members/666/?tooltip=1')) {
        return Promise.resolve(new Response(JSON.stringify({
          status: 'ok',
          html: {
            content: `
              <h4 class="memberTooltip-name">
                <a href="/forums/members/cheater.666/" class="username ">
                  <span class="username--banned">cheater</span>
                </a>
              </h4>`,
          },
        }), {status: 200, headers: {'content-type': 'application/json'}}));
      }
      return Promise.resolve(new Response(null, {status: 404}));
    });
  }

  test('parseIdentifier extracts IDs or usernames across formats', () => {
    expect(smogon.parseIdentifier(10544)).toEqual({id: 10544});
    expect(smogon.parseIdentifier('10544')).toEqual({id: 10544});
    expect(smogon.parseIdentifier('pre.10544')).toEqual({id: 10544, username: 'pre'});
    expect(smogon.parseIdentifier('https://www.smogon.com/forums/members/pre.10544/'))
      .toEqual({id: 10544, username: 'pre'});
    expect(smogon.parseIdentifier('/forums/members/10544/'))
      .toEqual({id: 10544, username: undefined});
    expect(smogon.parseIdentifier('Dr. Perfidious')).toEqual({username: 'Dr. Perfidious'});
  });

  test('parseIdentifier rejects out-of-range numeric Smogon IDs', () => {
    expect(() => smogon.parseIdentifier('bad.99999999999999999')).toThrow(/Invalid Smogon/);
  });

  test('lookupUser resolves usernames via 303 redirect to tooltip JSON', async () => {
    stubSmogonTooltipFetch();
    expect(await smogon.lookupUser('pre', 'test-token')).toEqual({
      id: 10544,
      username: 'pre',
      slug: 'pre',
      url: 'https://www.smogon.com/forums/members/pre.10544/',
      banned: false,
    });
  });

  test('lookupUser decodes HTML entities in staff tooltip usernames', async () => {
    stubSmogonTooltipFetch();
    expect(await smogon.lookupUser(1, 'test-token')).toEqual({
      id: 1,
      username: "chaos & co's",
      slug: 'chaos',
      url: 'https://www.smogon.com/forums/members/chaos.1/',
      banned: false,
    });
  });

  test('lookupUser flags banned Smogon accounts', async () => {
    stubSmogonTooltipFetch();
    const banned = await smogon.lookupUser('cheater.666', 'test-token');
    expect(banned.banned).toBe(true);
  });

  test('lookupUser refuses off-domain redirects before leaking scraper token', async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (input: string | URL | Request) => {
      const u = typeof input === 'string'
        ? input
        : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(u);
      return Promise.resolve(
        new Response('', {status: 302, headers: {location: 'https://evilsmogon.com/steal'}})
      );
    };
    await expect(smogon.lookupUser(10544, 'super-secret-smogon-tok'))
      .rejects.toThrow(/non-Smogon URL/);
    expect(requestedUrls.some(u => u.includes('evilsmogon.com'))).toBe(false);
  });

  test('lookupUser rejects Smogon redirects specifying a non-default port', async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (input: string | URL | Request) => {
      const u = typeof input === 'string'
        ? input
        : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(u);
      return Promise.resolve(
        new Response('', {
          status: 302,
          headers: {location: 'https://www.smogon.com:8443/forums/members/pre.10544/'},
        })
      );
    };
    await expect(smogon.lookupUser(10544, 'super-secret-smogon-tok'))
      .rejects.toThrow(/non-Smogon URL/);
    expect(requestedUrls.some(u => u.includes(':8443'))).toBe(false);
  });

  test('lookupUser rejects Smogon redirects containing userinfo credentials', async () => {
    globalThis.fetch = () => Promise.resolve(
      new Response('', {
        status: 302,
        headers: {location: 'https://user:pass@www.smogon.com/forums/members/pre.10544/'},
      })
    );
    await expect(smogon.lookupUser(10544, 'super-secret-smogon-tok'))
      .rejects.toThrow(/non-Smogon URL/);
  });

  test('lookupUser flags captive-portal HTML responses as connectivity errors', async () => {
    globalThis.fetch = () => Promise.resolve(
      new Response('<!doctype html><html><body>Airplane Wi-Fi</body></html>', {
        status: 200,
        headers: {'content-type': 'text/html; charset=utf-8'},
      })
    );
    await expect(smogon.lookupUser(10544, 'test-token'))
      .rejects.toMatchObject({connectivity: true});
  });
});

describe('project ownership sync', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-db-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('rejects duplicate GitHub owner logins across projects', () => {
    expect(() => database.parseArenaProjects(`
- name: Alpha
  active: 2026
  arena:
    owners:
      SharedDev: pre.10544
- name: Beta
  active: 2026
  arena:
    owners:
      shareddev: other.99999
`, tmpDir)).toThrow(/GitHub owner "shareddev" is assigned to both "Alpha" and "Beta"/);
  });

  test('rejects duplicate numeric Smogon IDs across projects offline', () => {
    expect(() => database.parseArenaProjects(`
- name: Alpha
  active: 2026
  arena:
    owners:
      dev_one: old_handle.10544
- name: Beta
  active: 2026
  arena:
    owners:
      dev_two: https://www.smogon.com/forums/members/renamed_handle.10544/
`, tmpDir)).toThrow(/Smogon ID 10544 is assigned to both "Alpha" and "Beta"/);
  });

  test('rejects duplicate resolved Smogon IDs across projects during live lookup', async () => {
    const db = new database.Database(':memory:');
    try {
      await expect(db.syncProjectsFromYamlWithSmogon(`
- name: Alpha
  active: 2026
  arena:
    owners:
      dev_one: pre.10544
- name: Beta
  active: 2026
  arena:
    owners:
      dev_two: renamed_pre
`, {
        avatarsDir: tmpDir,
        lookupSmogon: () => Promise.resolve({
          id: 10544,
          username: 'renamed_pre',
          slug: 'renamed-pre',
          url: 'https://www.smogon.com/forums/members/renamed-pre.10544/',
          banned: false,
        }),
      })).rejects.toThrow(/Smogon ID 10544 \("renamed_pre"\) is assigned to both/);
    } finally {
      db.close();
    }
  });

  test('resolves initial Smogon usernames during live sync', async () => {
    const db = new database.Database(':memory:');
    try {
      const lookupCalls: Array<string | number> = [];
      await db.syncProjectsFromYamlWithSmogon(`
- name: Foul Play
  active: 2021
  arena:
    owners:
      scheibo: pre
`, {
        avatarsDir: tmpDir,
        lookupSmogon: raw => {
          lookupCalls.push(raw);
          return Promise.resolve({
            id: 10544,
            username: 'pre',
            slug: 'pre',
            url: 'https://www.smogon.com/forums/members/pre.10544/',
            banned: false,
          });
        },
        now: 1000,
      });
      expect(lookupCalls).toEqual(['pre']);
      expect(db.getDeveloperByGitHub('scheibo')).toMatchObject({
        smogonId: 10544,
        smogonUsername: 'pre',
      });
    } finally {
      db.close();
    }
  });

  test('refreshes renamed Smogon usernames by immutable numeric ID', async () => {
    const db = new database.Database(':memory:');
    try {
      let currentName = 'pre';
      const lookupCalls: Array<string | number> = [];
      const mockLookup = (raw: string | number) => {
        lookupCalls.push(raw);
        return Promise.resolve({
          id: 10544,
          username: currentName,
          slug: currentName,
          url: `https://www.smogon.com/forums/members/${currentName}.10544/`,
          banned: false,
        });
      };
      const yamlText = `
- name: Foul Play
  active: 2021
  arena:
    owners:
      scheibo: pre
`;
      await db.syncProjectsFromYamlWithSmogon(yamlText, {
        avatarsDir: tmpDir,
        lookupSmogon: mockLookup,
        now: 1000,
      });
      currentName = 'pre_new';
      lookupCalls.length = 0;
      await db.syncProjectsFromYamlWithSmogon(yamlText, {
        avatarsDir: tmpDir,
        lookupSmogon: mockLookup,
        now: 2000,
      });
      expect(lookupCalls).toEqual([10544]);
      expect(db.getDeveloperByGitHub('scheibo')).toMatchObject({
        smogonId: 10544,
        smogonUsername: 'pre_new',
      });
    } finally {
      db.close();
    }
  });

  test('marks banned Smogon owners with bad standing to block submissions', async () => {
    const db = new database.Database(':memory:');
    try {
      const yamlText = `
- name: Foul Play
  active: 2021
  arena:
    owners:
      pmariglia: pmariglia.535629
`;
      db.syncProjectsFromYaml(yamlText, tmpDir, 1000);
      db.setAgentLadders('foul-play', database.ALL_SLOTS, 1000);
      await expect(db.syncProjectsFromYamlWithSmogon(yamlText, {
        avatarsDir: tmpDir,
        lookupSmogon: () => Promise.resolve({
          id: 535629,
          username: 'pmariglia',
          slug: 'pmariglia',
          url: 'https://www.smogon.com/forums/members/pmariglia.535629/',
          banned: true,
        }),
        now: 2000,
      })).rejects.toThrow(/is banned/);
      expect(db.getDeveloperByGitHub('pmariglia')?.smogonStanding).toBe('bad');
      const fp = db.getAgentBySlug('foul-play')!;
      expect(db.computeAgentSubmissionStatus(fp.id).canSubmit).toBe(false);
      expect(db.computeAgentSubmissionStatus(fp.id).reason).toMatch(/not in good standing/);
    } finally {
      db.close();
    }
  });

  test('persists newly discovered banned owners while syncing remaining projects', async () => {
    const db = new database.Database(':memory:');
    try {
      await expect(db.syncProjectsFromYamlWithSmogon(`
- name: Bad Proj
  active: 2026
  arena:
    owners:
      badgh: 666
- name: Good Proj
  active: 2026
  arena:
    owners:
      goodgh: 777
`, {
        avatarsDir: tmpDir,
        lookupSmogon: id => Promise.resolve({
          id: Number(id),
          username: `u${String(id)}`,
          slug: `u${String(id)}`,
          url: `https://www.smogon.com/forums/members/${String(id)}/`,
          banned: Number(id) === 666,
        }),
        now: 1_760_000_100,
      })).rejects.toThrow(/is banned/);
      expect(db.getDeveloperByGitHub('badgh')?.smogonStanding).toBe('bad');
      expect(db.getAgentBySlug('good-proj')).toBeDefined();
      db.setAgentLadders('bad-proj', ['rby'], 1_760_000_105);
      db.setAgentLadders('good-proj', ['rby'], 1_760_000_105);
      db.linkDeveloperDiscord('badgh', '111111', 'baduser', 1_760_000_110);
      db.linkDeveloperDiscord('goodgh', '222222', 'gooduser', 1_760_000_110);
      expect(db.getCompetitorDiscordIds()).toEqual(['222222']);
    } finally {
      db.close();
    }
  });

  test('short-circuits remaining Smogon lookups after a connectivity failure', async () => {
    const db = new database.Database(':memory:');
    try {
      const attempted: Array<string | number> = [];
      await expect(db.syncProjectsFromYamlWithSmogon(`
- name: Alpha
  active: 2026
  arena:
    owners:
      dev_one: pre.10544
- name: Beta
  active: 2026
  arena:
    owners:
      dev_two: pmariglia.535629
`, {
        avatarsDir: tmpDir,
        lookupSmogon: raw => {
          attempted.push(raw);
          const err = new TypeError('fetch failed');
          return Promise.reject(err);
        },
        now: 1000,
      })).rejects.toMatchObject({connectivity: true});
      expect(attempted).toEqual([10544]);
      expect(db.getAgentBySlug('alpha')).toBeDefined();
      expect(db.getAgentBySlug('beta')).toBeDefined();
    } finally {
      db.close();
    }
  });

  test('syncs valid projects when an initial username lookup fails offline', async () => {
    const db = new database.Database(':memory:');
    try {
      await expect(db.syncProjectsFromYamlWithSmogon(`
- name: Unresolved
  active: 2026
  arena:
    owners:
      offline_dev: some_username
- name: Resolved
  active: 2026
  arena:
    owners:
      pre_gh: pre.10544
`, {
        avatarsDir: tmpDir,
        lookupSmogon: () => Promise.reject(new TypeError('fetch failed')),
        now: 1000,
      })).rejects.toMatchObject({connectivity: true});
      expect(db.getAgentBySlug('resolved')).toBeDefined();
      expect(db.getDeveloperByGitHub('pre_gh')?.smogonId).toBe(10544);
    } finally {
      db.close();
    }
  });

  test('syncs active projects offline while ignoring historical-only projects', () => {
    const avatarsDir = path.join(tmpDir, 'avatars');
    fs.mkdirSync(avatarsDir, {recursive: true});
    fs.writeFileSync(path.join(avatarsDir, 'foul-play.png'), 'PNG');

    const db = new database.Database(':memory:');
    try {
      db.syncProjectsFromYaml(`
- name: Foul Play
  active: 2021
  arena:
    owners:
      PMariglia: pmariglia.535629
- name: Metamon
  active: 2025
  arena:
    owners:
      jakegrigsby: 2001
- name: Historical Only
  active: [2019, 2020]
`, avatarsDir, 1_760_000_000);

      expect(db.getAgentBySlug('foul-play')?.status).toBe('pending');
      db.setAgentLadders('foul-play', ['rby', 'adv'], 1_760_000_000);
      const fp = db.getAgentBySlug('foul-play')!;
      expect(fp.logo).toBe('foul-play.png');
      expect(fp.status).toBe('qualified');
      expect(db.getAgentLadders(fp.id)).toEqual(['rby', 'adv']);
      expect(db.getAgentBySlug('metamon')?.status).toBe('pending');
      expect(db.getAgentBySlug('historical-only')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('preserves linked GitHub or Discord OAuth IDs across YAML re-syncs', () => {
    const db = new database.Database(':memory:');
    try {
      db.syncProjectsFromYaml(`
- name: Foul Play
  active: 2021
  arena:
    owners:
      PMariglia: pmariglia.535629
`, tmpDir, 1_760_000_000);
      db.linkDeveloperGitHubId('PMariglia', 4242, 1_760_000_100);
      db.linkDeveloperDiscord('PMariglia', '283674461268344832', 'pmariglia', 1_760_000_100);

      db.syncProjectsFromYaml(`
- name: Foul Play
  active: 2021
  arena:
    owners:
      pmariglia: pmariglia_renamed.535629
`, tmpDir, 1_760_000_200);

      const dev = db.getDeveloperByGitHub('pmariglia')!;
      expect(dev.smogonUsername).toBe('pmariglia_renamed');
      expect(dev.githubId).toBe(4242);
      expect(dev.discordId).toBe('283674461268344832');

      db.unlinkDeveloperDiscord('pmariglia', 1_760_000_300);
      expect(db.getDeveloperByGitHub('pmariglia')!.discordId).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('disables removed projects while deleting dropped owner rows', () => {
    const db = new database.Database(':memory:');
    try {
      db.syncProjectsFromYaml(`
- name: Foul Play
  active: 2021
  arena:
    owners:
      pmariglia: pmariglia.535629
      coauthor: coauthor.1002
- name: Metamon
  active: 2025
  arena:
    owners:
      jakegrigsby: 2001
`, tmpDir, 1_760_000_000);
      const mmId = db.getAgentBySlug('metamon')!.id;

      db.syncProjectsFromYaml(`
- name: Foul Play
  active: 2021
  arena:
    owners:
      pmariglia: pmariglia.535629
`, tmpDir, 1_760_000_200);

      expect(db.getDeveloperByGitHub('coauthor')).toBeUndefined();
      expect(db.getAgentById(mmId)!.status).toBe('disabled');
      expect(db.getDeveloperByGitHub('jakegrigsby')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('retains qualified unowned projects with empty owners map', () => {
    const db = new database.Database(':memory:');
    try {
      db.syncLadders(database.LADDERS_FILE, 1_760_000_000);
      db.db.prepare("UPDATE ladders SET status = 'active' WHERE id = 'gen1ou20261109'").run();
      db.syncProjectsFromYaml(`
- name: 0 ERROR
  active: 2026
  arena:
    owners:
      scheibo: pre.10544
`, undefined, 1_760_000_100);
      db.setAgentLadders('0-error', ['rby'], 1_760_000_100);
      const zeroAgent = db.getAgentBySlug('0-error')!;
      const vZero = db.createSubmission({
        agentId: zeroAgent.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_760_000_200,
      });
      db.applySubmissionStatus({versionId: vZero.id, smokeStatus: 'passed', now: 1_760_000_210});

      db.syncProjectsFromYaml(`
- name: 0 ERROR
  active: 2026
  arena:
    owners: {}
`, undefined, 1_760_000_300);

      expect(db.getAgentBySlug('0-error')!.status).toBe('qualified');
      expect(db.getDevelopersForAgent(zeroAgent.id)).toEqual([]);
      expect(db.getActiveEntriesForAgent(zeroAgent.id)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('preserves developer primary key across project reassignments', () => {
    const db = new database.Database(':memory:');
    try {
      db.syncLadders(database.LADDERS_FILE, 1_760_000_000);
      db.db.prepare("UPDATE ladders SET status = 'active' WHERE id = 'gen1ou20261109'").run();
      db.syncProjectsFromYaml(`
- name: 0 ERROR
  active: 2026
  arena:
    owners:
      scheibo: pre.10544
- name: Foul Play
  active: 2026
  arena:
    owners:
      pmariglia: pmariglia.535629
`, undefined, 1_760_000_100);
      db.setAgentLadders('0-error', ['rby'], 1_760_000_100);
      db.setAgentLadders('foul-play', ['rby'], 1_760_000_100);

      db.linkDeveloperGitHubId('scheibo', 1001, 1_760_000_110);
      db.linkDeveloperDiscord('scheibo', '513513270670262284', 'scheibo', 1_760_000_110);

      const zeroAgent = db.getAgentBySlug('0-error')!;
      const fpAgent = db.getAgentBySlug('foul-play')!;
      const initialDev = db.getDeveloperByGitHub('scheibo')!;

      const vZero = db.createSubmission({
        agentId: zeroAgent.id,
        developerId: initialDev.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_760_000_200,
      });

      db.syncProjectsFromYaml(`
- name: 0 ERROR
  active: 2026
  arena:
    owners: {}
- name: Foul Play
  active: 2026
  arena:
    owners:
      pmariglia: pmariglia.535629
      scheibo: pre.10544
`, undefined, 1_760_000_300);

      const movedDev = db.getDeveloperByGitHub('scheibo')!;
      expect(movedDev.id).toBe(initialDev.id);
      expect(movedDev.agentId).toBe(fpAgent.id);
      expect(movedDev.githubId).toBe(1001);
      expect(movedDev.discordId).toBe('513513270670262284');
      expect(db.getVersionById(vZero.id)!.developerId).toBe(initialDev.id);

      db.syncProjectsFromYaml(`
- name: 0 ERROR
  active: 2026
  arena:
    owners:
      scheibo: pre.10544
- name: Foul Play
  active: 2026
  arena:
    owners:
      pmariglia: pmariglia.535629
`, undefined, 1_760_000_400);

      const returnedDev = db.getDeveloperByGitHub('scheibo')!;
      expect(returnedDev.id).toBe(initialDev.id);
      expect(returnedDev.agentId).toBe(zeroAgent.id);
    } finally {
      db.close();
    }
  });

  test('syncs Discord guild membership snapshots', () => {
    const db = new database.Database(':memory:');
    try {
      db.syncDiscordMembers([
        {id: '513513270670262284', username: 'scheibo'},
        {id: '283674461268344832', username: 'pmariglia'},
      ]);
      expect(db.isDiscordMember('513513270670262284')).toBe(true);
      expect(db.isDiscordMember('999999999999999999')).toBe(false);
      expect(db.isDiscordMember(undefined)).toBe(false);

      db.syncDiscordMembers([{id: '283674461268344832', username: 'pmariglia'}]);
      expect(db.isDiscordMember('513513270670262284')).toBe(false);
      expect(db.isDiscordMember('283674461268344832')).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('identifier validation', () => {
  test('validateAgentName accepts 1–18 character Showdown-safe names', () => {
    expect(validateAgentName('0 ERROR')).toBe('0 ERROR');
    expect(validateAgentName("Mew's Truck")).toBe("Mew's Truck");
    expect(validateAgentName('PokéChamp 18Chars!')).toBe('PokéChamp 18Chars!');
  });

  test('validateAgentName rejects reserved prefixes, pipes, or >18-char names', () => {
    expect(() => validateAgentName('Name With Nineteen!')).toThrow(/1–18 characters/);
    expect(() => validateAgentName('Guest 1234')).toThrow(/guest/i);
    expect(() => validateAgentName('@RankPrefix')).toThrow(/rank or command/);
    expect(() => validateAgentName('~AdminBot')).toThrow(/rank or command/);
    expect(() => validateAgentName('/slashcmd')).toThrow(/rank or command/);
    expect(() => validateAgentName('Pipe|Name')).toThrow(/Showdown|reserved/i);
    expect(() => validateAgentName('Double  Space')).toThrow(/Showdown/);
    expect(() => validateAgentName('12345')).toThrow(/at least one ASCII letter/);
  });

  test('validateVersion accepts 1–12 character safe version tags', () => {
    expect(validateVersion('1.0.0')).toBe('1.0.0');
    expect(validateVersion('1.4.1-t3')).toBe('1.4.1-t3');
    expect(validateVersion('v2026.11.11a')).toBe('v2026.11.11a');
  });

  test('validateVersion rejects path characters or >12-char tags', () => {
    expect(() => validateVersion('v2026.11.11ab')).toThrow(/1–12 characters/);
    expect(() => validateVersion('-bad')).toThrow(/1–12 characters/);
    expect(() => validateVersion('..')).toThrow(/1–12 characters/);
    expect(() => validateVersion('1.0/bad')).toThrow(/1–12 characters/);
  });

  test('rejects distinct project names that collide under Showdown toID', () => {
    expect(() => database.parseArenaProjects(`
- name: Foo Bar
  active: 2026
  arena:
    owners:
      alice: alice.1
- name: FooBar
  active: 2026
  arena:
    owners:
      bob: bob.2
`)).toThrow(/Duplicate Pokémon Showdown ID "foobar"/);
  });

  test('createSubmission enforces the 12-character version limit', () => {
    const db = new database.Database(':memory:');
    try {
      db.syncLadders(database.LADDERS_FILE, 1_760_000_000);
      db.syncProjectsFromYaml(`
- name: 0 ERROR
  active: 2026
  arena:
    owners:
      pre: pre.10544
`, undefined, 1_760_000_000);
      db.setAgentLadders('0-error', database.ALL_SLOTS, 1_760_000_000);
      const agent = db.getAgentBySlug('0-error')!;
      expect(() => db.createSubmission({
        agentId: agent.id,
        version: '1.2.3-rc45678',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: ['gen1ou20261109'],
      })).toThrow(/1–12 characters/);
    } finally {
      db.close();
    }
  });

  test('getTournamentClosesAt computes 00:00 UTC strictly before startsAt', () => {
    const midDayStart = Math.floor(Date.parse('2026-11-15T18:00:00Z') / 1000);
    const sameDayMidnight = Math.floor(Date.parse('2026-11-15T00:00:00Z') / 1000);
    const prevDayMidnight = Math.floor(Date.parse('2026-11-14T00:00:00Z') / 1000);
    expect(database.getTournamentClosesAt(midDayStart)).toBe(sameDayMidnight);
    expect(database.getTournamentClosesAt(sameDayMidnight)).toBe(prevDayMidnight);
  });
});

describe('ladder activation invariants', () => {
  let db: database.Database;

  beforeEach(() => {
    db = new database.Database(':memory:');
    db.syncLadders(database.LADDERS_FILE, 1_760_000_000);
    db.syncProjectsFromYaml(`
- name: Alpha
  active: 2026
  arena:
    owners:
      alpha: alpha.1
- name: Beta
  active: 2026
  arena:
    owners:
      beta: beta.2
- name: Gamma
  active: 2026
  arena:
    owners:
      gamma: gamma.3
- name: Delta
  active: 2026
  arena:
    owners:
      delta: delta.4
`, undefined, 1_760_000_000);
    for (const s of ['alpha', 'beta', 'gamma', 'delta']) {
      db.setAgentLadders(s, database.ALL_SLOTS, 1_760_000_000);
    }
  });

  afterEach(() => {
    db.close();
  });

  test('validateHarvestedTeams rejects fewer than 2 teams, mirrors, or incomplete sets', () => {
    const rbyTeams = generateValidHarvestedTeams('gen1ou', 4);
    expect(() => validateHarvestedTeams([rbyTeams[0]], 'gen1ou')).toThrow(/at least 2/);
    expect(() => validateHarvestedTeams([rbyTeams[0], rbyTeams[0]], 'gen1ou'))
      .toThrow(/non-mirror/);
    expect(() => validateHarvestedTeams([rbyTeams[0], 'NotAPokemon\n- Tackle'], 'gen1ou'))
      .toThrow(/6 Pokémon/);
  });

  test('replaceLadderTeams rejects non-harvested ladders', () => {
    const packedRby = validateHarvestedTeams(generateValidHarvestedTeams('gen1ou', 4), 'gen1ou');
    expect(() => db.replaceLadderTeams('gen9randombattle20261109', packedRby, 1_760_000_010))
      .toThrow(/harvested/);
  });

  test('setLadderStatus blocks activating harvested ladders before teams are uploaded', () => {
    expect(() => db.setLadderStatus('gen1ou20261109', 'active', 1_760_000_020))
      .toThrow(/harvested teams have not been uploaded yet/);
  });

  test('setLadderStatus blocks activating ladders below minimum distinct entries', () => {
    const packedRby = validateHarvestedTeams(generateValidHarvestedTeams('gen1ou', 4), 'gen1ou');
    db.replaceLadderTeams('gen1ou20261109', packedRby, 1_760_000_020);
    expect(() => db.setLadderStatus('gen1ou20261109', 'active', 1_760_000_030))
      .toThrow(/requires at least 2 distinct active entries \(found 0\)/);
  });

  test('setLadderStatus blocks activating ladders without an active 1500-Elo anchor', () => {
    const packedRby = validateHarvestedTeams(generateValidHarvestedTeams('gen1ou', 4), 'gen1ou');
    db.replaceLadderTeams('gen1ou20261109', packedRby, 1_760_000_020);
    for (const [idx, slug] of ['alpha', 'beta'].entries()) {
      const ag = db.getAgentBySlug(slug)!;
      const v = db.createSubmission({
        agentId: ag.id,
        version: '1.0.0',
        package: 'bundle',
        url: `https://github.com/pkmn/${slug}.tar.zst`,
        sha256: String(idx + 1).repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_760_000_040,
      });
      db.applySubmissionStatus({versionId: v.id, smokeStatus: 'passed', now: 1_760_000_050});
    }
    expect(() => db.setLadderStatus('gen1ou20261109', 'active', 1_760_000_060))
      .toThrow(/no active 1500-Elo anchor/);
  });

  test('setLadderStatus activates harvested ladders once prerequisites pass', () => {
    const packedRby = validateHarvestedTeams(generateValidHarvestedTeams('gen1ou', 4), 'gen1ou');
    expect(db.replaceLadderTeams('gen1ou20261109', packedRby, 1_760_000_020)).toBe(4);
    expect(db.hasLadderTeams('gen1ou20261109')).toBe(true);
    expect(db.getLadderTeams('gen1ou20261109')).toEqual(packedRby);

    for (const [idx, slug] of ['alpha', 'beta'].entries()) {
      const ag = db.getAgentBySlug(slug)!;
      const v = db.createSubmission({
        agentId: ag.id,
        version: '1.0.0',
        package: 'bundle',
        url: `https://github.com/pkmn/${slug}.tar.zst`,
        sha256: String(idx + 1).repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_760_000_040,
      });
      db.applySubmissionStatus({versionId: v.id, smokeStatus: 'passed', now: 1_760_000_050});
    }
    db.setLadderAnchor('gen1ou20261109', 'alpha', '1.0.0', 1_760_000_070);
    expect(db.setLadderStatus('gen1ou20261109', 'active', 1_760_000_080).status).toBe('active');
  });

  const setupThreeEscalatingAlphaVersions = () => {
    const packedRby = validateHarvestedTeams(generateValidHarvestedTeams('gen1ou', 4), 'gen1ou');
    db.replaceLadderTeams('gen1ou20261109', packedRby, 1_760_000_020);

    const alpha = db.getAgentBySlug('alpha')!;
    const beta = db.getAgentBySlug('beta')!;

    const subB1 = db.createSubmission({
      agentId: beta.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/beta-1.0.0.tar.zst',
      sha256: '9'.repeat(64),
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_030,
    });
    db.applySubmissionStatus({versionId: subB1.id, smokeStatus: 'passed', now: 1_760_000_035});
    db.setLadderAnchor('gen1ou20261109', 'beta', '1.0.0', 1_760_000_040);

    const recordSeries = (idPrefix: string, p1: number, p2: number, baseTs: number) => {
      for (let i = 0; i < 65; i++) {
        const g2 = i % 3 === 0 ? 'L' : 'W';
        const cat = g2 === 'W' ? 'WW' : 'WL';
        db.recordCompletedMatch({
          match: {
            id: `gen1ou-${idPrefix}-${i}`,
            ladderId: 'gen1ou20261109',
            p1VersionId: p1,
            p2VersionId: p2,
            seed: `1,2,3,${i}`,
            game1Outcome: 'W',
            game2Outcome: g2,
            category: cat,
            game1Turns: 20,
            game2Turns: 20,
            game1EndReason: 'normal',
            game2EndReason: 'normal',
            p1Game1PeakRam: 128,
            p1Game2PeakRam: 128,
            p2Game1PeakRam: 128,
            p2Game2PeakRam: 128,
            p1Game1BankSeconds: 120,
            p1Game2BankSeconds: 120,
            p2Game1BankSeconds: 120,
            p2Game2BankSeconds: 120,
            p1Game1MeanTurnMillis: 100,
            p1Game2MeanTurnMillis: 100,
            p2Game1MeanTurnMillis: 100,
            p2Game2MeanTurnMillis: 100,
            completedAt: baseTs + i,
          },
        });
      }
    };

    // Submit 3 escalating versions of alpha before setting alpha 1.0.0 as anchor -> 1.0.0 retires
    const alphaIds: number[] = [];
    for (const [idx, ver] of ['1.0.0', '1.5.0', '2.0.0'].entries()) {
      if (idx > 0) db.refundCooldown('alpha', 1_760_000_090 + idx * 500);
      const sub = db.createSubmission({
        agentId: alpha.id,
        version: ver,
        package: 'bundle',
        url: `https://github.com/pkmn/alpha-${ver}.tar.zst`,
        sha256: String(idx + 1).repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_760_000_100 + idx * 500,
      });
      db.applySubmissionStatus({
        versionId: sub.id,
        smokeStatus: 'passed',
        now: 1_760_000_110 + idx * 500,
      });
      if (idx === 0) {
        db.setLadderStatus('gen1ou20261109', 'active', 1_760_000_115);
      }
      alphaIds.push(sub.id);
      const opp = idx === 0 ? subB1.id : alphaIds[idx - 1];
      recordSeries(`a${idx}`, sub.id, opp, 1_760_000_120 + idx * 500);
    }
  };

  test('setLadderAnchor reactivates a retired version as an active anchor', () => {
    setupThreeEscalatingAlphaVersions();

    const beforeAnchor = db.getLeaderboardEntries('gen1ou20261109')
      .filter(e => e.agentSlug === 'alpha');
    expect(beforeAnchor.find(e => e.version === '1.0.0')?.role).toBe('retired');

    db.setLadderAnchor('gen1ou20261109', 'alpha', '1.0.0', 1_760_002_000);
    const withAnchor = db.getLeaderboardEntries('gen1ou20261109')
      .filter(e => e.agentSlug === 'alpha');
    expect(withAnchor.filter(e => e.role !== 'retired')).toHaveLength(3);
    expect(withAnchor.find(e => e.version === '2.0.0')?.role).toBe('champion');
    expect(withAnchor.find(e => e.version === '1.5.0')?.role).toBe('challenger');
    expect(withAnchor.find(e => e.version === '1.0.0')?.isAnchor).toBe(true);
    expect(withAnchor.find(e => e.version === '1.0.0')?.role).toBe('challenger');
  });

  test('unquarantineVersion restores champion alongside an active anchor', () => {
    setupThreeEscalatingAlphaVersions();
    db.setLadderAnchor('gen1ou20261109', 'alpha', '1.0.0', 1_760_002_000);

    db.quarantineVersion('alpha', '2.0.0', 'Transient fault', 1_760_002_050);
    db.unquarantineVersion('alpha', '2.0.0', 1_760_002_060);
    const afterUnq = db.getLeaderboardEntries('gen1ou20261109')
      .filter(e => e.agentSlug === 'alpha' && e.role !== 'retired');
    expect(afterUnq).toHaveLength(3);
  });

  test('setLadderAnchor trims former anchor owner back to two active versions', () => {
    setupThreeEscalatingAlphaVersions();
    db.setLadderAnchor('gen1ou20261109', 'alpha', '1.0.0', 1_760_002_000);

    db.setLadderAnchor('gen1ou20261109', 'beta', '1.0.0', 1_760_002_100);
    const afterMove = db.getLeaderboardEntries('gen1ou20261109')
      .filter(e => e.agentSlug === 'alpha');
    expect(afterMove.filter(e => e.role !== 'retired').map(e => e.version).sort()).toEqual([
      '1.5.0',
      '2.0.0',
    ]);
    expect(afterMove.find(e => e.version === '1.0.0')?.role).toBe('retired');
  });

  test('setLadderStatus activates pools ladders once 4 distinct rosters exist', () => {
    const vgcAgents = ['alpha', 'beta', 'gamma', 'delta'];
    for (let i = 0; i < 3; i++) {
      const agent = db.getAgentBySlug(vgcAgents[i])!;
      const packedVgc = generateValidVgcTeams(20, i).map(p => Teams.pack(Teams.import(p)));
      const sub = db.createSubmission({
        agentId: agent.id,
        version: '1.0.0-vgc',
        package: 'bundle',
        url: `https://github.com/pkmn/${vgcAgents[i]}-vgc.tar.zst`,
        sha256: String(i + 5).repeat(64),
        ladderIds: ['gen9championsvgc2026regmc'],
        teamsByLadder: {gen9championsvgc2026regmc: packedVgc},
        now: 1_762_000_000,
      });
      db.applySubmissionStatus({versionId: sub.id, smokeStatus: 'passed', now: 1_762_000_010});
    }
    db.setLadderAnchor('gen9championsvgc2026regmc', 'alpha', '1.0.0-vgc', 1_762_000_020);
    expect(() => db.setLadderStatus('gen9championsvgc2026regmc', 'active', 1_762_000_030))
      .toThrow(/requires at least 4 distinct active entries \(found 3\)/);

    const delta = db.getAgentBySlug('delta')!;
    const deltaSub = db.createSubmission({
      agentId: delta.id,
      version: '1.0.0-vgc',
      package: 'bundle',
      url: 'https://github.com/pkmn/delta-vgc.tar.zst',
      sha256: '8'.repeat(64),
      ladderIds: ['gen9championsvgc2026regmc'],
      teamsByLadder: {
        gen9championsvgc2026regmc: generateValidVgcTeams(20, 3)
          .map(p => Teams.pack(Teams.import(p))),
      },
      now: 1_762_000_040,
    });
    db.applySubmissionStatus({versionId: deltaSub.id, smokeStatus: 'passed', now: 1_762_000_050});
    expect(db.setLadderStatus('gen9championsvgc2026regmc', 'active', 1_762_000_060).status)
      .toBe('active');
  });
});

describe('quarantine invariants', () => {
  let db: database.Database;
  let versionIds: number[];

  beforeEach(() => {
    db = new database.Database(':memory:');
    db.syncLaddersFromYaml(`
- name: RAND
  format: gen9randombattle
  version: '0.11.0'
  id: gen9randombattle
  team: random
  status: upcoming
  min: 2
`, 1_760_000_000);
    db.syncProjectsFromYaml(`
- name: Alpha
  active: 2026
  arena:
    owners:
      a: a.1
- name: Beta
  active: 2026
  arena:
    owners:
      b: b.2
- name: Gamma
  active: 2026
  arena:
    owners:
      c: c.3
`, undefined, 1_760_000_000);
    for (const s of ['alpha', 'beta', 'gamma']) {
      db.setAgentLadders(s, database.ALL_SLOTS, 1_760_000_000);
    }

    versionIds = ['alpha', 'beta', 'gamma'].map((slug, idx) => {
      const ag = db.getAgentBySlug(slug)!;
      const sub = db.createSubmission({
        agentId: ag.id,
        version: '1.0.0',
        package: 'bundle',
        url: `https://github.com/pkmn/${slug}.tar.zst`,
        sha256: String(idx + 1).repeat(64),
        ladderIds: ['gen9randombattle'],
        now: 1_760_000_010 + idx,
      });
      db.applySubmissionStatus({versionId: sub.id, smokeStatus: 'passed', now: 1_760_000_020});
      return sub.id;
    });
    db.setLadderAnchor('gen9randombattle', 'gamma', '1.0.0', 1_760_000_025);
    db.setLadderStatus('gen9randombattle', 'active', 1_760_000_030);

    let mSeq = 1;
    for (const [i, j] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      for (let k = 0; k < 30; k++) {
        db.recordCompletedMatch({
          match: {
            id: `rand-${mSeq++}`,
            ladderId: 'gen9randombattle',
            p1VersionId: versionIds[i],
            p2VersionId: versionIds[j],
            seed: '1,2,3,4',
            game1Outcome: 'W',
            game2Outcome: k < 20 ? 'W' : 'L',
            category: k < 20 ? 'WW' : 'WL',
            game1Turns: 10,
            game2Turns: 10,
            game1EndReason: 'normal',
            game2EndReason: 'normal',
            p1Game1PeakRam: 64,
            p1Game2PeakRam: 64,
            p2Game1PeakRam: 64,
            p2Game2PeakRam: 64,
            p1Game1BankSeconds: 100,
            p1Game2BankSeconds: 100,
            p2Game1BankSeconds: 100,
            p2Game2BankSeconds: 100,
            p1Game1MeanTurnMillis: 50,
            p1Game2MeanTurnMillis: 50,
            p2Game1MeanTurnMillis: 50,
            p2Game2MeanTurnMillis: 50,
            completedAt: 1_760_001_000 + mSeq,
          },
        });
      }
    }
  });

  afterEach(() => {
    db.close();
  });

  test('quarantineVersion re-densifies active leaderboard ranks immediately', () => {
    expect(
      db.getLeaderboardEntries('gen9randombattle').find(e => e.agentSlug === 'gamma')?.rankCurrent
    ).toBe(3);
    db.quarantineVersion('beta', '1.0.0', 'Timeout loop', 1_760_002_000);
    expect(
      db.getLeaderboardEntries('gen9randombattle').find(e => e.agentSlug === 'gamma')?.rankCurrent
    ).toBe(2);
  });

  test('unquarantineVersion rejects pending or failed versions', () => {
    db.refundCooldown('alpha', 1_760_002_005);
    const agAlpha = db.getAgentBySlug('alpha')!;
    const pendingSub = db.createSubmission({
      agentId: agAlpha.id,
      version: '1.1.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/alpha-110.tar.zst',
      sha256: '9'.repeat(64),
      ladderIds: ['gen9randombattle'],
      now: 1_760_002_010,
    });
    expect(() => db.unquarantineVersion('alpha', '1.1.0', 1_760_002_020))
      .toThrow(/not quarantined/);

    db.applySubmissionStatus({
      versionId: pendingSub.id,
      smokeStatus: 'failed',
      smokeError: 'Bad archive',
      now: 1_760_002_025,
    });
    expect(() => db.unquarantineVersion('alpha', '1.1.0', 1_760_002_030))
      .toThrow(/not quarantined/);
    expect(() => db.quarantineVersion('alpha', '1.1.0', 'Cannot quarantine failed', 1_760_002_035))
      .toThrow(/Invalid submission status transition/);

    // Quarantining a staged (unactivated) version still blocks unquarantine.
    const stagedSub = db.createSubmission({
      agentId: agAlpha.id,
      version: '1.1.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/alpha-110-r2.tar.zst',
      sha256: '8'.repeat(64),
      ladderIds: ['gen9randombattle'],
      now: 1_760_002_036,
    });
    db.applySubmissionStatus({
      versionId: stagedSub.id,
      smokeStatus: 'staged',
      now: 1_760_002_037,
    });
    db.quarantineVersion('alpha', '1.1.0', 'Manual quarantine of staged version', 1_760_002_038);
    expect(() => db.unquarantineVersion('alpha', '1.1.0', 1_760_002_040))
      .toThrow(/never passed smoke testing/);
  });

  test('applySubmissionStatus rejects regressions from passed to failed', () => {
    expect(() =>
      db.applySubmissionStatus({
        versionId: versionIds[0],
        smokeStatus: 'failed',
        smokeError: 'Late bogus fail',
        now: 1_760_002_050,
      })).toThrow(/Invalid submission status transition/);
  });

  test('disabling a removed project retires its active ladder entries', () => {
    expect(
      db.getLeaderboardEntries('gen9randombattle').find(e => e.agentSlug === 'alpha')?.rankCurrent
    ).toBe(1);
    db.syncProjectsFromYaml(`
- name: Beta
  active: 2026
  arena:
    owners:
      b: b.2
- name: Gamma
  active: 2026
  arena:
    owners:
      c: c.3
`, undefined, 1_760_002_100);
    const entries = db.getLeaderboardEntries('gen9randombattle');
    expect(entries.find(e => e.agentSlug === 'alpha')?.role).toBe('retired');
    expect(entries.find(e => e.agentSlug === 'alpha')?.rankCurrent).toBeUndefined();
    expect(entries.find(e => e.agentSlug === 'beta')?.rankCurrent).toBe(1);
  });

  test('archiving a ladder closes open Top-K reign clocks', () => {
    const beforeRow = db.db.prepare(
      'SELECT top1_entered_at FROM ladder_entries WHERE ladder_id = ? AND version_id = ?'
    ).get('gen9randombattle', versionIds[0]) as {top1_entered_at: number | null};
    expect(beforeRow.top1_entered_at).not.toBeNull();

    db.setLadderStatus('gen9randombattle', 'archived', 1_760_004_000);
    const afterRow = db.db.prepare(
      'SELECT top1_entered_at FROM ladder_entries WHERE ladder_id = ? AND version_id = ?'
    ).get('gen9randombattle', versionIds[0]) as {top1_entered_at: number | null};
    expect(afterRow.top1_entered_at).toBeNull();
  });

  test('unquarantineVersion restores quarantined ladder ranks', () => {
    db.quarantineVersion('beta', '1.0.0', 'Timeout loop', 1_760_002_000);
    db.unquarantineVersion('beta', '1.0.0', 1_760_002_040);
    expect(
      db.getLeaderboardEntries('gen9randombattle').find(e => e.agentSlug === 'beta')?.rankCurrent
    ).toBe(2);
  });

  test('unquarantineVersion restores scheduled tournament entrants', () => {
    db.refundCooldown('alpha', 1_760_002_005);
    const agAlpha = db.getAgentBySlug('alpha')!;
    db.upsertTournament({
      id: '9',
      name: 'Tour 9',
      format: 'gen9ou',
      version: '0.11.0',
      startsAt: 1_770_000_000,
      status: 'scheduled',
      gamesPerMatchup: 8,
      parallelTables: 4,
      hardware: 'L4',
    });
    const tourSub = db.createSubmission({
      agentId: agAlpha.id,
      version: '2.0.0-oci',
      package: 'oci',
      url: 'ghcr.io/pkmn/alpha:2.0.0',
      sha256: '8'.repeat(64),
      ladderIds: [],
      tournamentIds: ['9'],
      now: 1_760_003_000,
    });
    db.applySubmissionStatus({versionId: tourSub.id, smokeStatus: 'passed', now: 1_760_003_010});
    expect(db.getTournamentEntrants('9')).toHaveLength(1);

    db.quarantineVersion('alpha', '2.0.0-oci', 'Spot check', 1_760_003_020);
    expect(db.getTournamentEntrants('9')).toHaveLength(0);

    db.unquarantineVersion('alpha', '2.0.0-oci', 1_760_003_030);
    expect(db.getTournamentEntrants('9')).toHaveLength(1);
  });

  test('archived ladders freeze ranks against rating recomputation, anchors, or new matches',
    () => {
      db.setLadderStatus('gen9randombattle', 'archived', 1_760_004_000);
      db.recomputeLadderRatings('gen9randombattle', 1_760_004_100);
      const frozen = db.getLeaderboardEntries('gen9randombattle');
      expect(frozen.find(e => e.agentSlug === 'alpha')?.rankCurrent).toBe(1);
      expect(frozen.every(e => e.role === 'retired')).toBe(true);
      expect(() => db.setLadderAnchor('gen9randombattle', 'alpha', '1.0.0', 1_760_004_200))
        .toThrow(/archived/);
      expect(() => db.recordCompletedMatch({
        match: {
          id: 'rand-late',
          ladderId: 'gen9randombattle',
          p1VersionId: versionIds[0],
          p2VersionId: versionIds[1],
          seed: '1,2,3,4',
          game1Outcome: 'W',
          game2Outcome: 'W',
          category: 'WW',
          game1Turns: 5,
          game2Turns: 5,
          game1EndReason: 'normal',
          game2EndReason: 'normal',
          p1Game1PeakRam: 64,
          p1Game2PeakRam: 64,
          p2Game1PeakRam: 64,
          p2Game2PeakRam: 64,
          p1Game1BankSeconds: 100,
          p1Game2BankSeconds: 100,
          p2Game1BankSeconds: 100,
          p2Game2BankSeconds: 100,
          p1Game1MeanTurnMillis: 50,
          p1Game2MeanTurnMillis: 50,
          p2Game1MeanTurnMillis: 50,
          p2Game2MeanTurnMillis: 50,
          completedAt: 1_760_004_300,
        },
      })).toThrow(/archived/);
    });
});

describe('tournament standings', () => {
  let db: database.Database;

  beforeEach(() => {
    db = new database.Database(':memory:');
    db.syncProjectsFromYaml(`
- name: Entrant A
  active: 2026
  arena:
    owners:
      ea: ea.101
- name: Entrant B
  active: 2026
  arena:
    owners:
      eb: eb.102
- name: Entrant C
  active: 2026
  arena:
    owners:
      ec: ec.103
`, undefined, 1_760_000_300);
    db.upsertTournament({
      id: 'sf-test',
      name: 'SF Tiebreak',
      format: 'gen9ou',
      version: '0.11.0',
      startsAt: 1_780_000_000,
      status: 'scheduled',
      gamesPerMatchup: 2,
      parallelTables: 2,
      hardware: 'L4',
    });
    const entVers = ['entrant-a', 'entrant-b', 'entrant-c'].map((slug, idx) => {
      const ag = db.getAgentBySlug(slug)!;
      const sub = db.createSubmission({
        agentId: ag.id,
        version: '1.0.0',
        package: 'oci',
        url: `ghcr.io/pkmn/${slug}:1.0.0`,
        sha256: String(idx + 3).repeat(64),
        ladderIds: [],
        tournamentIds: ['sf-test'],
        now: 1_760_000_310 + idx,
      });
      db.applySubmissionStatus({versionId: sub.id, smokeStatus: 'passed', now: 1_760_000_320});
      return sub;
    });

    const rrGames: Array<[number, number, 'W' | 'L']> = [
      [entVers[0].id, entVers[1].id, 'W'],
      [entVers[0].id, entVers[1].id, 'W'],
      [entVers[0].id, entVers[2].id, 'W'],
      [entVers[0].id, entVers[2].id, 'W'],
      [entVers[1].id, entVers[2].id, 'W'],
      [entVers[1].id, entVers[2].id, 'L'],
    ];
    rrGames.forEach(([p1, p2, outcome], i) => {
      db.recordCompletedTournamentGame({
        id: `rr-${i + 1}`,
        tournamentId: 'sf-test',
        stage: 'Round Robin',
        cycle: 1,
        matchupGame: i + 1,
        outcome,
        p1: {versionId: p1, team: 'Pikachu|||static|||||||]'},
        p2: {versionId: p2, team: 'Pikachu|||static|||||||]'},
        games: [
          {
            gameNumber: 1,
            seed: '1,2,3,4',
            outcome,
            turns: 10,
            endReason: 'normal',
            p1: {bankSeconds: 100},
            p2: {bankSeconds: 100},
          },
        ],
        completedAt: 1_780_001_000 + i,
      });
    });
    for (let i = 0; i < 10; i++) {
      db.recordCompletedTournamentGame({
        id: `sf-${i + 1}`,
        tournamentId: 'sf-test',
        stage: 'Superfinal',
        cycle: 1,
        matchupGame: i + 1,
        outcome: 'W',
        p1: {versionId: entVers[0].id, team: 'Pikachu|||static|||||||]'},
        p2: {versionId: entVers[1].id, team: 'Pikachu|||static|||||||]'},
        games: [
          {
            gameNumber: 1,
            seed: '1,2,3,4',
            outcome: 'W',
            turns: 10,
            endReason: 'normal',
            p1: {bankSeconds: 100},
            p2: {bankSeconds: 100},
          },
        ],
        completedAt: 1_780_002_000 + i,
      });
    }
    db.setTournamentStatus('sf-test', 'completed', 1_780_003_000);
  });

  afterEach(() => {
    db.close();
  });

  test('excludes Superfinal games from Stage 1 Round Robin tiebreak Elo', () => {
    const finalEntrants = db.getTournamentEntrants('sf-test');
    expect(finalEntrants.map(e => [e.agentSlug, e.finalRank])).toEqual([
      ['entrant-a', 1],
      ['entrant-b', 2],
      ['entrant-c', 3],
    ]);
  });

  test('clears finalRank when a completed tournament is reopened to running', () => {
    db.setTournamentStatus('sf-test', 'running', 1_780_003_100);
    expect(db.getTournamentEntrants('sf-test').every(e => e.finalRank === undefined)).toBe(true);
  });

  test('getTournamentBestOf infers N for Best-of-N rules or formats', () => {
    expect(database.getTournamentBestOf('gen9ou', undefined)).toBe(1);
    expect(database.getTournamentBestOf('gen1ou', ['Sleep Clause Mod'])).toBe(1);
    expect(
      database.getTournamentBestOf('gen9championsvgc2026regmc', ['Open Team Sheets', 'Best of = 3'])
    ).toBe(3);
    expect(database.getTournamentBestOf('gen9championsvgc2026regmc', '["Best-of-3"]')).toBe(3);
    expect(database.getTournamentBestOf('gen9vgc2026regibo3', undefined)).toBe(3);
    expect(database.getTournamentBestOf('gen9vgc2026regibo5', ['Best of = 5'])).toBe(5);
  });

  test('persists Best-of-N per-game telemetry in tournament_games linked to matches', () => {
    db.upsertTournament({
      id: 'bo3-tour',
      name: 'VGC Bo3 Tour',
      format: 'gen9championsvgc2026regmc',
      version: '0.11.0',
      rulesJson: JSON.stringify(['Open Team Sheets', 'Best of = 3']),
      startsAt: 1_785_000_000,
      status: 'running',
      gamesPerMatchup: 4,
      parallelTables: 2,
      hardware: 'L4',
    });
    expect(db.getTournament('bo3-tour')?.bestOf).toBe(3);

    const entVers = db.getTournamentEntrants('sf-test');
    for (const e of entVers) {
      db.upsertTournamentEntrant({
        tournamentId: 'bo3-tour',
        agentId: e.agentId,
        versionId: e.versionId,
        seed: e.seed,
      });
    }
    const recorded = db.recordCompletedTournamentGame({
      id: 'bo3-m1',
      tournamentId: 'bo3-tour',
      stage: 'Round Robin',
      cycle: 1,
      matchupGame: 1,
      outcome: 'W',
      p1: {versionId: entVers[0].versionId, team: 'Pikachu|||static|||||||]'},
      p2: {versionId: entVers[1].versionId, team: 'Pikachu|||static|||||||]'},
      games: [
        {
          gameNumber: 1,
          seed: '1,2,3,4',
          outcome: 'W',
          turns: 8,
          endReason: 'normal',
          p1: {
            bankSeconds: 135,
            initMillis: 950,
            teamPreviewMillis: 420,
            meanTurnMillis: 290,
            peakRam: 1200,
          },
          p2: {
            bankSeconds: 120,
            initMillis: 600,
            teamPreviewMillis: 310,
            meanTurnMillis: 400,
            peakRam: 1400,
          },
        },
        {
          gameNumber: 2,
          seed: '5,6,7,8',
          outcome: 'L',
          turns: 10,
          endReason: 'normal',
          p1: {bankSeconds: 118, meanTurnMillis: 320, peakRam: 1220},
          p2: {bankSeconds: 130, meanTurnMillis: 410, peakRam: 1450},
        },
        {
          gameNumber: 3,
          seed: '9,10,11,12',
          outcome: 'W',
          turns: 9,
          endReason: 'timeout',
          p1: {bankSeconds: 112, meanTurnMillis: 320, peakRam: 1240},
          p2: {bankSeconds: 0, meanTurnMillis: 450, peakRam: 1480},
        },
      ],
      completedAt: 1_785_000_500,
    });
    expect(recorded.duplicate).toBe(false);
    expect(recorded.game.games).toHaveLength(3);
    expect(recorded.game.games[1].seed).toBe('5,6,7,8');
    expect(recorded.game.games[2].seed).toBe('9,10,11,12');
    expect(recorded.game.games.map(g => g.outcome)).toEqual(['W', 'L', 'W']);
    expect(recorded.game.games.map(g => g.turns)).toEqual([8, 10, 9]);
    expect(recorded.game.games[2].endReason).toBe('timeout');
    expect(recorded.game.games[2].p1.bankSeconds).toBe(112);
    expect(recorded.game.games[2].p2.bankSeconds).toBe(0);
    expect(recorded.game.games[0].p1.initMillis).toBe(950);
    expect(recorded.game.games[0].p1.teamPreviewMillis).toBe(420);
    expect(recorded.game.games[0].p2.initMillis).toBe(600);
    expect(recorded.game.games[0].p2.teamPreviewMillis).toBe(310);
    expect(recorded.game.games[2].p1.meanTurnMillis).toBe(320);
    expect(recorded.game.games[2].p2.peakRam).toBe(1480);
  });

  const createTelemetryDb = () => {
    const telDb = new database.Database(':memory:', {now: 1_760_000_000});
    telDb.syncLadders(database.LADDERS_FILE, 1_760_000_000);
    telDb.syncProjectsFromYaml(`
- slug: alpha
  name: Alpha
  arena:
    developers:
      - github: alpha-dev
- slug: beta
  name: Beta
  arena:
    developers:
      - github: beta-dev
`, undefined, 1_760_000_000);
    telDb.setAgentLadders('alpha', database.ALL_SLOTS, 1_760_000_000);
    telDb.setAgentLadders('beta', database.ALL_SLOTS, 1_760_000_000);
    const alpha = telDb.getAgentBySlug('alpha')!;
    const beta = telDb.getAgentBySlug('beta')!;
    const vA = telDb.createSubmission({
      agentId: alpha.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://example.com/a.tar.gz',
      sha256: 'a'.repeat(64),
      ladderIds: ['gen9ou20261109', 'gen1ou20261109'],
      now: 1_760_000_010,
    });
    const vB = telDb.createSubmission({
      agentId: beta.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://example.com/b.tar.gz',
      sha256: 'b'.repeat(64),
      ladderIds: ['gen9ou20261109', 'gen1ou20261109'],
      now: 1_760_000_010,
    });
    telDb.applySubmissionStatus({
      versionId: vA.id,
      smokeStatus: 'passed',
      smokeDurationMillis: 1500,
      smokeInitMillis: 700,
      smokeTeamPreviewMillis: 250,
      smokeTurnMillis: 90,
      smokePeakRam: 100,
      now: 1_760_000_020,
    });
    telDb.applySubmissionStatus({versionId: vB.id, smokeStatus: 'passed', now: 1_760_000_020});
    return {telDb, alpha, vA, vB};
  };

  test('persists smoke timing telemetry on passed agent versions', () => {
    const {telDb, vA} = createTelemetryDb();
    try {
      const vAPassed = telDb.getVersionById(vA.id)!;
      expect(vAPassed.smokeInitMillis).toBe(700);
      expect(vAPassed.smokeTeamPreviewMillis).toBe(250);
      expect(vAPassed.smokeTurnMillis).toBe(90);
    } finally {
      telDb.close();
    }
  });

  test('averages per-ladder init, team preview, turn, mean RAM telemetry across matches', () => {
    const {telDb, alpha, vA, vB} = createTelemetryDb();
    try {
      telDb.recordCompletedMatch({
        match: {
          id: 'sv-m1',
          ladderId: 'gen9ou20261109',
          p1VersionId: vA.id,
          p2VersionId: vB.id,
          seed: '1,2,3,4',
          game1Outcome: 'W',
          game2Outcome: 'W',
          category: 'WW',
          game1Turns: 10,
          game2Turns: 12,
          game1EndReason: 'normal',
          game2EndReason: 'normal',
          p1Game1PeakRam: 200,
          p1Game2PeakRam: 400,
          p2Game1PeakRam: 100,
          p2Game2PeakRam: 100,
          p1Game1BankSeconds: 140,
          p1Game2BankSeconds: 140,
          p2Game1BankSeconds: 140,
          p2Game2BankSeconds: 140,
          p1Game1InitMillis: 1000,
          p1Game2InitMillis: 2000,
          p2Game1InitMillis: 500,
          p2Game2InitMillis: 500,
          p1Game1TeamPreviewMillis: 300,
          p1Game2TeamPreviewMillis: 500,
          p2Game1TeamPreviewMillis: 100,
          p2Game2TeamPreviewMillis: 100,
          p1Game1MeanTurnMillis: 100,
          p1Game2MeanTurnMillis: 200,
          p2Game1MeanTurnMillis: 50,
          p2Game2MeanTurnMillis: 50,
          completedAt: 1_760_000_100,
        },
      });
      telDb.recordCompletedMatch({
        match: {
          id: 'sv-m2',
          ladderId: 'gen9ou20261109',
          p1VersionId: vA.id,
          p2VersionId: vB.id,
          seed: '5,6,7,8',
          game1Outcome: 'W',
          game2Outcome: 'L',
          category: 'WL',
          game1Turns: 10,
          game2Turns: 12,
          game1EndReason: 'normal',
          game2EndReason: 'normal',
          p1Game1PeakRam: 600,
          p1Game2PeakRam: 600,
          p2Game1PeakRam: 100,
          p2Game2PeakRam: 100,
          p1Game1BankSeconds: 140,
          p1Game2BankSeconds: 140,
          p2Game1BankSeconds: 140,
          p2Game2BankSeconds: 140,
          p1Game1InitMillis: 2500,
          p1Game2InitMillis: 2500,
          p2Game1InitMillis: 500,
          p2Game2InitMillis: 500,
          p1Game1TeamPreviewMillis: 600,
          p1Game2TeamPreviewMillis: 600,
          p2Game1TeamPreviewMillis: 100,
          p2Game2TeamPreviewMillis: 100,
          p1Game1MeanTurnMillis: 250,
          p1Game2MeanTurnMillis: 250,
          p2Game1MeanTurnMillis: 50,
          p2Game2MeanTurnMillis: 50,
          completedAt: 1_760_000_200,
        },
      });

      const svEntry = telDb.getAgentLadderProfileEntries(alpha.id, 'gen9ou20261109')[0];
      expect(svEntry.meanInitMillis).toBe(2000);
      expect(svEntry.meanTeamPreviewMillis).toBe(500);
      expect(svEntry.meanTurnMillis).toBe(200);
      expect(svEntry.meanRam).toBe(450);
      expect(svEntry.peakRam).toBe(600);
    } finally {
      telDb.close();
    }
  });

  test('leaves meanTeamPreviewMillis undefined on ladders without team preview', () => {
    const {telDb, alpha, vA, vB} = createTelemetryDb();
    try {
      telDb.recordCompletedMatch({
        match: {
          id: 'rby-m1',
          ladderId: 'gen1ou20261109',
          p1VersionId: vA.id,
          p2VersionId: vB.id,
          seed: '9,10,11,12',
          game1Outcome: 'W',
          game2Outcome: 'W',
          category: 'WW',
          game1Turns: 15,
          game2Turns: 15,
          game1EndReason: 'normal',
          game2EndReason: 'normal',
          p1Game1PeakRam: 120,
          p1Game2PeakRam: 140,
          p2Game1PeakRam: 100,
          p2Game2PeakRam: 100,
          p1Game1BankSeconds: 140,
          p1Game2BankSeconds: 140,
          p2Game1BankSeconds: 140,
          p2Game2BankSeconds: 140,
          p1Game1InitMillis: 800,
          p1Game2InitMillis: 800,
          p2Game1InitMillis: 400,
          p2Game2InitMillis: 400,
          p1Game1MeanTurnMillis: 80,
          p1Game2MeanTurnMillis: 100,
          p2Game1MeanTurnMillis: 40,
          p2Game2MeanTurnMillis: 40,
          completedAt: 1_760_000_300,
        },
      });

      const rbyEntry = telDb.getAgentLadderProfileEntries(alpha.id, 'gen1ou20261109')[0];
      expect(rbyEntry.meanInitMillis).toBe(800);
      expect(rbyEntry.meanTeamPreviewMillis).toBeUndefined();
      expect(rbyEntry.meanTurnMillis).toBe(90);
      expect(rbyEntry.meanRam).toBe(130);
      expect(rbyEntry.peakRam).toBe(140);
    } finally {
      telDb.close();
    }
  });

  test('getRecentMatchesForAgentOnLadder deduplicates self-play across versions', () => {
    const {telDb, alpha, vA, vB} = createTelemetryDb();
    try {
      const vA2 = telDb.createSubmission({
        agentId: alpha.id,
        version: '2.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/alpha-v2.tar.zst',
        sha256: 'c'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_760_000_000 + 15 * 86_400,
      });
      telDb.applySubmissionStatus({
        versionId: vA2.id,
        smokeStatus: 'passed',
        now: 1_760_000_010 + 15 * 86_400,
      });
      const base = {
        ladderId: 'gen1ou20261109',
        seed: '1,2,3,4',
        game1Outcome: 'W' as const,
        game2Outcome: 'L' as const,
        category: 'WL' as const,
        game1Turns: 12,
        game2Turns: 14,
        game1EndReason: 'normal',
        game2EndReason: 'normal',
        p1Game1PeakRam: 100,
        p1Game2PeakRam: 100,
        p2Game1PeakRam: 100,
        p2Game2PeakRam: 100,
        p1Game1BankSeconds: 140,
        p1Game2BankSeconds: 140,
        p2Game1BankSeconds: 140,
        p2Game2BankSeconds: 140,
        p1Game1InitMillis: 500,
        p1Game2InitMillis: 500,
        p2Game1InitMillis: 500,
        p2Game2InitMillis: 500,
        p1Game1MeanTurnMillis: 50,
        p1Game2MeanTurnMillis: 50,
        p2Game1MeanTurnMillis: 50,
        p2Game2MeanTurnMillis: 50,
      };
      telDb.recordCompletedMatch({
        match: {...base, id: 'm-1', p1VersionId: vA.id, p2VersionId: vB.id, completedAt: 100},
      });
      telDb.recordCompletedMatch({
        match: {...base, id: 'm-2', p1VersionId: vA.id, p2VersionId: vA2.id, completedAt: 200},
      });
      telDb.recordCompletedMatch({
        match: {...base, id: 'm-3', p1VersionId: vB.id, p2VersionId: vA2.id, completedAt: 300},
      });

      const recent = telDb.getRecentMatchesForAgentOnLadder(alpha.id, 'gen1ou20261109', 10);
      expect(recent.map(m => m.id)).toEqual(['m-3', 'm-2', 'm-1']);
    } finally {
      telDb.close();
    }
  });

  test('getRecentMatchesForAgentOnLadder returns empty array for non-positive limits', () => {
    const {telDb, alpha, vA, vB} = createTelemetryDb();
    try {
      telDb.recordCompletedMatch({
        match: {
          id: 'm-limit-1',
          ladderId: 'gen1ou20261109',
          p1VersionId: vA.id,
          p2VersionId: vB.id,
          seed: '1,2,3,4',
          game1Outcome: 'W',
          game2Outcome: 'L',
          category: 'WL',
          game1Turns: 12,
          game2Turns: 14,
          game1EndReason: 'normal',
          game2EndReason: 'normal',
          p1Game1PeakRam: 100,
          p1Game2PeakRam: 100,
          p2Game1PeakRam: 100,
          p2Game2PeakRam: 100,
          p1Game1BankSeconds: 140,
          p1Game2BankSeconds: 140,
          p2Game1BankSeconds: 140,
          p2Game2BankSeconds: 140,
          p1Game1InitMillis: 500,
          p1Game2InitMillis: 500,
          p2Game1InitMillis: 500,
          p2Game2InitMillis: 500,
          p1Game1MeanTurnMillis: 50,
          p1Game2MeanTurnMillis: 50,
          p2Game1MeanTurnMillis: 50,
          p2Game2MeanTurnMillis: 50,
          completedAt: 100,
        },
      });
      expect(telDb.getRecentMatchesForAgentOnLadder(alpha.id, 'gen1ou20261109', 0)).toEqual([]);
      expect(telDb.getRecentMatchesForAgentOnLadder(alpha.id, 'gen1ou20261109', -1)).toEqual([]);
    } finally {
      telDb.close();
    }
  });

  test('getMatchesPage filters ladder matches per agent with MULTI-INDEX OR predicate', () => {
    const {telDb, vA, vB} = createTelemetryDb();
    try {
      telDb.db.prepare("UPDATE ladders SET status = 'active' WHERE id = 'gen3ou20261109'").run();
      const base = {
        seed: '1,2,3,4',
        game1Outcome: 'W' as const,
        game2Outcome: 'L' as const,
        category: 'WL' as const,
        game1Turns: 12,
        game2Turns: 14,
        game1EndReason: 'normal',
        game2EndReason: 'normal',
        p1Game1PeakRam: 100,
        p1Game2PeakRam: 100,
        p2Game1PeakRam: 100,
        p2Game2PeakRam: 100,
        p1Game1BankSeconds: 140,
        p1Game2BankSeconds: 140,
        p2Game1BankSeconds: 140,
        p2Game2BankSeconds: 140,
        p1Game1InitMillis: 500,
        p1Game2InitMillis: 500,
        p2Game1InitMillis: 500,
        p2Game2InitMillis: 500,
        p1Game1MeanTurnMillis: 50,
        p1Game2MeanTurnMillis: 50,
        p2Game1MeanTurnMillis: 50,
        p2Game2MeanTurnMillis: 50,
      };
      telDb.recordCompletedMatch({
        match: {
          ...base,
          id: 'rby-1',
          ladderId: 'gen1ou20261109',
          p1VersionId: vA.id,
          p2VersionId: vB.id,
          completedAt: 100,
        },
      });
      telDb.recordCompletedMatch({
        match: {
          ...base,
          id: 'rby-2',
          ladderId: 'gen1ou20261109',
          p1VersionId: vB.id,
          p2VersionId: vA.id,
          completedAt: 200,
        },
      });
      telDb.recordCompletedMatch({
        match: {
          ...base,
          id: 'adv-1',
          ladderId: 'gen3ou20261109',
          p1VersionId: vA.id,
          p2VersionId: vB.id,
          completedAt: 300,
        },
      });

      const byAgent = telDb.getMatchesPage({
        ladderId: 'gen1ou20261109',
        agentSlug: 'alpha',
      });
      expect(byAgent.total).toBe(2);
      expect(byAgent.matches.map(m => m.id)).toEqual(['rby-2', 'rby-1']);

      const byPair = telDb.getMatchesPage({
        ladderId: 'gen1ou20261109',
        agentSlug: 'alpha',
        opponentSlug: 'beta',
      });
      expect(byPair.total).toBe(2);
      expect(byPair.matches.map(m => m.id)).toEqual(['rby-2', 'rby-1']);

      const plan = telDb.db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT COUNT(*) AS count
        FROM matches m
        WHERE ((m.ladder_id = ? AND m.p1_version_id IN (?))
          OR (m.ladder_id = ? AND m.p2_version_id IN (?)))
      `).all('gen1ou20261109', vA.id, 'gen1ou20261109', vA.id) as Array<{detail: string}>;
      expect(plan.map(p => p.detail).join('\n')).toContain('MULTI-INDEX OR');
    } finally {
      telDb.close();
    }
  });

  test('getRatingSnapshotsForLadder filters by agentId in chronological order per version', () => {
    const {telDb, alpha, vA, vB} = createTelemetryDb();
    try {
      const ins = telDb.db.prepare(`
        INSERT INTO rating_snapshots (ladder_id, version_id, day_utc, matches, elo, se, lcb, gxe)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      ins.run('gen1ou20261109', vA.id, '2026-11-12', 12, 1620, 40, 1540, 62);
      ins.run('gen1ou20261109', vA.id, '2026-11-10', 4, 1550, 60, 1430, 55);
      ins.run('gen1ou20261109', vB.id, '2026-11-11', 8, 1480, 50, 1380, 48);

      const alphaSnaps = telDb.getRatingSnapshotsForLadder('gen1ou20261109', alpha.id);
      expect(alphaSnaps.map(s => `${s.versionId}:${s.dayUtc}`)).toEqual([
        `${vA.id}:2026-11-10`,
        `${vA.id}:2026-11-12`,
      ]);
    } finally {
      telDb.close();
    }
  });

  test('getRatingSnapshotsForLadder filters by multiple agent IDs', () => {
    const {telDb, alpha, vA, vB} = createTelemetryDb();
    try {
      const beta = telDb.getAgentBySlug('beta')!;
      const ins = telDb.db.prepare(`
        INSERT INTO rating_snapshots (ladder_id, version_id, day_utc, matches, elo, se, lcb, gxe)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      ins.run('gen1ou20261109', vA.id, '2026-11-10', 4, 1550, 60, 1430, 55);
      ins.run('gen1ou20261109', vB.id, '2026-11-11', 8, 1480, 50, 1380, 48);

      const filtered = telDb.getRatingSnapshotsForLadder('gen1ou20261109', [alpha.id, beta.id]);
      expect(filtered.map(s => `${s.agentId}:${s.dayUtc}`)).toEqual([
        `${alpha.id}:2026-11-10`,
        `${beta.id}:2026-11-11`,
      ]);
    } finally {
      telDb.close();
    }
  });

  test('getPairAggregatesForAgentOnLadder returns only pairs involving that agent', () => {
    const {telDb, alpha, vA, vB} = createTelemetryDb();
    try {
      telDb.syncProjectsFromYaml(`
- name: Alpha
  active: 2026
  arena:
    owners:
      alpha: alpha.1
- name: Beta
  active: 2026
  arena:
    owners:
      beta: beta.2
- name: Gamma
  active: 2026
  arena:
    owners:
      gamma: gamma.3
`, undefined, 1_760_000_000);
      telDb.setAgentLadders('gamma', database.ALL_SLOTS, 1_760_000_000);
      const gamma = telDb.getAgentBySlug('gamma')!;
      const vG = telDb.createSubmission({
        agentId: gamma.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/gamma.tar.zst',
        sha256: 'd'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_760_000_010,
      });
      telDb.applySubmissionStatus({versionId: vG.id, smokeStatus: 'passed', now: 1_760_000_020});
      const insPair = telDb.db.prepare(`
        INSERT INTO pair_aggregates (
          ladder_id, low_version_id, high_version_id, ww, wt, split, tl, ll
        )
        VALUES ('gen1ou20261109', ?, ?, 2, 0, 1, 0, 0)
      `);
      insPair.run(Math.min(vA.id, vB.id), Math.max(vA.id, vB.id));
      insPair.run(Math.min(vB.id, vG.id), Math.max(vB.id, vG.id));

      const alphaPairs = telDb.getPairAggregatesForAgentOnLadder('gen1ou20261109', alpha.id);
      expect(alphaPairs).toHaveLength(1);
      expect([alphaPairs[0].lowVersionId, alphaPairs[0].highVersionId]).toEqual([
        Math.min(vA.id, vB.id),
        Math.max(vA.id, vB.id),
      ]);
    } finally {
      telDb.close();
    }
  });

  test('getLadderHubSummaries computes entrant count, match count, plus #1 winner', () => {
    const {telDb, vA, vB} = createTelemetryDb();
    try {
      telDb.db.prepare("UPDATE ladders SET status = 'active' WHERE id = 'gen1ou20261109'").run();
      telDb.db.prepare(`
        UPDATE ladder_entries
        SET matches = 12, ww = 8, ll = 4, elo = 1640, se = 35,
            lcb = 1571, gxe = 68.4, rank_current = 1
        WHERE ladder_id = 'gen1ou20261109' AND version_id = ?
      `).run(vA.id);
      telDb.db.prepare(`
        UPDATE ladder_entries
        SET matches = 12, ww = 4, ll = 8, elo = 1360, se = 35,
            lcb = 1291, gxe = 31.6, rank_current = 2
        WHERE ladder_id = 'gen1ou20261109' AND version_id = ?
      `).run(vB.id);

      const summary = telDb.getLadderHubSummaries().get('gen1ou20261109');
      expect(summary).toEqual({
        entrantCount: 2,
        matchCount: 12,
        hasActiveEntries: true,
        top1: {
          slug: 'alpha',
          name: 'Alpha',
          version: '1.0.0',
          elo: 1640,
          ci95: 69,
          gxe: 68.4,
          wins: 8,
          losses: 4,
          ties: 0,
        },
      });
    } finally {
      telDb.close();
    }
  });

  test('getLatestAgentLadderArtifact returns the newest passed ladder submission artifact', () => {
    const {telDb, alpha} = createTelemetryDb();
    try {
      telDb.refundCooldown('alpha', 1_760_000_050);
      const v2 = telDb.createSubmission({
        agentId: alpha.id,
        version: '2.0.0',
        package: 'oci',
        url: 'https://github.com/pkmn/alpha-2.0.0.tar',
        sha256: 'c'.repeat(64),
        ladderIds: ['gen3ou20261109'],
        now: 1_760_000_100,
      });
      telDb.applySubmissionStatus({
        versionId: v2.id,
        smokeStatus: 'passed',
        unpackedBytes: 128 * 1024 * 1024,
        now: 1_760_000_110,
      });
      expect(telDb.getLatestAgentLadderArtifact(alpha.id)).toEqual({
        package: 'oci',
        unpackedBytes: 128 * 1024 * 1024,
      });
    } finally {
      telDb.close();
    }
  });

  test('getTournamentGames paginates completed games with offset', () => {
    const {telDb, alpha, vA, vB} = createTelemetryDb();
    try {
      const beta = telDb.getAgentBySlug('beta')!;
      telDb.upsertTournament({
        id: '9',
        name: 'Tournament #9',
        format: 'gen1ou',
        version: '0.11.0',
        gamesPerMatchup: 6,
        parallelTables: 1,
        hardware: 'Mac mini M4',
        status: 'running',
        startsAt: 1_760_000_000,
      });
      telDb.upsertTournamentEntrant({
        tournamentId: '9',
        agentId: alpha.id,
        versionId: vA.id,
        seed: 1,
      });
      telDb.upsertTournamentEntrant({
        tournamentId: '9',
        agentId: beta.id,
        versionId: vB.id,
        seed: 2,
      });
      for (let i = 1; i <= 5; i++) {
        telDb.upsertTournamentGame({
          id: `t9-g${i}`,
          tournamentId: '9',
          stage: 'Round Robin',
          cycle: i,
          matchupGame: i,
          status: 'completed',
          outcome: 'W',
          p1: {versionId: vA.id},
          p2: {versionId: vB.id},
          games: [{gameNumber: 1, seed: `1,2,3,${i}`, outcome: 'W', turns: 12}],
          completedAt: 1_760_000_000 + i * 10,
        });
      }
      telDb.upsertTournamentGame({
        id: 't9-pending',
        tournamentId: '9',
        stage: 'Round Robin',
        cycle: 6,
        matchupGame: 6,
        status: 'pending',
        p1: {versionId: vA.id},
        p2: {versionId: vB.id},
      });

      expect(telDb.countTournamentGames('9')).toBe(5);
      expect(telDb.getTournamentGames('9', 2, 0).map(g => g.id)).toEqual(['t9-g5', 't9-g4']);
      expect(telDb.getTournamentGames('9', 2, 2).map(g => g.id)).toEqual(['t9-g3', 't9-g2']);
      expect(telDb.getTournamentGames('9', 2, 4).map(g => g.id)).toEqual(['t9-g1']);
      expect(telDb.getTournamentGames('9', 0, 0)).toEqual([]);
    } finally {
      telDb.close();
    }
  });
});

describe('per-ladder qualification & migrations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-agent-ladders-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('migrates populated database through 0005–0008 matching fresh schema', () => {
    const preSchemaDir = path.join(tmpDir, 'pre-schema');
    const emptyMigDir = path.join(tmpDir, 'empty-mig');
    fs.mkdirSync(preSchemaDir, {recursive: true});
    fs.mkdirSync(emptyMigDir, {recursive: true});
    for (const file of fs.readdirSync(database.SCHEMA_DIR)) {
      if (
        file === 'agent-ladders.sql' ||
        file === 'config.sql' ||
        file === 'smoke-diagnostics.sql' ||
        file === 'discord-watches.sql' ||
        !file.endsWith('.sql')
      ) {
        continue;
      }
      let sql = fs.readFileSync(path.join(database.SCHEMA_DIR, file), 'utf8');
      if (file === 'agents.sql') {
        sql = sql
          .split('\n')
          .filter(line => !/^\s*unlimited_smoke_tests\b/.test(line))
          .join('\n')
          .replace(/updated_at INTEGER NOT NULL,/, 'updated_at INTEGER NOT NULL');
      }
      if (file === 'ladder-entries.sql') {
        const addedCols = new RegExp(
          '^\\s*(mean_cpu_cores|cpu_matches|invalid_choices|invalid_cant_move|' +
          'invalid_cant_switch|invalid_target|invalid_other|unavailable_choices)\\b'
        );
        sql = sql.split('\n').filter(line => !addedCols.test(line)).join('\n');
      }
      if (file === 'matches.sql') {
        const addedCols = /^\s*(p1|p2)_game[12]_cpu_cores\b/;
        sql = sql
          .split('\n')
          .filter(line => !addedCols.test(line))
          .join('\n')
          .replace(/completed_at INTEGER NOT NULL,/, 'completed_at INTEGER NOT NULL');
      }
      if (file === 'agent-versions.sql') {
        sql = sql.replace(
          "CHECK (smoke_status IN ('pending', 'staged', 'passed', " +
            "'failed', 'discarded', 'quarantined'))",
          "CHECK (smoke_status IN ('pending', 'passed', 'failed', 'quarantined'))"
        ).replace(
          /notified INTEGER NOT NULL DEFAULT 0 CHECK \(notified IN \(0, 1\)\)\n\);/,
          'notified INTEGER NOT NULL DEFAULT 0 CHECK (notified IN (0, 1)),\n' +
            '  UNIQUE (agent_id, version)\n);'
        ).replace(
          /CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_versions_claimed[\s\S]*?;\s*/,
          ''
        );
      }
      fs.writeFileSync(path.join(preSchemaDir, file), sql);
    }

    const dbFile = path.join(tmpDir, 'prod.sqlite');
    const legacyDb = new database.Database(dbFile, {
      schemaDir: preSchemaDir,
      migrationDir: emptyMigDir,
      now: 1_760_000_000,
    });
    legacyDb.db.exec(`
      INSERT INTO ladders (id, slot, name, format, version, team, min, status, created_at) VALUES
        ('gen1ou20261109', 'rby', 'RBY', 'gen1ou', '0.11.0', 'harvested', 2, 'active', 1760000000);
      INSERT INTO tournaments (
        id, name, format, version, games_per_matchup, parallel_tables, hardware,
        status, starts_at
      ) VALUES (
        't1', 'Invitational', 'gen9ou', '0.11.0', 2, 1, '1x A100',
        'scheduled', 1760100000
      );
      INSERT INTO agents (slug, name, status, updated_at) VALUES
        ('magpie', 'Magpie', 'qualified', 1760000000),
        ('mocca', 'Mocca', 'qualified', 1760000000),
        ('missingnozero', 'MissingNo.Zero', 'qualified', 1760000000),
        ('other', 'Other', 'qualified', 1760000000),
        ('retired-proj', 'Retired Proj', 'disabled', 1760000000);
      INSERT INTO developers (agent_id, github_login, smogon_username, created_at) VALUES
        ((SELECT id FROM agents WHERE slug = 'magpie'), 'magpie-dev', 'magpie-smogon', 1760000000);
      INSERT INTO agent_versions (
        agent_id, version, package, url, sha256, ladders_json, tournaments_json,
        smoke_status, submitted_at, activated_at, notified
      ) VALUES (
        (SELECT id FROM agents WHERE slug = 'magpie'),
        '1.0.0', 'bundle', 'https://example.com/magpie.tar.gz',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '["gen1ou20261109"]', '[]', 'passed', 1760000000, 1760000010, 0
      ), (
        (SELECT id FROM agents WHERE slug = 'mocca'),
        '1.0.0', 'bundle', 'https://example.com/mocca.tar.gz',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        '["gen1ou20261109"]', '[]', 'passed', 1760000001, 1760000011, 1
      );
      INSERT INTO ladder_entries (ladder_id, version_id, role, matches, se, started_at) VALUES
        ('gen1ou20261109', 1, 'champion', 30, 25.0, 1760000010),
        ('gen1ou20261109', 2, 'champion', 30, 25.0, 1760000011);
      INSERT INTO matches (
        id, ladder_id, p1_version_id, p2_version_id, seed,
        game1_outcome, game2_outcome, category,
        game1_turns, game2_turns, game1_end_reason, game2_end_reason,
        p1_game1_peak_ram, p1_game2_peak_ram, p2_game1_peak_ram, p2_game2_peak_ram,
        p1_game1_bank_seconds, p1_game2_bank_seconds, p2_game1_bank_seconds, p2_game2_bank_seconds,
        p1_game1_mean_turn_millis, p1_game2_mean_turn_millis,
        p2_game1_mean_turn_millis, p2_game2_mean_turn_millis,
        completed_at
      ) VALUES (
        'm-pre-mig-1', 'gen1ou20261109', 1, 2, '1,2,3,4',
        'W', 'L', 'WL', 12, 14, 'normal', 'normal',
        50, 50, 60, 60, 120, 120, 110, 110, 40, 40, 50, 50, 1760000020
      );
      INSERT INTO pair_aggregates (ladder_id, low_version_id, high_version_id, split) VALUES
        ('gen1ou20261109', 1, 2, 1);
      INSERT INTO rating_snapshots (
        ladder_id, version_id, day_utc, matches, elo, se, lcb, gxe
      ) VALUES
        ('gen1ou20261109', 1, '2025-10-09', 1, 1500, 100, 1300, 50);
      INSERT INTO agent_ladder_stats (ladder_id, agent_id, max_elo_version_id) VALUES
        ('gen1ou20261109', (SELECT id FROM agents WHERE slug = 'magpie'), 1);
      INSERT INTO tournament_entrants (tournament_id, agent_id, version_id, seed) VALUES
        ('t1', (SELECT id FROM agents WHERE slug = 'magpie'), 1, 1),
        ('t1', (SELECT id FROM agents WHERE slug = 'mocca'), 2, 2);
      INSERT INTO tournament_matches (
        id, tournament_id, stage, cycle, matchup_game, p1_version_id, p2_version_id,
        status, outcome, completed_at
      ) VALUES (
        'tm-1', 't1', 'Round Robin', 1, 1, 1, 2, 'completed', 'W', 1760000030
      );
    `);
    legacyDb.close();

    const migratedDb = new database.Database(dbFile, {now: 1_760_000_100});
    const freshDb = new database.Database(':memory:', {now: 1_760_000_100});
    try {
      expect(compareDatabaseSchemas(migratedDb.db, freshDb.db)).toEqual([]);
      expect(migratedDb.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(migratedDb.getAppliedMigrations().map(m => m.version)).toEqual([
        '0001-agent-ladders.sql',
        '0002-sync-agent-status.sql',
        '0003-config.sql',
        '0004-backfill-passed-notified.sql',
        '0005-telemetry-aggregates.sql',
        '0006-smoke-diagnostics.sql',
        '0007-staged-smoke-status.sql',
        '0008-discord-watches.sql',
        '0009-info-status.sql',
        '0010-unlimited-smoke-tests.sql',
      ]);
      expect(migratedDb.getVersionBySlugAndLabel('magpie', '1.0.0')?.notified).toBe(true);
      expect(migratedDb.getPendingVersionDms()).toEqual([]);
      expect(migratedDb.getRecentMatches(10)).toHaveLength(1);
      expect(
        migratedDb.db.prepare('SELECT COUNT(*) AS n FROM tournament_matches').get()
      ).toEqual({n: 1});

      const magpie = migratedDb.getAgentBySlug('magpie')!;
      const mocca = migratedDb.getAgentBySlug('mocca')!;
      const missingno = migratedDb.getAgentBySlug('missingnozero')!;
      const other = migratedDb.getAgentBySlug('other')!;
      const retired = migratedDb.getAgentBySlug('retired-proj')!;

      // Verify post-0007 staged/discarded lifecycle, version-label reuse, and smoke_diagnostics
      // ON DELETE CASCADE on the migrated database.
      const postCooldown = 1_760_000_000 + 15 * 86_400;
      const v2 = migratedDb.createSubmission({
        agentId: magpie.id,
        version: '2.0.0',
        package: 'bundle',
        url: 'https://example.com/magpie-2.0.0.tar.zst',
        sha256: 'c'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: postCooldown,
      });
      migratedDb.applySubmissionStatus({
        versionId: v2.id,
        smokeStatus: 'staged',
        diagnostics: [{
          ladderId: 'gen1ou20261109',
          format: 'gen1ou',
          turns: 5,
          endReason: 'win',
          durationMillis: 1000,
          battleLog: '|turn|1',
        }],
        now: postCooldown + 10,
      });
      migratedDb.discardStagedVersion({versionId: v2.id, agentId: magpie.id});
      expect(migratedDb.getVersionById(v2.id)?.smokeStatus).toBe('discarded');
      const v2Retry = migratedDb.createSubmission({
        agentId: magpie.id,
        version: '2.0.0',
        package: 'bundle',
        url: 'https://example.com/magpie-2.0.0-r2.tar.zst',
        sha256: 'd'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: postCooldown + 20,
      });
      expect(v2Retry.id).toBeGreaterThan(v2.id);
      migratedDb.db.prepare('DELETE FROM agent_versions WHERE id = ?').run(v2.id);
      expect(migratedDb.getSmokeDiagnosticsForVersion(v2.id)).toEqual([]);

      expect(magpie.status).toBe('qualified');
      expect(migratedDb.getAgentLadders(magpie.id)).toEqual(['rby', 'adv']);
      expect(mocca.status).toBe('qualified');
      expect(migratedDb.getAgentLadders(mocca.id)).toEqual(['vgc']);
      expect(missingno.status).toBe('qualified');
      expect(migratedDb.getAgentLadders(missingno.id)).toEqual(['rand']);
      expect(other.status).toBe('pending');
      expect(migratedDb.getAgentLadders(other.id)).toEqual([]);
      expect(retired.status).toBe('disabled');
      expect(migratedDb.getAgentLadders(retired.id)).toEqual([]);
    } finally {
      migratedDb.close();
      freshDb.close();
    }
  });

  test(
    'preserves SQLite grants across syncProjects, rotation, and revoke without retiring',
    async () => {
      const db = new database.Database(':memory:');
      try {
        db.syncLadders(database.LADDERS_FILE, 1_760_000_000);
        const yamlText = `
- name: Magpie
  active: 2025
  arena:
    owners:
      open-cover: opencover.723102
- name: Mocca
  active: 2026
  arena:
    owners:
      lucaspellegrinelli: lucaspll.765230
`;
        db.syncProjectsFromYaml(yamlText, undefined, 1_760_000_000);
        expect(db.getAgentBySlug('magpie')?.status).toBe('pending');
        expect(db.getAgentBySlug('mocca')?.status).toBe('pending');

        const logs: string[] = [];
        await runPkmnCli(['set-ladders', 'magpie', 'rby', 'adv'], {
          db,
          now: 1_760_000_010,
          log: line => logs.push(line),
        });
        await runPkmnCli(['set-ladders', 'mocca', 'vgc'], {
          db,
          now: 1_760_000_010,
          log: line => logs.push(line),
        });
        expect(logs[0]).toContain('rby, adv (status=qualified)');
        expect(logs[1]).toContain('vgc (status=qualified)');

        // Re-syncing projects.yml must not clobber SQLite grants.
        db.syncProjectsFromYaml(yamlText, undefined, 1_760_000_020);
        const magpie = db.getAgentBySlug('magpie')!;
        const mocca = db.getAgentBySlug('mocca')!;
        expect(magpie.status).toBe('qualified');
        expect(db.getAgentLadders(magpie.id)).toEqual(['rby', 'adv']);
        expect(mocca.status).toBe('qualified');
        expect(db.getAgentLadders(mocca.id)).toEqual(['vgc']);

        // Magpie can submit to RBY, not SV.
        expect(() => db.createSubmission({
          agentId: magpie.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/magpie.tar.zst',
          sha256: 'a'.repeat(64),
          ladderIds: ['gen9ou20261109'],
          now: 1_760_000_030,
        })).toThrow(/not qualified for the SV ladder/);

        const v1 = db.createSubmission({
          agentId: magpie.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/magpie.tar.zst',
          sha256: 'a'.repeat(64),
          ladderIds: ['gen1ou20261109'],
          now: 1_760_000_030,
        });
        db.applySubmissionStatus({versionId: v1.id, smokeStatus: 'passed', now: 1_760_000_040});
        db.refundCooldown('magpie', 1_760_000_050);

        // Revoking RBY leaves the active RBY entry running, while blocking future RBY submissions.
        db.setAgentLadder('magpie', 'rby', false, 1_760_000_060);
        expect(db.getAgentLadders(magpie.id)).toEqual(['adv']);
        expect(db.getActiveEntriesForAgent(magpie.id)).toHaveLength(1);
        expect(db.getActiveEntriesForAgent(magpie.id)[0].role).toBe('champion');
        expect(() => db.createSubmission({
          agentId: magpie.id,
          version: '1.1.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/magpie-1.1.tar.zst',
          sha256: 'b'.repeat(64),
          ladderIds: ['gen1ou20261109'],
          now: 1_760_000_070,
        })).toThrow(/not qualified for the RBY ladder/);

        // Rotating VGC preserves Mocca's slot-based qualification on the next season.
        db.rotateLadder({
          oldLadderId: 'gen9championsvgc2026regmc',
          archivedName: 'VGC Reg M-C',
          next: {
            id: 'gen9championsvgc2026regmd',
            name: 'VGC',
            format: 'gen9championsvgc2026regmd',
            team: 'pools',
            teams: 20,
          },
          now: 1_760_000_080,
        });
        const vgcSub = db.createSubmission({
          agentId: mocca.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/mocca.tar.zst',
          sha256: 'c'.repeat(64),
          ladderIds: ['gen9championsvgc2026regmd'],
          now: 1_760_000_090,
        });
        expect(vgcSub.ladders).toEqual(['gen9championsvgc2026regmd']);

        // Clearing all ladders returns agent to 'pending'.
        await runPkmnCli(['set-ladders', 'magpie', 'none'], {
          db,
          now: 1_760_000_100,
          log: () => undefined,
        });
        expect(db.getAgentBySlug('magpie')?.status).toBe('pending');
        expect(db.getAgentLadders(magpie.id)).toEqual([]);
      } finally {
        db.close();
      }
    }
  );

  test('createSubmission rejects settling ladders with 400', () => {
    const db = new database.Database(':memory:', {now: 1_760_000_000});
    try {
      db.syncLadders(undefined, 1_760_000_000);
      db.syncProjectsFromYaml(`
- name: 0 ERROR
  active: 2026
  arena:
    owners:
      pre: pre.10544
`, undefined, 1_760_000_000);
      db.setAgentLadders('0-error', ['rby', 'adv'], 1_760_000_000);
      db.db.prepare("UPDATE ladders SET status = 'settling' WHERE id = 'gen1ou20261109'").run();
      const agent = db.getAgentBySlug('0-error')!;
      let caught: unknown;
      try {
        db.createSubmission({
          agentId: agent.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/0-error.tar.zst',
          sha256: 'a'.repeat(64),
          ladderIds: ['gen1ou20261109'],
          now: 1_760_000_010,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as {status?: number}).status).toBe(400);
      expect((caught as Error).message).toMatch(/settling.*closed/);
    } finally {
      db.close();
    }
  });

  test('createSubmission rejects archived ladders with 400', () => {
    const db = new database.Database(':memory:', {now: 1_760_000_000});
    try {
      db.syncLadders(undefined, 1_760_000_000);
      db.syncProjectsFromYaml(`
- name: 0 ERROR
  active: 2026
  arena:
    owners:
      pre: pre.10544
`, undefined, 1_760_000_000);
      db.setAgentLadders('0-error', ['rby', 'adv'], 1_760_000_000);
      db.db.prepare("UPDATE ladders SET status = 'archived' WHERE id = 'gen1ou20261109'").run();
      const agent = db.getAgentBySlug('0-error')!;
      let caught: unknown;
      try {
        db.createSubmission({
          agentId: agent.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/0-error.tar.zst',
          sha256: 'a'.repeat(64),
          ladderIds: ['gen1ou20261109'],
          now: 1_760_000_010,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as {status?: number}).status).toBe(400);
      expect((caught as Error).message).toMatch(/archived.*closed/);
    } finally {
      db.close();
    }
  });

  test('syncProjects deletes agent_ladders rows when removing a project arena block', () => {
    const db = new database.Database(':memory:', {now: 1_760_000_000});
    try {
      const withArena = `
- name: Magpie
  active: 2025
  arena:
    owners:
      open-cover: opencover.723102
`;
      const withoutArena = `
- name: Magpie
  active: 2025
`;
      db.syncProjectsFromYaml(withArena, undefined, 1_760_000_000);
      db.setAgentLadders('magpie', ['rby', 'adv'], 1_760_000_010);
      const magpie = db.getAgentBySlug('magpie')!;
      expect(db.getAgentLadders(magpie.id)).toEqual(['rby', 'adv']);

      db.syncProjectsFromYaml(withoutArena, undefined, 1_760_000_020);
      expect(db.getAgentBySlug('magpie')?.status).toBe('disabled');
      const rawCount = (db.db.prepare(
        'SELECT COUNT(*) AS n FROM agent_ladders WHERE agent_id = ?'
      ).get(magpie.id) as {n: number}).n;
      expect(rawCount).toBe(0);
      expect(db.getAgentLadders(magpie.id)).toEqual([]);

      // Re-adding the arena block starts the agent fresh as 'pending'.
      db.syncProjectsFromYaml(withArena, undefined, 1_760_000_030);
      expect(db.getAgentBySlug('magpie')?.status).toBe('pending');
      expect(db.getAgentLadders(magpie.id)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('agent_ladders read helpers exclude disabled agents', () => {
    const db = new database.Database(':memory:', {now: 1_760_000_000});
    try {
      db.syncProjectsFromYaml(`
- name: Magpie
  active: 2025
  arena:
    owners:
      open-cover: opencover.723102
`, undefined, 1_760_000_000);
      db.setAgentLadders('magpie', ['rby'], 1_760_000_010);
      const magpie = db.getAgentBySlug('magpie')!;
      db.db.prepare("UPDATE agents SET status = 'disabled' WHERE id = ?").run(magpie.id);
      expect(db.getAgentLadders(magpie.id)).toEqual([]);
      expect(db.getAgentLaddersByAgent().has(magpie.id)).toBe(false);
      expect(db.isAgentQualifiedForSlot(magpie.id, 'rby')).toBe(false);
    } finally {
      db.close();
    }
  });

  test('parseLadderSlotTokens rejects combining all with other tokens', () => {
    expect(() => database.parseLadderSlotTokens(['all', 'bogus'])).toThrow(/Cannot combine "all"/);
    expect(() => database.parseLadderSlotTokens(['all,rby'])).toThrow(/Cannot combine "all"/);
    expect(database.parseLadderSlotTokens(['all'])).toEqual([...database.ALL_SLOTS]);
  });

  test('parseLadderSlotTokens rejects combining none with other tokens', () => {
    expect(() => database.parseLadderSlotTokens(['none', 'rby'])).toThrow(/Cannot combine "none"/);
    expect(database.parseLadderSlotTokens(['none'])).toEqual([]);
  });

  test('enforces rolling 24h failed smoke budget independently per scope', () => {
    const db = new database.Database(':memory:', {now: 1_760_000_000});
    try {
      db.syncLaddersFromYaml(`
- name: RBY
  format: gen1ou
  id: gen1ou20261109
  team: harvested
  status: upcoming
`, 1_760_000_000);
      db.syncProjectsFromYaml(`
- name: Alpha
  active: 2026
  arena:
    owners:
      alice: alice.10001
`, undefined, 1_760_000_000);
      db.setAgentLadders('alpha', ['rby'], 1_760_000_000);
      db.upsertTournament({
        id: 't1',
        name: 'Tournament #1',
        format: 'gen9ou',
        version: '0.11.0',
        gamesPerMatchup: 10,
        parallelTables: 2,
        hardware: 'L4',
        startsAt: 1_765_000_000,
        status: 'scheduled',
      });

      const alpha = db.getAgentBySlug('alpha')!;
      const sha = 'a'.repeat(64);
      const t0 = 1_760_000_100;

      // Three failed ladder smoke tests exhaust the 24h ladder budget.
      for (let i = 0; i < database.MAX_FAILED_SMOKE_TESTS; i++) {
        const v = db.createSubmission({
          agentId: alpha.id,
          version: `0.0.${i + 1}`,
          package: 'bundle',
          url: `https://example.com/v${i + 1}.tar.gz`,
          sha256: sha,
          ladderIds: ['gen1ou20261109'],
          now: t0 + i * 600,
        });
        db.applySubmissionStatus({
          versionId: v.id,
          smokeStatus: 'failed',
          smokeError: 'boom',
          now: t0 + i * 600 + 10,
        });
      }

      const blocked = db.computeAgentSubmissionStatus(alpha.id, t0 + 2_000);
      expect(blocked.canSubmit).toBe(false);
      expect(blocked.label).toBe('Ineligible');
      expect(blocked.reason).toContain('Failed smoke test limit reached');
      expect(blocked.nextEligibleAt).toBe(t0 + database.FAILED_SMOKE_WINDOW_SECONDS);

      // Tournament budget is tracked separately and remains open.
      const tourneysWhileLadderBlocked = db.computeAgentTournamentStatuses(alpha.id, t0 + 2_000);
      expect(tourneysWhileLadderBlocked[0].canSubmit).toBe(true);

      // Rolling 24h expiry of the first failure unblocks ladder submissions.
      const justBefore = db.computeAgentSubmissionStatus(
        alpha.id,
        t0 + database.FAILED_SMOKE_WINDOW_SECONDS - 1
      );
      expect(justBefore.canSubmit).toBe(false);
      const atExpiry = db.computeAgentSubmissionStatus(
        alpha.id,
        t0 + database.FAILED_SMOKE_WINDOW_SECONDS
      );
      expect(atExpiry.canSubmit).toBe(true);

      // refundCooldown also resets the 24h failed smoke budget immediately.
      db.refundCooldown('alpha', t0 + 2_100);
      expect(db.computeAgentSubmissionStatus(alpha.id, t0 + 2_105).canSubmit).toBe(true);

      // Three failed tournament smoke tests exhaust the 24h tournament budget.
      const tTour = t0 + 3_000;
      for (let i = 0; i < database.MAX_FAILED_SMOKE_TESTS; i++) {
        const v = db.createSubmission({
          agentId: alpha.id,
          version: `t${i + 1}`,
          package: 'oci',
          url: `ghcr.io/pkmn/alpha:t${i + 1}`,
          sha256: sha,
          ladderIds: [],
          tournamentIds: ['t1'],
          now: tTour + i * 600,
        });
        db.applySubmissionStatus({
          versionId: v.id,
          smokeStatus: 'failed',
          smokeError: 'boom',
          now: tTour + i * 600 + 10,
        });
      }
      const blockedTour = db.computeAgentTournamentStatuses(alpha.id, tTour + 2_000)[0];
      expect(blockedTour.canSubmit).toBe(false);
      expect(blockedTour.reason).toContain('Failed smoke test limit reached');
      expect(blockedTour.nextEligibleAt).toBe(tTour + database.FAILED_SMOKE_WINDOW_SECONDS);

      let caught: unknown;
      try {
        db.createSubmission({
          agentId: alpha.id,
          version: 't4',
          package: 'oci',
          url: 'ghcr.io/pkmn/alpha:t4',
          sha256: sha,
          ladderIds: [],
          tournamentIds: ['t1'],
          now: tTour + 2_000,
        });
      } catch (err) {
        caught = err;
      }
      expect((caught as {status?: number}).status).toBe(429);

      // Ladder budget remains unaffected by tournament failures.
      expect(db.computeAgentSubmissionStatus(alpha.id, tTour + 2_000).canSubmit).toBe(true);
    } finally {
      db.close();
    }
  });

  test('persists tunable smoke cadence in config', () => {
    const db = new database.Database(':memory:', {now: 1_760_000_000});
    try {
      expect(db.getSmokeCadence()).toEqual({maxPerCycle: 1, everyCycles: 1});
      expect(db.setSmokeCadence({maxPerCycle: 1, everyCycles: 5}, 1_760_000_050)).toEqual({
        maxPerCycle: 1,
        everyCycles: 5,
      });
      expect(db.getSmokeCadence()).toEqual({maxPerCycle: 1, everyCycles: 5});

      expect(db.setSmokeCadence({maxPerCycle: 0, everyCycles: 1}, 1_760_000_060)).toEqual({
        maxPerCycle: 0,
        everyCycles: 1,
      });
      expect(db.getSmokeCadence()).toEqual({maxPerCycle: 0, everyCycles: 1});
    } finally {
      db.close();
    }
  });

  test('rejects invalid smoke cadence parameters in config', () => {
    const db = new database.Database(':memory:', {now: 1_760_000_000});
    try {
      expect(() => db.setSmokeCadence({maxPerCycle: -1, everyCycles: 1})).toThrow(/non-negative/);
      expect(() => db.setSmokeCadence({maxPerCycle: 1, everyCycles: 0})).toThrow(/positive/);
    } finally {
      db.close();
    }
  });

  test('computes anonymized FIFO smoke-test queue position separately per scope',
    () => {
      const db = new database.Database(':memory:', {now: 1_760_000_000});
      try {
        db.syncLaddersFromYaml(`
- name: RBY
  format: gen1ou
  id: gen1ou20261109
  team: harvested
  status: upcoming
`, 1_760_000_000);
        db.syncProjectsFromYaml(`
- name: Alpha
  active: 2026
  arena:
    owners:
      alice: alice.10001
- name: Beta
  active: 2026
  arena:
    owners:
      bob: bob.10002
- name: Gamma
  active: 2026
  arena:
    owners:
      cara: cara.10003
`, undefined, 1_760_000_000);
        for (const slug of ['alpha', 'beta', 'gamma']) {
          db.setAgentLadders(slug, ['rby'], 1_760_000_000);
        }
        db.upsertTournament({
          id: 't1',
          name: 'Tournament #1',
          format: 'gen9ou',
          version: '0.11.0',
          gamesPerMatchup: 10,
          parallelTables: 2,
          hardware: 'L4',
          startsAt: 1_765_000_000,
          status: 'scheduled',
        });

        const alpha = db.getAgentBySlug('alpha')!;
        const beta = db.getAgentBySlug('beta')!;
        const gamma = db.getAgentBySlug('gamma')!;
        const sha = 'a'.repeat(64);

        const vAlpha = db.createSubmission({
          agentId: alpha.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://example.com/a.tar.gz',
          sha256: sha,
          ladderIds: ['gen1ou20261109'],
          now: 1_760_000_100,
        });
        // Same timestamp as Alpha: FIFO tie-breaks by ascending id.
        db.createSubmission({
          agentId: beta.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://example.com/b.tar.gz',
          sha256: sha,
          ladderIds: ['gen1ou20261109'],
          now: 1_760_000_100,
        });
        db.createSubmission({
          agentId: gamma.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://example.com/g.tar.gz',
          sha256: sha,
          ladderIds: ['gen1ou20261109'],
          now: 1_760_000_200,
        });

        // Tournament queue is tracked independently from ladder pending submissions.
        db.createSubmission({
          agentId: alpha.id,
          version: 't1',
          package: 'oci',
          url: 'ghcr.io/pkmn/alpha:t1',
          sha256: sha,
          ladderIds: [],
          tournamentIds: ['t1'],
          now: 1_760_000_150,
        });
        db.createSubmission({
          agentId: beta.id,
          version: 't1',
          package: 'oci',
          url: 'ghcr.io/pkmn/beta:t1',
          sha256: sha,
          ladderIds: [],
          tournamentIds: ['t1'],
          now: 1_760_000_250,
        });

        expect(db.computeAgentSubmissionStatus(alpha.id, 1_760_000_300).queueAhead).toBe(0);
        expect(db.computeAgentSubmissionStatus(beta.id, 1_760_000_300).queueAhead).toBe(1);
        expect(db.computeAgentSubmissionStatus(gamma.id, 1_760_000_300).queueAhead).toBe(2);
        expect(db.computeAgentSubmissionStatus(gamma.id, 1_760_000_300).reason).toContain(
          '2 ahead in queue'
        );
        expect(db.getVersionsForAgent(gamma.id)[0].queueAhead).toBe(2);

        expect(db.computeAgentTournamentStatuses(alpha.id, 1_760_000_300)[0].queueAhead).toBe(0);
        expect(db.computeAgentTournamentStatuses(beta.id, 1_760_000_300)[0].queueAhead).toBe(1);
        expect(db.computeAgentTournamentStatuses(beta.id, 1_760_000_300)[0].reason).toContain(
          '1 ahead in queue'
        );

        // Once Alpha finishes, Beta becomes next in queue (0) and Gamma moves to 1 ahead.
        db.applySubmissionStatus({versionId: vAlpha.id, smokeStatus: 'passed', now: 1_760_000_400});
        expect(db.computeAgentSubmissionStatus(beta.id, 1_760_000_405).queueAhead).toBe(0);
        expect(db.computeAgentSubmissionStatus(gamma.id, 1_760_000_405).queueAhead).toBe(1);
      } finally {
        db.close();
      }
    });

  test('scopes tournament queueAhead per tournament across overlapping scheduled events', () => {
    const db = new database.Database(':memory:', {now: 1_760_000_000});
    try {
      db.syncProjectsFromYaml(`
- name: Alpha
  active: 2026
  arena:
    owners:
      alice: alice.10001
- name: Beta
  active: 2026
  arena:
    owners:
      bob: bob.10002
`, undefined, 1_760_000_000);
      db.upsertTournament({
        id: 't1',
        name: 'Tournament #1',
        format: 'gen9ou',
        version: '0.11.0',
        gamesPerMatchup: 10,
        parallelTables: 2,
        hardware: 'L4',
        startsAt: 1_765_000_000,
        status: 'scheduled',
      });
      db.upsertTournament({
        id: 't2',
        name: 'Tournament #2',
        format: 'gen1ou',
        version: '0.11.0',
        gamesPerMatchup: 10,
        parallelTables: 2,
        hardware: 'L4',
        startsAt: 1_766_000_000,
        status: 'scheduled',
      });

      const alpha = db.getAgentBySlug('alpha')!;
      const beta = db.getAgentBySlug('beta')!;
      const sha = 'a'.repeat(64);

      db.createSubmission({
        agentId: alpha.id,
        version: 't1-v1',
        package: 'oci',
        url: 'ghcr.io/pkmn/alpha:t1',
        sha256: sha,
        ladderIds: [],
        tournamentIds: ['t1'],
        now: 1_760_000_100,
      });
      db.createSubmission({
        agentId: beta.id,
        version: 't2-v1',
        package: 'oci',
        url: 'ghcr.io/pkmn/beta:t2',
        sha256: sha,
        ladderIds: [],
        tournamentIds: ['t2'],
        now: 1_760_000_200,
      });

      const betaStatuses = db.computeAgentTournamentStatuses(beta.id, 1_760_000_300);
      expect(betaStatuses.find(s => s.tournamentId === 't2')?.queueAhead).toBe(0);
      expect(db.getVersionsForAgent(beta.id)[0].queueAhead).toBe(0);
    } finally {
      db.close();
    }
  });

  test('aggregates host CPU utilization with protocol error counts on ladder_entries',
    () => {
      const db = new database.Database(':memory:', {now: 1_760_000_000});
      try {
        db.syncLaddersFromYaml(`
- name: RBY
  format: gen1ou
  id: gen1ou20261109
  team: harvested
  status: active
`, 1_760_000_000);
        db.syncProjectsFromYaml(`
- name: Alpha
  active: 2026
  arena:
    owners:
      alice: alice.10001
- name: Beta
  active: 2026
  arena:
    owners:
      bob: bob.10002
`, undefined, 1_760_000_000);
        db.setAgentLadders('alpha', ['rby'], 1_760_000_000);
        db.setAgentLadders('beta', ['rby'], 1_760_000_000);
        const alpha = db.getAgentBySlug('alpha')!;
        const beta = db.getAgentBySlug('beta')!;
        const sha = 'a'.repeat(64);
        const va = db.createSubmission({
          agentId: alpha.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://example.com/a.tar.gz',
          sha256: sha,
          ladderIds: ['gen1ou20261109'],
          now: 1_760_000_010,
        });
        const vb = db.createSubmission({
          agentId: beta.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://example.com/b.tar.gz',
          sha256: sha,
          ladderIds: ['gen1ou20261109'],
          now: 1_760_000_010,
        });
        db.applySubmissionStatus({versionId: va.id, smokeStatus: 'passed', now: 1_760_000_020});
        db.applySubmissionStatus({versionId: vb.id, smokeStatus: 'passed', now: 1_760_000_020});

        db.recordCompletedMatch({
          match: {
            id: 'gen1ou-0000001',
            ladderId: 'gen1ou20261109',
            p1VersionId: va.id,
            p2VersionId: vb.id,
            seed: '1,2,3,4',
            game1Outcome: 'L',
            game2Outcome: 'W',
            category: 'LW',
            game1Turns: 12,
            game2Turns: 20,
            game1EndReason: 'invalid-choice',
            game2EndReason: 'win',
            p1Game1PeakRam: 200,
            p1Game2PeakRam: 220,
            p2Game1PeakRam: 150,
            p2Game2PeakRam: 160,
            p1Game1BankSeconds: 100,
            p1Game2BankSeconds: 110,
            p2Game1BankSeconds: 120,
            p2Game2BankSeconds: 130,
            p1Game1MeanTurnMillis: 50,
            p1Game2MeanTurnMillis: 60,
            p2Game1MeanTurnMillis: 40,
            p2Game2MeanTurnMillis: 45,
            p1CpuCores: 6.4,
            p2CpuCores: 1.2,
            p1Game1CpuCores: 6.1,
            p1Game2CpuCores: 6.7,
            p2Game1CpuCores: 1.1,
            p2Game2CpuCores: 1.3,
            p1Errors: {
              invalidCantMove: 2,
              invalidCantSwitch: 1,
              invalidTarget: 0,
              invalidOther: 0,
              unavailableChoices: 4,
            },
            completedAt: 1_760_000_100,
          },
        });

        const alphaEntries = db.getAgentLadderProfileEntries(alpha.id, 'gen1ou20261109');
        expect(alphaEntries[0].meanCpuCores).toBeCloseTo(6.4, 5);
        expect(alphaEntries[0].cpuMatches).toBe(1);
        expect(alphaEntries[0].invalidChoices).toBe(1);
        expect(alphaEntries[0].invalidCantMove).toBe(2);
        expect(alphaEntries[0].invalidCantSwitch).toBe(1);
        expect(alphaEntries[0].unavailableChoices).toBe(4);

        const betaEntries = db.getAgentLadderProfileEntries(beta.id, 'gen1ou20261109');
        expect(betaEntries[0].meanCpuCores).toBeCloseTo(1.2, 5);
        expect(betaEntries[0].invalidChoices).toBe(0);

        const match = db.getMatch('gen1ou-0000001')!;
        expect(match.p1.cpuCores).toBeCloseTo(6.4, 5);
        expect(match.p2.cpuCores).toBeCloseTo(1.2, 5);
        expect(match.games[0].p1.cpuCores).toBeCloseTo(6.1, 5);
        expect(match.games[1].p1.cpuCores).toBeCloseTo(6.7, 5);
        expect(match.games[0].p2.cpuCores).toBeCloseTo(1.1, 5);
        expect(match.games[1].p2.cpuCores).toBeCloseTo(1.3, 5);
      } finally {
        db.close();
      }
    });

  test(
    'staged lifecycle stores diagnostics, gates activation/discard, counts discards in 24h budget',
    () => {
      const db = new database.Database(':memory:', {now: 1_760_000_000});
      try {
        db.syncLadders(undefined, 1_760_000_000);
        db.syncProjectsFromYaml(`
- name: Alpha
  active: 2026
  arena:
    owners:
      alice: alice.10001
`, undefined, 1_760_000_000);
        const agent = db.getAgentBySlug('alpha')!;
        db.setAgentLadders('alpha', ['rby', 'vgc'], 1_760_000_000);
        const sha = 'b'.repeat(64);
        const now = 1_760_000_100;

        // 1. Submit to RBY + VGC pools with staged pending teams
        const v1 = db.createSubmission({
          agentId: agent.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://example.com/a-1.0.0.tar.gz',
          sha256: sha,
          ladderIds: ['gen1ou20261109', 'gen9championsvgc2026regmc'],
          teamsByLadder: {gen9championsvgc2026regmc: ['Team1', 'Team2', 'Team3']},
          now,
        });
        // Transition to staged with diagnostic artifact
        const stagedRes = db.applySubmissionStatus({
          versionId: v1.id,
          smokeStatus: 'staged',
          smokeDurationMillis: 4200,
          smokeInitMillis: 150,
          smokeTurnMillis: 30,
          smokePeakRam: 256,
          diagnostics: [{
            ladderId: 'gen1ou20261109',
            format: 'gen1ou',
            turns: 18,
            endReason: 'win',
            durationMillis: 4200,
            battleLog: '|turn|1\n|ai|p1|{"score":0.5}\n|win|Alpha',
            infoStatus: 'full',
            p1Stderr: 'p1 debug line',
            p2Stderr: 'p2 debug line',
            p1CpuCores: 2.1,
            p2CpuCores: 2.0,
            p1PeakRam: 256,
            p2PeakRam: 240,
          }],
          now: now + 60,
        });
        expect(stagedRes.version.smokeStatus).toBe('staged');
        expect(stagedRes.version.activatedAt).toBeUndefined();
        expect(stagedRes.version.notified).toBe(false);
        expect(db.getActiveEntriesForAgent(agent.id)).toEqual([]);
        expect(db.getPendingVersionDms().map(d => d.smokeStatus)).toEqual(['staged']);

        // Staged version blocks another ladder submission
        const blockedByStaged = db.computeAgentSubmissionStatus(agent.id, now + 70);
        expect(blockedByStaged.canSubmit).toBe(false);
        expect(blockedByStaged.reason).toContain('activate or discard');

        // Diagnostics persisted & summarized on version history (including /info status)
        const diags = db.getSmokeDiagnosticsForVersion(v1.id);
        expect(diags).toHaveLength(1);
        expect(diags[0].p1Stderr).toBe('p1 debug line');
        expect(diags[0].infoStatus).toBe('full');
        const history = db.getVersionsForAgent(agent.id);
        expect(history[0].diagnostics?.[0].hasStderr).toBe(true);
        expect(history[0].smokeInfoStatus).toBe('full');

        // Discard reverts pending VGC teams back to saved (not deleted) and frees '1.0.0'
        const discarded = db.discardStagedVersion({versionId: v1.id, agentId: agent.id});
        expect(discarded.smokeStatus).toBe('discarded');
        expect(db.isVersionClaimed(agent.id, '1.0.0')).toBe(false);
        expect(
          db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'saved')
        ).toEqual(['Team1', 'Team2', 'Team3']);
        expect(
          db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'pending')
        ).toEqual([]);

        // Two more discarded/failed runs reusing the same version label '1.0.0' exhaust 3/24h
        const v2 = db.createSubmission({
          agentId: agent.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://example.com/a-1.0.0-retry2.tar.gz',
          sha256: sha,
          ladderIds: ['gen1ou20261109'],
          now: now + 100,
        });
        db.applySubmissionStatus({versionId: v2.id, smokeStatus: 'staged', now: now + 110});
        db.discardStagedVersion({versionId: v2.id, agentId: agent.id});

        const v3 = db.createSubmission({
          agentId: agent.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://example.com/a-1.0.0-retry3.tar.gz',
          sha256: sha,
          ladderIds: ['gen1ou20261109'],
          now: now + 200,
        });
        db.applySubmissionStatus({versionId: v3.id, smokeStatus: 'failed', now: now + 210});

        const budgetBlocked = db.computeAgentSubmissionStatus(agent.id, now + 220);
        expect(budgetBlocked.canSubmit).toBe(false);
        expect(budgetBlocked.reason).toContain('Failed smoke test limit reached');

        // After 24h window passes, submit '1.0.0' again, stage + activate -> permanently claimed
        const dayLater = now + database.FAILED_SMOKE_WINDOW_SECONDS + 300;
        const v4 = db.createSubmission({
          agentId: agent.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://example.com/a-1.0.0-final.tar.gz',
          sha256: sha,
          ladderIds: ['gen1ou20261109'],
          now: dayLater,
        });
        db.applySubmissionStatus({
          versionId: v4.id,
          smokeStatus: 'staged',
          smokeInitMillis: 120,
          smokeTurnMillis: 25,
          smokePeakRam: 300,
          now: dayLater + 60,
        });
        const activateAt = dayLater + 3 * 86400;
        const activated = db.activateStagedVersion({
          versionId: v4.id,
          agentId: agent.id,
          now: activateAt,
        });
        expect(activated.version.smokeStatus).toBe('passed');
        expect(activated.version.activatedAt).toBe(activateAt);
        expect(db.isVersionClaimed(agent.id, '1.0.0')).toBe(true);
        expect(db.getVersionBySlugAndLabel('alpha', '1.0.0')?.id).toBe(v4.id);
        expect(db.getActivatedLadderVersionIds()).toEqual([v4.id]);
        expect(db.getActiveEntriesForAgent(agent.id)).toHaveLength(1);

        // Cooldown is 14d from activateAt (not submittedAt!)
        const checkCooldown = db.computeAgentSubmissionStatus(
          agent.id,
          dayLater + database.COOLDOWN_SECONDS + 10
        );
        expect(checkCooldown.canSubmit).toBe(false);
        expect(checkCooldown.nextEligibleAt).toBe(activateAt + database.COOLDOWN_SECONDS);

        // Tournament activation is rejected once now >= closesAt
        const tourStart = activateAt + 3 * 86400;
        db.upsertTournament({
          id: 'tour-stage',
          name: 'Stage Cup',
          format: 'gen9ou',
          version: '0.11.0',
          startsAt: tourStart,
          status: 'scheduled',
          gamesPerMatchup: 1,
          parallelTables: 1,
          hardware: 'test',
        });
        const vt = db.createSubmission({
          agentId: agent.id,
          version: 't1',
          package: 'oci',
          url: 'ghcr.io/pkmn/alpha:t1',
          sha256: sha,
          ladderIds: [],
          tournamentIds: ['tour-stage'],
          now: activateAt + 100,
        });
        db.applySubmissionStatus({versionId: vt.id, smokeStatus: 'staged', now: activateAt + 200});
        expect(
          db.computeAgentTournamentStatuses(agent.id, activateAt + 250)[0].stagedVersion
        ).toBe('t1');
        expect(() => db.activateStagedVersion({
          versionId: vt.id,
          agentId: agent.id,
          now: database.getTournamentClosesAt(tourStart),
        })).toThrow(/closed/i);
      } finally {
        db.close();
      }
    }
  );
});

describe('discord watches', () => {
  const sampleProjects = `
- name: Alpha
  arena:
    owners:
      dev1: '1001'
- name: Beta
  arena:
    owners:
      dev2: '1002'
- name: Gamma
  arena:
    owners:
      dev3: '1003'
- name: Delta
  arena:
    owners:
      dev4: '1004'
- name: Epsilon
  arena:
    owners:
      dev5: '1005'
- name: Zeta
  arena:
    owners:
      dev6: '1006'
`;

  const sampleLadders = `
- name: RBY
  format: gen1ou
  id: gen1ou20261109
  team: harvested
  status: active
- name: RAND
  format: gen9randombattle
  id: gen9randombattle20261109
  team: random
  status: active
`;

  test('migration 0008-discord-watches.sql is additive matching declarative schema', () => {
    const sql = fs.readFileSync(
      root('db', 'migration', '0008-discord-watches.sql'),
      'utf8'
    );
    expect(database.classifyMigrationSql(sql)).toBe('additive');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-watch-mig-'));
    try {
      const preSchemaDir = path.join(tmpDir, 'pre-schema');
      const preMigrationDir = path.join(tmpDir, 'pre-migration');
      fs.mkdirSync(preSchemaDir, {recursive: true});
      fs.mkdirSync(preMigrationDir, {recursive: true});
      for (const file of fs.readdirSync(database.SCHEMA_DIR)) {
        if (file === 'discord-watches.sql') continue;
        fs.copyFileSync(path.join(database.SCHEMA_DIR, file), path.join(preSchemaDir, file));
      }
      for (const file of fs.readdirSync(database.MIGRATION_DIR)) {
        if (file === '0008-discord-watches.sql') continue;
        fs.copyFileSync(
          path.join(database.MIGRATION_DIR, file),
          path.join(preMigrationDir, file)
        );
      }

      const dbFile = path.join(tmpDir, 'arena.sqlite');
      const preDb = new database.Database(dbFile, {
        schemaDir: preSchemaDir,
        migrationDir: preMigrationDir,
        now: 1000,
      });
      preDb.close();

      const migrated = new database.Database(dbFile, {now: 2000});
      const fresh = new database.Database(':memory:', {now: 2000});
      try {
        expect(compareDatabaseSchemas(migrated.db, fresh.db)).toEqual([]);
      } finally {
        migrated.close();
        fresh.close();
      }
    } finally {
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  });

  test('migration 0009-info-status.sql maps legacy supports_info to partial/none', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-info-mig-'));
    try {
      const preSchemaDir = path.join(tmpDir, 'pre-schema');
      const preMigrationDir = path.join(tmpDir, 'pre-migration');
      fs.mkdirSync(preSchemaDir, {recursive: true});
      fs.mkdirSync(preMigrationDir, {recursive: true});
      for (const file of fs.readdirSync(database.SCHEMA_DIR)) {
        if (file === 'smoke-diagnostics.sql') continue;
        fs.copyFileSync(path.join(database.SCHEMA_DIR, file), path.join(preSchemaDir, file));
      }
      fs.copyFileSync(
        path.join(database.MIGRATION_DIR, '0006-smoke-diagnostics.sql'),
        path.join(preSchemaDir, 'smoke-diagnostics.sql')
      );
      for (const file of fs.readdirSync(database.MIGRATION_DIR)) {
        if (file === '0009-info-status.sql') continue;
        fs.copyFileSync(
          path.join(database.MIGRATION_DIR, file),
          path.join(preMigrationDir, file)
        );
      }

      const dbFile = path.join(tmpDir, 'arena.sqlite');
      const preDb = new database.Database(dbFile, {
        schemaDir: preSchemaDir,
        migrationDir: preMigrationDir,
        now: 1000,
      });
      preDb.syncLadders(undefined, 1000);
      preDb.db.prepare("UPDATE ladders SET status = 'active'").run();
      preDb.syncProjectsFromYaml(
        '- name: Alpha\n  slug: alpha\n  arena:\n    owner: {github: a1, smogon: a1}\n',
        undefined,
        1000
      );
      const alpha = preDb.getAgentBySlug('alpha')!;
      const v1Id = Number(
        preDb.db.prepare(
          `INSERT INTO agent_versions (
            agent_id, version, package, url, sha256, ladders_json, tournaments_json,
            smoke_status, submitted_at, notified
          ) VALUES (?, '1.0.0', 'bundle', 'https://example.com/a.tar.zst', ?, '["gen1ou20261109"]',
            '[]', 'passed', 1000, 1)`
        ).run(alpha.id, 'a'.repeat(64)).lastInsertRowid
      );
      preDb.db.prepare(
        `INSERT INTO smoke_diagnostics (
          version_id, ladder_id, format, turns, end_reason, duration_millis,
          battle_log, supports_info, created_at
        ) VALUES
          (?, 'gen1ou20261109', 'gen1ou', 5, 'win', 1000, '|turn|1', 1, 1001),
          (?, 'gen9ou20261109', 'gen9ou', 5, 'win', 1000, '|turn|1', 0, 1002)`
      ).run(v1Id, v1Id);
      preDb.close();

      const migrated = new database.Database(dbFile, {now: 2000});
      const fresh = new database.Database(':memory:', {now: 2000});
      try {
        expect(compareDatabaseSchemas(migrated.db, fresh.db)).toEqual([]);
        const diags = migrated.getSmokeDiagnosticsForVersion(v1Id);
        expect(diags.map(d => d.infoStatus)).toEqual(['partial', 'none']);
        expect(database.combineInfoStatus(['full', 'full'])).toBe('full');
        expect(database.combineInfoStatus(['full', 'partial'])).toBe('partial');
        expect(database.combineInfoStatus(['full', 'none'])).toBe('none');
        expect(database.combineInfoStatus([])).toBeUndefined();
      } finally {
        migrated.close();
        fresh.close();
      }
    } finally {
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  });

  test('migration 0010-unlimited-smoke-tests.sql is additive matching declarative schema', () => {
    const sql = fs.readFileSync(
      root('db', 'migration', '0010-unlimited-smoke-tests.sql'),
      'utf8'
    );
    expect(database.classifyMigrationSql(sql)).toBe('additive');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-smoke-limit-mig-'));
    try {
      const preSchemaDir = path.join(tmpDir, 'pre-schema');
      const preMigrationDir = path.join(tmpDir, 'pre-migration');
      fs.mkdirSync(preSchemaDir, {recursive: true});
      fs.mkdirSync(preMigrationDir, {recursive: true});
      for (const file of fs.readdirSync(database.SCHEMA_DIR)) {
        if (!file.endsWith('.sql')) continue;
        let schemaSql = fs.readFileSync(path.join(database.SCHEMA_DIR, file), 'utf8');
        if (file === 'agents.sql') {
          schemaSql = schemaSql
            .split('\n')
            .filter(line => !/^\s*unlimited_smoke_tests\b/.test(line))
            .join('\n')
            .replace(/updated_at INTEGER NOT NULL,/, 'updated_at INTEGER NOT NULL');
        }
        fs.writeFileSync(path.join(preSchemaDir, file), schemaSql);
      }
      for (const file of fs.readdirSync(database.MIGRATION_DIR)) {
        if (file === '0010-unlimited-smoke-tests.sql') continue;
        fs.copyFileSync(
          path.join(database.MIGRATION_DIR, file),
          path.join(preMigrationDir, file)
        );
      }

      const dbFile = path.join(tmpDir, 'arena.sqlite');
      const preDb = new database.Database(dbFile, {
        schemaDir: preSchemaDir,
        migrationDir: preMigrationDir,
        now: 1000,
      });
      preDb.db.exec(
        'INSERT INTO agents (slug, name, status, updated_at) ' +
        "VALUES ('alpha', 'Alpha', 'pending', 1000)"
      );
      preDb.close();

      const migrated = new database.Database(dbFile, {now: 2000});
      const fresh = new database.Database(':memory:', {now: 2000});
      try {
        expect(compareDatabaseSchemas(migrated.db, fresh.db)).toEqual([]);
        expect(migrated.getAgentBySlug('alpha')?.unlimitedSmokeTests).toBe(false);
      } finally {
        migrated.close();
        fresh.close();
      }
    } finally {
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  });

  test('setUnlimitedSmokeTests bypasses 24h failed ladder smoke-test limit', () => {
    const db = new database.Database(':memory:', {now: 1_760_000_000});
    try {
      db.syncLadders(undefined, 1_760_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_760_000_000);
      db.setAgentLadders('alpha', ['rby'], 1_760_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      const t0 = 1_760_000_100;
      for (let i = 0; i < database.MAX_FAILED_SMOKE_TESTS; i++) {
        const v = db.createSubmission({
          agentId: alpha.id,
          version: `0.0.${i + 1}`,
          package: 'bundle',
          url: `https://example.com/v${i + 1}.tar.zst`,
          sha256: 'a'.repeat(64),
          ladderIds: ['gen1ou20261109'],
          now: t0 + i * 600,
        });
        db.applySubmissionStatus({
          versionId: v.id,
          smokeStatus: 'failed',
          smokeError: 'boom',
          now: t0 + i * 600 + 10,
        });
      }
      expect(db.computeAgentSubmissionStatus(alpha.id, t0 + 2_000).canSubmit).toBe(false);

      const updated = db.setUnlimitedSmokeTests('alpha', true, t0 + 2_010);
      expect(updated.unlimitedSmokeTests).toBe(true);
      expect(db.computeAgentSubmissionStatus(alpha.id, t0 + 2_020)).toEqual({
        label: 'Eligible',
        canSubmit: true,
      });

      const fourth = db.createSubmission({
        agentId: alpha.id,
        version: '0.0.4',
        package: 'bundle',
        url: 'https://example.com/v4.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: t0 + 2_020,
      });
      expect(fourth.version).toBe('0.0.4');
    } finally {
      db.close();
    }
  });

  test('setUnlimitedSmokeTests bypasses 24h failed tournament smoke-test limit', () => {
    const db = new database.Database(':memory:', {now: 1_760_000_000});
    try {
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_760_000_000);
      db.upsertTournament({
        id: 't1',
        name: 'Test Tour',
        format: 'gen9ou',
        version: '0.11.0',
        gamesPerMatchup: 10,
        parallelTables: 2,
        hardware: 'L4',
        startsAt: 1_765_000_000,
        status: 'scheduled',
      });
      const alpha = db.getAgentBySlug('alpha')!;
      const t0 = 1_760_000_100;
      for (let i = 0; i < database.MAX_FAILED_SMOKE_TESTS; i++) {
        const v = db.createSubmission({
          agentId: alpha.id,
          version: `t${i + 1}`,
          package: 'oci',
          url: `ghcr.io/pkmn/alpha:t${i + 1}`,
          sha256: 'a'.repeat(64),
          ladderIds: [],
          tournamentIds: ['t1'],
          now: t0 + i * 600,
        });
        db.applySubmissionStatus({
          versionId: v.id,
          smokeStatus: 'failed',
          smokeError: 'boom',
          now: t0 + i * 600 + 10,
        });
      }
      expect(db.computeAgentTournamentStatuses(alpha.id, t0 + 2_000)[0].canSubmit).toBe(false);

      db.setUnlimitedSmokeTests('alpha', true, t0 + 2_010);
      expect(db.computeAgentTournamentStatuses(alpha.id, t0 + 2_020)[0].canSubmit).toBe(true);
    } finally {
      db.close();
    }
  });

  test('setUnlimitedSmokeTests restores 24h smoke-test limit when re-enabled', () => {
    const db = new database.Database(':memory:', {now: 1_760_000_000});
    try {
      db.syncLadders(undefined, 1_760_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_760_000_000);
      db.setAgentLadders('alpha', ['rby'], 1_760_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      const t0 = 1_760_000_100;
      db.setUnlimitedSmokeTests('alpha', true, t0);
      for (let i = 0; i < database.MAX_FAILED_SMOKE_TESTS; i++) {
        const v = db.createSubmission({
          agentId: alpha.id,
          version: `0.0.${i + 1}`,
          package: 'bundle',
          url: `https://example.com/v${i + 1}.tar.zst`,
          sha256: 'a'.repeat(64),
          ladderIds: ['gen1ou20261109'],
          now: t0 + i * 600,
        });
        db.applySubmissionStatus({
          versionId: v.id,
          smokeStatus: 'staged',
          now: t0 + i * 600 + 10,
        });
        db.discardStagedVersion({versionId: v.id, agentId: alpha.id});
      }
      expect(db.computeAgentSubmissionStatus(alpha.id, t0 + 2_000).canSubmit).toBe(true);

      const restored = db.setUnlimitedSmokeTests('alpha', false, t0 + 2_010);
      expect(restored.unlimitedSmokeTests).toBe(false);
      const status = db.computeAgentSubmissionStatus(alpha.id, t0 + 2_020);
      expect(status.canSubmit).toBe(false);
      expect(status.reason).toContain('Failed smoke test limit reached');
    } finally {
      db.close();
    }
  });

  test('setUnlimitedSmokeTests keeps 14-day post-activation ladder cooldown enforced', () => {
    const db = new database.Database(':memory:', {now: 1_760_000_000});
    try {
      db.syncLadders(undefined, 1_760_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_760_000_000);
      db.setAgentLadders('alpha', ['rby'], 1_760_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      db.setUnlimitedSmokeTests('alpha', true, 1_760_000_010);
      const v1 = db.createSubmission({
        agentId: alpha.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://example.com/v1.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_760_000_100,
      });
      db.applySubmissionStatus({
        versionId: v1.id,
        smokeStatus: 'passed',
        now: 1_760_000_110,
      });
      const status = db.computeAgentSubmissionStatus(alpha.id, 1_760_000_200);
      expect(status.canSubmit).toBe(false);
      expect(status.reason).toContain('14-day cooldown active');
    } finally {
      db.close();
    }
  });

  test('syncProjectsFromYaml preserves unlimitedSmokeTests on active projects', () => {
    const db = new database.Database(':memory:', {now: 1_760_000_000});
    try {
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_760_000_000);
      db.setUnlimitedSmokeTests('alpha', true, 1_760_000_010);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_760_000_020);
      expect(db.getAgentBySlug('alpha')?.unlimitedSmokeTests).toBe(true);
    } finally {
      db.close();
    }
  });

  test('syncProjectsFromYaml resets unlimitedSmokeTests on disabled projects', () => {
    const db = new database.Database(':memory:', {now: 1_760_000_000});
    try {
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_760_000_000);
      db.setUnlimitedSmokeTests('alpha', true, 1_760_000_010);
      db.syncProjectsFromYaml('[]\n', undefined, 1_760_000_020);
      const disabled = db.getAgentBySlug('alpha')!;
      expect(disabled.status).toBe('disabled');
      expect(disabled.unlimitedSmokeTests).toBe(false);
    } finally {
      db.close();
    }
  });

  test('setUnlimitedSmokeTests rejects unknown or disabled agents', () => {
    const db = new database.Database(':memory:', {now: 1_760_000_000});
    try {
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_760_000_000);
      expect(() => db.setUnlimitedSmokeTests('missing', true, 1_760_000_010))
        .toThrow(/not found/);
      db.syncProjectsFromYaml('[]\n', undefined, 1_760_000_020);
      expect(() => db.setUnlimitedSmokeTests('alpha', true, 1_760_000_030))
        .toThrow(/disabled/);
    } finally {
      db.close();
    }
  });

  test('manages canonicalized watches with per-user limits, consumption, pruning', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      db.upsertTournament({
        id: 't1',
        name: 'Tournament #1',
        format: 'gen9ou',
        version: '0.11.0',
        gamesPerMatchup: 2,
        parallelTables: 2,
        hardware: 'test',
        status: 'running',
        startsAt: 1_700_000_000,
      });

      const alpha = db.getAgentBySlug('alpha')!;
      const beta = db.getAgentBySlug('beta')!;
      const gamma = db.getAgentBySlug('gamma')!;
      const delta = db.getAgentBySlug('delta')!;
      const epsilon = db.getAgentBySlug('epsilon')!;
      const zeta = db.getAgentBySlug('zeta')!;

      // Canonicalizes (beta, alpha) to (alpha, beta) and deduplicates reversed additions.
      const first = db.addDiscordWatch({
        discordId: 'u1',
        agentId: beta.id,
        opponentId: alpha.id,
        now: 1_700_000_010,
      });
      expect(first.status).toBe('added');
      expect(first.watch?.agentId).toBe(Math.min(alpha.id, beta.id));
      expect(first.watch?.opponentId).toBe(Math.max(alpha.id, beta.id));

      const dup = db.addDiscordWatch({
        discordId: 'u1',
        agentId: alpha.id,
        opponentId: beta.id,
        now: 1_700_000_020,
      });
      expect(dup.status).toBe('exists');
      expect(dup.watch?.id).toBe(first.watch?.id);

      // Rejects self-matchup and dual ladder+tournament scope.
      expect(() => db.addDiscordWatch({
        discordId: 'u1',
        agentId: alpha.id,
        opponentId: alpha.id,
      })).toThrow(/different agent/i);
      expect(() => db.addDiscordWatch({
        discordId: 'u1',
        agentId: alpha.id,
        ladderId: 'gen1ou20261109',
        tournamentId: 't1',
      })).toThrow(/both a ladder and a tournament/i);

      // Enforces MAX_WATCHES_PER_USER cap per user.
      for (const ag of [gamma, delta, epsilon, zeta]) {
        expect(db.addDiscordWatch({
          discordId: 'u1',
          agentId: ag.id,
          now: 1_700_000_030,
        }).status).toBe('added');
      }
      const capped = db.addDiscordWatch({
        discordId: 'u1',
        agentId: alpha.id,
        ladderId: 'gen1ou20261109',
        now: 1_700_000_040,
      });
      expect(capped).toEqual({status: 'limit', limit: database.MAX_WATCHES_PER_USER});

      // Ownership-checked deletion & clear.
      expect(db.deleteDiscordWatchForUser('u2', first.watch!.id)).toBe(false);
      expect(db.listDiscordWatchesForUser('u1')).toHaveLength(5);
      expect(db.deleteDiscordWatchForUser('u1', first.watch!.id)).toBe(true);
      expect(db.clearDiscordWatchesForUser('u1')).toBe(4);
      expect(db.listDiscordWatchesForUser('u1')).toHaveLength(0);

      // Matching consumption across broad, matchup, ladder-scoped, and tournament-scoped watches.
      db.addDiscordWatch({discordId: 'u1', agentId: alpha.id, now: 1_700_000_100});
      db.addDiscordWatch({
        discordId: 'u1',
        agentId: alpha.id,
        opponentId: beta.id,
        ladderId: 'gen1ou20261109',
        now: 1_700_000_101,
      });
      db.addDiscordWatch({
        discordId: 'u2',
        agentId: alpha.id,
        ladderId: 'gen9randombattle20261109',
        now: 1_700_000_102,
      });
      db.addDiscordWatch({
        discordId: 'u3',
        agentId: beta.id,
        tournamentId: 't1',
        now: 1_700_000_103,
      });

      const consumedLadder = db.consumeMatchingDiscordWatches({
        p1AgentId: beta.id,
        p2AgentId: alpha.id,
        ladderId: 'gen1ou20261109',
      });
      expect(consumedLadder).toHaveLength(2);
      expect(consumedLadder.every(w => w.discordId === 'u1')).toBe(true);
      // Consumed watches are deleted atomically; re-running yields none.
      expect(db.consumeMatchingDiscordWatches({
        p1AgentId: alpha.id,
        p2AgentId: beta.id,
        ladderId: 'gen1ou20261109',
      })).toEqual([]);
      // Other scopes remain untouched.
      expect(db.listDiscordWatchesForUser('u2')).toHaveLength(1);
      expect(db.listDiscordWatchesForUser('u3')).toHaveLength(1);

      // Tournament match consumes only the tournament-scoped watch.
      const consumedTourney = db.consumeMatchingDiscordWatches({
        p1AgentId: gamma.id,
        p2AgentId: beta.id,
        tournamentId: 't1',
      });
      expect(consumedTourney.map(w => w.discordId)).toEqual(['u3']);

      // Mirror match (p1 === p2) consumes a single-agent watch without matching 2-agent watches.
      db.addDiscordWatch({discordId: 'u4', agentId: alpha.id, now: 1_700_000_110});
      db.addDiscordWatch({
        discordId: 'u5',
        agentId: alpha.id,
        opponentId: beta.id,
        now: 1_700_000_111,
      });
      const consumedMirror = db.consumeMatchingDiscordWatches({
        p1AgentId: alpha.id,
        p2AgentId: alpha.id,
        ladderId: 'gen1ou20261109',
      });
      expect(consumedMirror.map(w => w.discordId)).toEqual(['u4']);
      expect(db.listDiscordWatchesForUser('u5')).toHaveLength(1);

      // Pruning removes expired watches, archived-ladder watches, and completed-tournament watches.
      db.addDiscordWatch({
        discordId: 'u6',
        agentId: gamma.id,
        tournamentId: 't1',
        now: 1_700_000_120,
      });
      db.setLadderStatus('gen9randombattle20261109', 'archived', 1_700_000_200);
      db.setTournamentStatus('t1', 'completed', 1_700_000_200);
      // u2 (archived ladder) and u6 (completed tournament) pruned immediately; u5 stays fresh.
      expect(db.pruneExpiredDiscordWatches(1_700_000_300)).toBe(2);
      expect(db.listDiscordWatchesForUser('u2')).toHaveLength(0);
      expect(db.listDiscordWatchesForUser('u6')).toHaveLength(0);
      expect(db.listDiscordWatchesForUser('u5')).toHaveLength(1);
      // After TTL passes, u5 is pruned too.
      expect(
        db.pruneExpiredDiscordWatches(1_700_000_111 + database.WATCH_TTL_SECONDS + 1)
      ).toBe(1);
      expect(db.listDiscordWatchesForUser('u5')).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test('listWatchableAgents prioritizes active ladder/tournament agents', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      const zeta = db.getAgentBySlug('zeta')!;
      db.setAgentLadders(zeta.id, ['rby'], 1_700_000_000);
      const ver = db.createSubmission({
        agentId: zeta.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/zeta-1.0.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_000,
      });
      db.applySubmissionStatus({versionId: ver.id, smokeStatus: 'passed', now: 1_700_000_010});

      const list = db.listWatchableAgents();
      expect(list[0]).toEqual({id: zeta.id, slug: 'zeta', name: 'Zeta', active: true});
      expect(list.find(a => a.id === alpha.id)?.active).toBe(false);
    } finally {
      db.close();
    }
  });

  test('scrubs auth_token_encoding immediately when ladder submission enters staged', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      db.setAgentLadders(alpha.id, ['rby'], 1_700_000_000);
      const ver = db.createSubmission({
        agentId: alpha.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/alpha-1.0.tar.zst',
        sha256: 'b'.repeat(64),
        authTokenEncoding: 'enc:ladder-token',
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_000,
      });
      expect(db.getVersionById(ver.id)?.authTokenEncoding).toBe('enc:ladder-token');
      db.applySubmissionStatus({versionId: ver.id, smokeStatus: 'staged', now: 1_700_000_010});
      expect(db.getVersionById(ver.id)?.authTokenEncoding).toBeUndefined();
      expect(db.getStagedLadderVersionIds()).toContain(ver.id);
    } finally {
      db.close();
    }
  });

  test('retains tournament auth_token_encoding until tournament completes', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      db.upsertTournament({
        id: 't-scrub',
        name: 'Scrub Cup',
        format: 'gen9ou',
        version: '0.11.0',
        gamesPerMatchup: 2,
        parallelTables: 1,
        hardware: '1× A100',
        startsAt: 1_700_100_000,
      });
      const ver = db.createSubmission({
        agentId: alpha.id,
        version: '1.0',
        package: 'oci',
        url: 'ghcr.io/pkmn/alpha:1.0',
        sha256: 'a'.repeat(64),
        authTokenEncoding: 'enc:secret-token',
        ladderIds: [],
        tournamentIds: ['t-scrub'],
        now: 1_700_000_000,
      });
      db.applySubmissionStatus({versionId: ver.id, smokeStatus: 'staged', now: 1_700_000_010});
      expect(db.getVersionById(ver.id)?.authTokenEncoding).toBe('enc:secret-token');
      db.activateStagedVersion({versionId: ver.id, agentId: alpha.id, now: 1_700_000_020});
      expect(db.getVersionById(ver.id)?.authTokenEncoding).toBe('enc:secret-token');
      db.setTournamentStatus('t-scrub', 'completed', 1_700_200_000);
      expect(db.getVersionById(ver.id)?.authTokenEncoding).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('scrubs auth_token_encoding when retiring last active ladder entry', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      db.setAgentLadders(alpha.id, ['rby'], 1_700_000_000);
      const ver = db.createSubmission({
        agentId: alpha.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/alpha-1.0.tar.zst',
        sha256: 'b'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_000,
      });
      db.applySubmissionStatus({versionId: ver.id, smokeStatus: 'passed', now: 1_700_000_010});
      db.db.prepare('UPDATE agent_versions SET auth_token_encoding = ? WHERE id = ?')
        .run('enc:legacy-token', ver.id);
      db.retireLadderEntry('gen1ou20261109', alpha.slug, '1.0', 1_700_000_030);
      expect(db.getVersionById(ver.id)?.authTokenEncoding).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('scrubs auth_token_encoding when archiving last active ladder', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      db.setAgentLadders(alpha.id, ['rby'], 1_700_000_000);
      const ver = db.createSubmission({
        agentId: alpha.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/alpha-1.0.tar.zst',
        sha256: 'c'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_000,
      });
      db.applySubmissionStatus({versionId: ver.id, smokeStatus: 'passed', now: 1_700_000_010});
      db.db.prepare('UPDATE agent_versions SET auth_token_encoding = ? WHERE id = ?')
        .run('enc:archive-token', ver.id);
      db.setLadderStatus('gen1ou20261109', 'archived', 1_700_000_030);
      expect(db.getVersionById(ver.id)?.authTokenEncoding).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('scrubs auth_token_encoding when disabling an agent', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      db.setAgentLadders(alpha.id, ['rby'], 1_700_000_000);
      const ver = db.createSubmission({
        agentId: alpha.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/alpha-1.0.tar.zst',
        sha256: 'd'.repeat(64),
        authTokenEncoding: 'enc:disable-token',
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_000,
      });
      expect(db.getVersionById(ver.id)?.authTokenEncoding).toBe('enc:disable-token');
      db.syncProjectsFromYaml('[]\n', undefined, 1_700_000_020);
      expect(db.getVersionById(ver.id)?.authTokenEncoding).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('activateStagedVersion rejects revoked ladder qualification', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      db.setAgentLadders(alpha.id, ['rby'], 1_700_000_000);
      const ver = db.createSubmission({
        agentId: alpha.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/alpha-1.0.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_000,
      });
      db.applySubmissionStatus({versionId: ver.id, smokeStatus: 'staged', now: 1_700_000_010});
      db.setAgentLadders(alpha.id, [], 1_700_000_020);
      expect(() => db.activateStagedVersion({
        versionId: ver.id, agentId: alpha.id, now: 1_700_000_030,
      })).toThrow(/pending staff review/);

      db.setAgentLadders(alpha.id, ['rand'], 1_700_000_040);
      expect(() => db.activateStagedVersion({
        versionId: ver.id, agentId: alpha.id, now: 1_700_000_050,
      })).toThrow(/no longer qualified/);
    } finally {
      db.close();
    }
  });

  test('activateStagedVersion reverts pending pools teams on closed target ladder', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(
        `${sampleLadders}\n- name: VGC\n  format: gen9championsvgc2026regmc\n` +
          '  version: 0.11.0\n  team: pools\n  teams: 2\n  id: vgc2026\n',
        1_700_000_000
      );
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      db.setAgentLadders(alpha.id, ['rby', 'vgc'], 1_700_000_000);
      db.replaceSavedTeams('vgc2026', alpha.id, ['t1', 't2'], 1_700_000_000);
      const ver = db.createSubmission({
        agentId: alpha.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/alpha-1.0.tar.zst',
        sha256: 'b'.repeat(64),
        ladderIds: ['gen1ou20261109', 'vgc2026'],
        teamsByLadder: {vgc2026: ['t1', 't2']},
        now: 1_700_000_000,
      });
      db.applySubmissionStatus({versionId: ver.id, smokeStatus: 'staged', now: 1_700_000_010});
      db.setLadderStatus('vgc2026', 'archived', 1_700_000_020);
      db.activateStagedVersion({versionId: ver.id, agentId: alpha.id, now: 1_700_000_030});

      expect(db.getVersionById(ver.id)?.ladders).toEqual(['gen1ou20261109']);
      expect(db.getTeamsForAgentLadder('vgc2026', alpha.id, 'pending')).toEqual([]);
      expect(db.getTeamsForAgentLadder('vgc2026', alpha.id, 'saved')).toEqual(['t1', 't2']);
    } finally {
      db.close();
    }
  });

  test('activateStagedVersion rejects duplicate tournament entry with 409', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      db.setAgentLadders(alpha.id, ['rby'], 1_700_000_000);
      db.upsertTournament({
        id: 't-dup',
        name: 'Dup Cup',
        format: 'gen9ou',
        version: '0.11.0',
        gamesPerMatchup: 2,
        parallelTables: 1,
        hardware: '1× A100',
        startsAt: 1_700_100_000,
      });
      const v1 = db.createSubmission({
        agentId: alpha.id,
        version: '1.0',
        package: 'oci',
        url: 'ghcr.io/pkmn/alpha:1.0',
        sha256: 'a'.repeat(64),
        ladderIds: [],
        tournamentIds: ['t-dup'],
        now: 1_700_000_000,
      });
      db.applySubmissionStatus({versionId: v1.id, smokeStatus: 'staged', now: 1_700_000_010});
      const seeded = db.createSubmission({
        agentId: alpha.id,
        version: '0.9',
        package: 'oci',
        url: 'ghcr.io/pkmn/alpha:0.9',
        sha256: 'c'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_015,
      });
      db.applySubmissionStatus({versionId: seeded.id, smokeStatus: 'passed', now: 1_700_000_016});
      db.upsertTournamentEntrant({
        tournamentId: 't-dup',
        agentId: alpha.id,
        versionId: seeded.id,
        seed: 1,
      });
      expect(() => db.activateStagedVersion({
        versionId: v1.id, agentId: alpha.id, now: 1_700_000_020,
      })).toThrow(/Already entered/);
      expect(db.getVersionById(v1.id)?.smokeStatus).toBe('staged');
    } finally {
      db.close();
    }
  });

  test('pruneExpiredDiscordWatches removes watches for disabled agents or departed members', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      const beta = db.getAgentBySlug('beta')!;
      db.syncDiscordMembers([{id: 'u1', username: 'alice'}], 1_700_000_000);
      db.addDiscordWatch({discordId: 'u1', agentId: alpha.id, now: 1_700_000_000});
      db.addDiscordWatch({discordId: 'u1', agentId: beta.id, now: 1_700_000_001});
      db.addDiscordWatch({discordId: 'u-departed', agentId: alpha.id, now: 1_700_000_002});

      db.db.prepare('UPDATE agents SET status = ? WHERE id = ?').run('disabled', beta.id);
      expect(db.pruneExpiredDiscordWatches(1_700_000_020)).toBe(2);
      expect(db.listDiscordWatchesForUser('u1').map(w => w.agentSlug)).toEqual(['alpha']);
      expect(db.listDiscordWatchesForUser('u-departed')).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('addDiscordWatch prunes stale user watches before enforcing per-user limit', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      const beta = db.getAgentBySlug('beta')!;
      const gamma = db.getAgentBySlug('gamma')!;
      const delta = db.getAgentBySlug('delta')!;
      db.addDiscordWatch({discordId: 'u1', agentId: alpha.id, now: 1_700_000_000});
      db.addDiscordWatch({discordId: 'u1', agentId: beta.id, now: 1_700_000_001});
      db.addDiscordWatch({discordId: 'u1', agentId: gamma.id, now: 1_700_000_002});
      db.addDiscordWatch({discordId: 'u1', agentId: delta.id, now: 1_700_000_003});
      db.addDiscordWatch({
        discordId: 'u1',
        agentId: alpha.id,
        ladderId: 'gen1ou20261109',
        now: 1_700_000_004,
      });
      // Archive the ladder for the 5th watch; adding a new watch should succeed after inline prune.
      db.setLadderStatus('gen1ou20261109', 'archived', 1_700_000_010);
      const res = db.addDiscordWatch({
        discordId: 'u1',
        agentId: beta.id,
        ladderId: 'gen9randombattle20261109',
        now: 1_700_000_020,
      });
      expect(res.status).toBe('added');
      expect(db.listDiscordWatchesForUser('u1')).toHaveLength(5);
    } finally {
      db.close();
    }
  });

  test('unquarantineVersion resets invalid_choices alongside other fault counters', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      db.setAgentLadders(alpha.id, ['rby'], 1_700_000_000);
      const ver = db.createSubmission({
        agentId: alpha.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/alpha-1.0.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_000,
      });
      db.applySubmissionStatus({versionId: ver.id, smokeStatus: 'passed', now: 1_700_000_010});
      db.db.prepare(
        'UPDATE ladder_entries SET crashes = 2, timeouts = 1, ooms = 1, invalid_choices = 7 ' +
          'WHERE ladder_id = ? AND version_id = ?'
      ).run('gen1ou20261109', ver.id);
      db.quarantineVersion('alpha', '1.0', 'test quarantine', 1_700_000_020);
      db.unquarantineVersion('alpha', '1.0', 1_700_000_030);
      const row = db.db.prepare(
        'SELECT crashes, timeouts, ooms, invalid_choices FROM ladder_entries ' +
          'WHERE ladder_id = ? AND version_id = ?'
      ).get('gen1ou20261109', ver.id) as {
        crashes: number;
        timeouts: number;
        ooms: number;
        invalid_choices: number;
      };
      expect(row).toEqual({crashes: 0, timeouts: 0, ooms: 0, invalid_choices: 0});
    } finally {
      db.close();
    }
  });

  test('recordCompletedMatch ignores non-positive cpuCores without double-rounding', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      const beta = db.getAgentBySlug('beta')!;
      db.setAgentLadders(alpha.id, ['rby'], 1_700_000_000);
      db.setAgentLadders(beta.id, ['rby'], 1_700_000_000);
      const va = db.createSubmission({
        agentId: alpha.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/a.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_000,
      });
      const vb = db.createSubmission({
        agentId: beta.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/b.tar.zst',
        sha256: 'b'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_000,
      });
      db.applySubmissionStatus({versionId: va.id, smokeStatus: 'passed', now: 1_700_000_010});
      db.applySubmissionStatus({versionId: vb.id, smokeStatus: 'passed', now: 1_700_000_010});
      db.recordCompletedMatch({
        match: {
          id: 'cpu-norm-1',
          ladderId: 'gen1ou20261109',
          p1VersionId: va.id,
          p2VersionId: vb.id,
          seed: '1,2,3,4',
          category: 'WL',
          game1Outcome: 'W',
          game2Outcome: 'L',
          game1Turns: 10,
          game2Turns: 10,
          game1EndReason: 'normal',
          game2EndReason: 'normal',
          p1Game1PeakRam: 10,
          p1Game2PeakRam: 10,
          p2Game1PeakRam: 10,
          p2Game2PeakRam: 10,
          p1Game1InitMillis: 10,
          p1Game2InitMillis: 10,
          p2Game1InitMillis: 10,
          p2Game2InitMillis: 10,
          p1Game1MeanTurnMillis: 10,
          p1Game2MeanTurnMillis: 10,
          p2Game1MeanTurnMillis: 10,
          p2Game2MeanTurnMillis: 10,
          p1Game1BankSeconds: 100,
          p1Game2BankSeconds: 100,
          p2Game1BankSeconds: 100,
          p2Game2BankSeconds: 100,
          // Zero game2 cpuCores must be ignored instead of halving to 1.0.
          p1Game1CpuCores: 2.0,
          p1Game2CpuCores: 0,
          // Raw mean (1.06 + 1.16) / 2 = 1.11 -> 1.1 (double-rounding would yield 1.2).
          p2Game1CpuCores: 1.06,
          p2Game2CpuCores: 1.16,
          completedAt: 1_700_000_020,
        },
      });
      const recent = db.getRecentMatches(10);
      expect(recent[0].p1.cpuCores).toBe(2);
      expect(recent[0].games[1].p1.cpuCores).toBeUndefined();
      expect(recent[0].p2.cpuCores).toBe(1.1);
    } finally {
      db.close();
    }
  });

  test('getLadderAdminSummaries seeks idx_matches_ladder_completed for 24h counts', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      const plan = db.db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT
          l.id AS ladder_id,
          (
            SELECT COUNT(*)
            FROM matches m
            WHERE m.ladder_id = l.id AND m.completed_at >= ?
          ) AS matches_24h
        FROM ladders l
        WHERE l.status != 'archived'
      `).all(1_699_913_600) as Array<{detail: string}>;
      const details = plan.map(r => r.detail).join('\n');
      expect(details).toContain('SEARCH m USING COVERING INDEX idx_matches_ladder_completed');
    } finally {
      db.close();
    }
  });

  test('wipeVersion deletes an unplayed passed version while unlocking VGC pools', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLadders(undefined, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      db.setAgentLadders(alpha.id, ['vgc'], 1_700_000_000);
      const ver = db.createSubmission({
        agentId: alpha.id,
        version: '0.1.0',
        package: 'bundle',
        url: 'https://example.com/alpha-0.1.0.tar.zst',
        sha256: 'c'.repeat(64),
        ladderIds: ['gen9championsvgc2026regmc'],
        teamsByLadder: {gen9championsvgc2026regmc: ['t1', 't2']},
        now: 1_700_000_000,
      });
      db.applySubmissionStatus({
        versionId: ver.id,
        smokeStatus: 'passed',
        diagnostics: [{
          ladderId: 'gen9championsvgc2026regmc',
          format: 'gen9championsvgc2026regmc',
          turns: 4,
          endReason: 'normal',
          durationMillis: 500,
          battleLog: '|start\n|win|Alpha\n',
        }],
        now: 1_700_000_010,
      });
      expect(db.getWipeableVersionIds()).toContain(ver.id);
      expect(db.hasActiveLadderTeams('gen9championsvgc2026regmc', alpha.id)).toBe(true);

      const wiped = db.wipeVersion(ver.id, 1_700_000_020);
      expect(wiped.version.id).toBe(ver.id);
      expect(db.getVersionById(ver.id)).toBeUndefined();
      expect(db.getSmokeDiagnosticsForVersion(ver.id)).toEqual([]);
      expect(db.getAllVersionIds()).toEqual([]);
      expect(db.hasActiveLadderTeams('gen9championsvgc2026regmc', alpha.id)).toBe(false);
      expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', alpha.id, 'saved')).toEqual([
        't1',
        't2',
      ]);

      // Version label is reusable while sqlite_sequence never reuses the deleted numeric ID.
      const reupload = db.createSubmission({
        agentId: alpha.id,
        version: '0.1.0',
        package: 'bundle',
        url: 'https://example.com/alpha-0.1.0-new.tar.zst',
        sha256: 'd'.repeat(64),
        ladderIds: ['gen9championsvgc2026regmc'],
        teamsByLadder: {gen9championsvgc2026regmc: ['t1', 't2']},
        now: 1_700_000_030,
      });
      expect(reupload.id).toBeGreaterThan(ver.id);
    } finally {
      db.close();
    }
  });

  test('wipeVersion rejects versions with played ladder matches with 409', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      const beta = db.getAgentBySlug('beta')!;
      db.setAgentLadders(alpha.id, ['rby'], 1_700_000_000);
      db.setAgentLadders(beta.id, ['rby'], 1_700_000_000);
      const va = db.createSubmission({
        agentId: alpha.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/a.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_000,
      });
      const vb = db.createSubmission({
        agentId: beta.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/b.tar.zst',
        sha256: 'b'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_000,
      });
      db.applySubmissionStatus({versionId: va.id, smokeStatus: 'passed', now: 1_700_000_010});
      db.applySubmissionStatus({versionId: vb.id, smokeStatus: 'passed', now: 1_700_000_010});
      db.recordCompletedMatch({
        match: {
          id: 'wipe-guard-1',
          ladderId: 'gen1ou20261109',
          p1VersionId: va.id,
          p2VersionId: vb.id,
          seed: '1,2,3,4',
          category: 'WW',
          game1Outcome: 'W',
          game2Outcome: 'W',
          game1Turns: 10,
          game2Turns: 10,
          game1EndReason: 'normal',
          game2EndReason: 'normal',
          p1Game1PeakRam: 10,
          p1Game2PeakRam: 10,
          p2Game1PeakRam: 10,
          p2Game2PeakRam: 10,
          p1Game1InitMillis: 10,
          p1Game2InitMillis: 10,
          p2Game1InitMillis: 10,
          p2Game2InitMillis: 10,
          p1Game1MeanTurnMillis: 10,
          p1Game2MeanTurnMillis: 10,
          p2Game1MeanTurnMillis: 10,
          p2Game2MeanTurnMillis: 10,
          p1Game1BankSeconds: 100,
          p1Game2BankSeconds: 100,
          p2Game1BankSeconds: 100,
          p2Game2BankSeconds: 100,
          completedAt: 1_700_000_020,
        },
      });
      expect(db.getWipeableVersionIds()).not.toContain(va.id);
      expect(() => db.wipeVersion(va.id, 1_700_000_030)).toThrow(/played ladder matches/);
    } finally {
      db.close();
    }
  });

  test('wipeVersion rejects pending versions or ladder anchors with 409', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      const beta = db.getAgentBySlug('beta')!;
      db.setAgentLadders(alpha.id, ['rby'], 1_700_000_000);
      db.setAgentLadders(beta.id, ['rby'], 1_700_000_000);
      const pending = db.createSubmission({
        agentId: alpha.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/a.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_000,
      });
      const anchor = db.createSubmission({
        agentId: beta.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/b.tar.zst',
        sha256: 'b'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_000,
      });
      db.applySubmissionStatus({versionId: anchor.id, smokeStatus: 'passed', now: 1_700_000_010});
      db.setLadderAnchor('gen1ou20261109', beta.slug, '1.0', 1_700_000_015);
      expect(db.getWipeableVersionIds()).toEqual([]);
      expect(() => db.wipeVersion(pending.id, 1_700_000_020)).toThrow(/pending smoke testing/);
      expect(() => db.wipeVersion(anchor.id, 1_700_000_020)).toThrow(/ladder anchor/);
    } finally {
      db.close();
    }
  });

  test('wipeVersion rejects unplayed versions enrolled on active or settling ladders with 409',
    () => {
      const db = new database.Database(':memory:', {now: 1_700_000_000});
      try {
        db.syncLadders(undefined, 1_700_000_000);
        db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
        const ladderId = 'gen9championsvgc2026regmc';
        const slugs = ['alpha', 'beta', 'gamma', 'delta'];
        const versions: Record<string, number> = {};
        for (const [i, slug] of slugs.entries()) {
          const agent = db.getAgentBySlug(slug)!;
          db.setAgentLadders(agent.id, ['vgc'], 1_700_000_000);
          const v = db.createSubmission({
            agentId: agent.id,
            version: '1.0',
            package: 'bundle',
            url: `https://example.com/${slug}-1.0.tar.zst`,
            sha256: String(i + 1).repeat(64),
            ladderIds: [ladderId],
            teamsByLadder: {[ladderId]: [`${slug}-t1`, `${slug}-t2`]},
            now: 1_700_000_000,
          });
          db.applySubmissionStatus({versionId: v.id, smokeStatus: 'passed', now: 1_700_000_010});
          versions[slug] = v.id;
        }
        db.setLadderAnchor(ladderId, 'alpha', '1.0', 1_700_000_015);
        db.setLadderStatus(ladderId, 'active', 1_700_000_020);

        expect(db.getWipeableVersionIds()).not.toContain(versions.delta);
        expect(() => db.wipeVersion(versions.delta, 1_700_000_030)).toThrow(
          /live or archived ladder/
        );

        const {oldLadder} = db.rotateLadder({
          oldLadderId: ladderId,
          archivedName: 'VGC Reg M-C',
          now: 1_700_000_040,
        });
        expect(oldLadder.status).toBe('settling');
        expect(db.getWipeableVersionIds()).not.toContain(versions.delta);
        expect(() => db.wipeVersion(versions.delta, 1_700_000_050)).toThrow(
          /live or archived ladder/
        );
      } finally {
        db.close();
      }
    });

  test('wipeVersion allows wiping a staged version targeting an active ladder', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      db.setAgentLadders(alpha.id, ['rby'], 1_700_000_000);
      const staged = db.createSubmission({
        agentId: alpha.id,
        version: '0.1',
        package: 'bundle',
        url: 'https://example.com/a-0.1.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_000,
      });
      db.applySubmissionStatus({versionId: staged.id, smokeStatus: 'staged', now: 1_700_000_010});
      expect(db.getWipeableVersionIds()).toContain(staged.id);
      db.wipeVersion(staged.id, 1_700_000_020);
      expect(db.getVersionById(staged.id)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('wipeVersion demotes active pools to pending for a concurrent staged upgrade', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLadders(undefined, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const ladderId = 'gen9championsvgc2026regmc';
      const alpha = db.getAgentBySlug('alpha')!;
      db.setAgentLadders(alpha.id, ['vgc'], 1_700_000_000);
      const v1 = db.createSubmission({
        agentId: alpha.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/alpha-1.0.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: [ladderId],
        teamsByLadder: {[ladderId]: ['t1', 't2']},
        now: 1_700_000_000,
      });
      db.applySubmissionStatus({versionId: v1.id, smokeStatus: 'passed', now: 1_700_000_010});
      db.refundCooldown(alpha.slug, 1_700_000_020);

      // Submit v1.1 reusing the locked `'active'` pool (no `teamsByLadder` override).
      const v2 = db.createSubmission({
        agentId: alpha.id,
        version: '1.1',
        package: 'bundle',
        url: 'https://example.com/alpha-1.1.tar.zst',
        sha256: 'b'.repeat(64),
        ladderIds: [ladderId],
        now: 1_700_000_030,
      });
      db.applySubmissionStatus({versionId: v2.id, smokeStatus: 'staged', now: 1_700_000_040});

      db.wipeVersion(v1.id, 1_700_000_050);
      expect(db.hasActiveLadderTeams(ladderId, alpha.id)).toBe(false);
      expect(db.getTeamsForAgentLadder(ladderId, alpha.id, 'pending')).toEqual(['t1', 't2']);

      db.activateStagedVersion({versionId: v2.id, agentId: alpha.id, now: 1_700_000_060});
      expect(db.hasActiveLadderTeams(ladderId, alpha.id)).toBe(true);
      expect(db.getTeamsForAgentLadder(ladderId, alpha.id, 'active')).toEqual(['t1', 't2']);
    } finally {
      db.close();
    }
  });

  test('wipeVersion demotes active pools to pending for a concurrent pending upgrade', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLadders(undefined, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const ladderId = 'gen9championsvgc2026regmc';
      const alpha = db.getAgentBySlug('alpha')!;
      db.setAgentLadders(alpha.id, ['vgc'], 1_700_000_000);
      const v1 = db.createSubmission({
        agentId: alpha.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/alpha-1.0.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: [ladderId],
        teamsByLadder: {[ladderId]: ['t1', 't2']},
        now: 1_700_000_000,
      });
      db.applySubmissionStatus({versionId: v1.id, smokeStatus: 'passed', now: 1_700_000_010});
      db.refundCooldown(alpha.slug, 1_700_000_020);
      const v2 = db.createSubmission({
        agentId: alpha.id,
        version: '1.1',
        package: 'bundle',
        url: 'https://example.com/alpha-1.1.tar.zst',
        sha256: 'b'.repeat(64),
        ladderIds: [ladderId],
        now: 1_700_000_030,
      });

      db.wipeVersion(v1.id, 1_700_000_040);
      const pending = db.getPendingSubmissions().find(p => p.versionId === v2.id);
      expect(pending?.teamsByLadder[ladderId]).toEqual(['t1', 't2']);
    } finally {
      db.close();
    }
  });

  test('recordCompletedMatch rejects a wiped versionId with 409', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      db.syncLaddersFromYaml(sampleLadders, 1_700_000_000);
      db.syncProjectsFromYaml(sampleProjects, undefined, 1_700_000_000);
      const alpha = db.getAgentBySlug('alpha')!;
      const beta = db.getAgentBySlug('beta')!;
      db.setAgentLadders(alpha.id, ['rby'], 1_700_000_000);
      db.setAgentLadders(beta.id, ['rby'], 1_700_000_000);
      const va = db.createSubmission({
        agentId: alpha.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/a.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_000,
      });
      const vb = db.createSubmission({
        agentId: beta.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/b.tar.zst',
        sha256: 'b'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_000,
      });
      db.applySubmissionStatus({versionId: va.id, smokeStatus: 'staged', now: 1_700_000_010});
      db.applySubmissionStatus({versionId: vb.id, smokeStatus: 'passed', now: 1_700_000_010});
      db.wipeVersion(va.id, 1_700_000_020);

      let caught: {status?: number} | undefined;
      try {
        db.recordCompletedMatch({
          match: {
            id: 'wiped-match-1',
            ladderId: 'gen1ou20261109',
            p1VersionId: va.id,
            p2VersionId: vb.id,
            seed: '1,2,3,4',
            category: 'WW',
            game1Outcome: 'W',
            game2Outcome: 'W',
            game1Turns: 8,
            game2Turns: 8,
            game1EndReason: 'normal',
            game2EndReason: 'normal',
            p1Game1PeakRam: 10,
            p1Game2PeakRam: 10,
            p2Game1PeakRam: 10,
            p2Game2PeakRam: 10,
            p1Game1InitMillis: 10,
            p1Game2InitMillis: 10,
            p2Game1InitMillis: 10,
            p2Game2InitMillis: 10,
            p1Game1MeanTurnMillis: 10,
            p1Game2MeanTurnMillis: 10,
            p2Game1MeanTurnMillis: 10,
            p2Game2MeanTurnMillis: 10,
            p1Game1BankSeconds: 100,
            p1Game2BankSeconds: 100,
            p2Game1BankSeconds: 100,
            p2Game2BankSeconds: 100,
            completedAt: 1_700_000_030,
          },
        });
      } catch (err) {
        caught = err as {status?: number};
      }
      expect(caught?.status).toBe(409);
    } finally {
      db.close();
    }
  });

  test('applySubmissionStatus rejects a wiped versionId with 409', () => {
    const db = new database.Database(':memory:', {now: 1_700_000_000});
    try {
      let caught: {status?: number} | undefined;
      try {
        db.applySubmissionStatus({
          versionId: 99999,
          smokeStatus: 'quarantined',
          now: 1_700_000_010,
        });
      } catch (err) {
        caught = err as {status?: number};
      }
      expect(caught?.status).toBe(409);
    } finally {
      db.close();
    }
  });
});

describe('diagnostic version pruning', () => {
  const sampleProjects = `
- name: Alpha
  arena:
    owners:
      dev1: '1001'
`;

  function makeDiag(opts: {
    ladderId?: string;
    tournamentId?: string;
    battleLog?: string;
    p1Stderr?: string;
    p2Stderr?: string;
  }): database.SmokeDiagnosticInput {
    return {
      ladderId: opts.ladderId,
      tournamentId: opts.tournamentId,
      format: opts.tournamentId ? 'gen9ou' : 'gen1ou',
      turns: 5,
      endReason: 'crash',
      durationMillis: 1200,
      battleLog: opts.battleLog ?? '|turn|1\n',
      p1Stderr: opts.p1Stderr,
      p2Stderr: opts.p2Stderr,
      infoStatus: 'full',
    };
  }

  function setupDb(now = 1_760_000_000) {
    const db = new database.Database(':memory:', {now});
    db.syncLadders(undefined, now);
    db.syncProjectsFromYaml(sampleProjects, undefined, now);
    db.setAgentLadders('alpha', ['rby'], now);
    db.setUnlimitedSmokeTests('alpha', true, now);
    const alpha = db.getAgentBySlug('alpha')!;
    return {db, alpha, now};
  }

  test('prunes failed ladder versions beyond retention cap with cascading diagnostics', () => {
    const {db, alpha, now} = setupDb();
    try {
      const ids: number[] = [];
      for (let i = 1; i <= database.MAX_RETAINED_FAILED_VERSIONS + 2; i++) {
        const v = db.createSubmission({
          agentId: alpha.id,
          version: `0.0.${i}`,
          package: 'bundle',
          url: `https://example.com/v${i}.tar.zst`,
          sha256: 'a'.repeat(64),
          ladderIds: ['gen1ou20261109'],
          now: now + i * 60,
        });
        db.applySubmissionStatus({
          versionId: v.id,
          smokeStatus: 'failed',
          smokeError: `crash ${i}`,
          diagnostics: [makeDiag({ladderId: 'gen1ou20261109', p1Stderr: `err ${i}`})],
          now: now + i * 60 + 10,
        });
        ids.push(v.id);
      }

      const remaining = db.getVersionsForAgent(alpha.id);
      expect(remaining.map(v => v.id)).toEqual(
        ids.slice(-database.MAX_RETAINED_FAILED_VERSIONS).reverse()
      );
      expect(db.getSmokeDiagnosticsForVersion(ids[0])).toEqual([]);
      expect(db.getSmokeDiagnosticsForVersion(ids[1])).toEqual([]);
      expect(db.getSmokeDiagnosticsForVersion(ids[ids.length - 1])).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('prunes discarded staged ladder versions beyond retention cap', () => {
    const {db, alpha, now} = setupDb();
    try {
      const ids: number[] = [];
      for (let i = 1; i <= database.MAX_RETAINED_FAILED_VERSIONS + 2; i++) {
        const v = db.createSubmission({
          agentId: alpha.id,
          version: `0.1.${i}`,
          package: 'bundle',
          url: `https://example.com/s${i}.tar.zst`,
          sha256: 'b'.repeat(64),
          ladderIds: ['gen1ou20261109'],
          now: now + i * 60,
        });
        db.applySubmissionStatus({
          versionId: v.id,
          smokeStatus: 'staged',
          diagnostics: [makeDiag({ladderId: 'gen1ou20261109'})],
          now: now + i * 60 + 10,
        });
        db.discardStagedVersion({versionId: v.id, agentId: alpha.id});
        ids.push(v.id);
      }

      const remaining = db.getVersionsForAgent(alpha.id);
      expect(remaining.map(v => v.id)).toEqual(
        ids.slice(-database.MAX_RETAINED_FAILED_VERSIONS).reverse()
      );
      expect(db.getSmokeDiagnosticsForVersion(ids[0])).toEqual([]);
      expect(db.getSmokeDiagnosticsForVersion(ids[1])).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('preserves passed versions when pruning old failed ladder attempts', () => {
    const {db, alpha, now} = setupDb();
    try {
      const passed = db.createSubmission({
        agentId: alpha.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://example.com/1.0.0.tar.zst',
        sha256: 'c'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: now + 10,
      });
      db.applySubmissionStatus({
        versionId: passed.id,
        smokeStatus: 'passed',
        diagnostics: [makeDiag({ladderId: 'gen1ou20261109', battleLog: '|turn|9\n'})],
        now: now + 20,
      });
      db.refundCooldown('alpha', now + 30);

      for (let i = 1; i <= database.MAX_RETAINED_FAILED_VERSIONS + 2; i++) {
        const v = db.createSubmission({
          agentId: alpha.id,
          version: `1.1.${i}`,
          package: 'bundle',
          url: `https://example.com/f${i}.tar.zst`,
          sha256: 'd'.repeat(64),
          ladderIds: ['gen1ou20261109'],
          now: now + 100 + i * 60,
        });
        db.applySubmissionStatus({
          versionId: v.id,
          smokeStatus: 'failed',
          smokeError: 'oom',
          diagnostics: [makeDiag({ladderId: 'gen1ou20261109'})],
          now: now + 100 + i * 60 + 10,
        });
      }

      expect(db.getVersionById(passed.id)?.smokeStatus).toBe('passed');
      expect(db.getSmokeDiagnosticsForVersion(passed.id)).toHaveLength(1);
      const failed = db.getVersionsForAgent(alpha.id).filter(v => v.smokeStatus === 'failed');
      expect(failed).toHaveLength(database.MAX_RETAINED_FAILED_VERSIONS);
    } finally {
      db.close();
    }
  });

  test('prunes failed tournament attempts independently of failed ladder attempts', () => {
    const {db, alpha, now} = setupDb();
    try {
      db.upsertTournament({
        id: 't-prune-1',
        name: 'Tournament #1',
        format: 'gen9ou',
        version: '0.11.0',
        gamesPerMatchup: 2,
        parallelTables: 2,
        hardware: 'test',
        status: 'scheduled',
        startsAt: now + 7 * 86_400,
      });

      const ladderIds: number[] = [];
      for (let i = 1; i <= database.MAX_FAILED_SMOKE_TESTS; i++) {
        const v = db.createSubmission({
          agentId: alpha.id,
          version: `1.0.${i}`,
          package: 'bundle',
          url: `https://example.com/l${i}.tar.zst`,
          sha256: 'a'.repeat(64),
          ladderIds: ['gen1ou20261109'],
          now: now + i * 60,
        });
        db.applySubmissionStatus({
          versionId: v.id,
          smokeStatus: 'failed',
          smokeError: 'ladder fail',
          now: now + i * 60 + 10,
        });
        ladderIds.push(v.id);
      }

      const tourneyIds: number[] = [];
      for (let i = 1; i <= database.MAX_RETAINED_FAILED_VERSIONS + 2; i++) {
        const v = db.createSubmission({
          agentId: alpha.id,
          version: `2.0.${i}`,
          package: 'oci',
          url: `ghcr.io/pkmn/alpha:t${i}`,
          sha256: 'b'.repeat(64),
          ladderIds: [],
          tournamentIds: ['t-prune-1'],
          now: now + 1_000 + i * 60,
        });
        db.applySubmissionStatus({
          versionId: v.id,
          smokeStatus: 'failed',
          smokeError: 'tourney fail',
          now: now + 1_000 + i * 60 + 10,
        });
        tourneyIds.push(v.id);
      }

      const versions = db.getVersionsForAgent(alpha.id);
      expect(versions.filter(v => v.ladders.length > 0).map(v => v.id)).toEqual(
        [...ladderIds].reverse()
      );
      expect(versions.filter(v => v.tournaments.length > 0).map(v => v.id)).toEqual(
        tourneyIds.slice(-database.MAX_RETAINED_FAILED_VERSIONS).reverse()
      );

      db.setUnlimitedSmokeTests('alpha', false, now + 2_000);
      const ladderStatus = db.computeAgentSubmissionStatus(alpha.id, now + 2_010);
      expect(ladderStatus.canSubmit).toBe(false);
      expect(ladderStatus.reason).toContain('Failed smoke test limit reached');
    } finally {
      db.close();
    }
  });

  test('retains newly discarded older tournament version when newer failures fill cap', () => {
    const {db, alpha, now} = setupDb();
    try {
      for (const id of ['t-old', 't-new']) {
        db.upsertTournament({
          id,
          name: `Tournament ${id}`,
          format: 'gen9ou',
          version: '0.11.0',
          gamesPerMatchup: 2,
          parallelTables: 2,
          hardware: 'test',
          status: 'scheduled',
          startsAt: now + 7 * 86_400,
        });
      }

      const olderStaged = db.createSubmission({
        agentId: alpha.id,
        version: '0.9.0',
        package: 'oci',
        url: 'ghcr.io/pkmn/alpha:old',
        sha256: 'a'.repeat(64),
        ladderIds: [],
        tournamentIds: ['t-old'],
        now: now + 10,
      });
      db.applySubmissionStatus({
        versionId: olderStaged.id,
        smokeStatus: 'staged',
        diagnostics: [makeDiag({tournamentId: 't-old'})],
        now: now + 20,
      });

      const newerFailedIds: number[] = [];
      for (let i = 1; i <= database.MAX_RETAINED_FAILED_VERSIONS; i++) {
        const v = db.createSubmission({
          agentId: alpha.id,
          version: `1.0.${i}`,
          package: 'oci',
          url: `ghcr.io/pkmn/alpha:new${i}`,
          sha256: 'b'.repeat(64),
          ladderIds: [],
          tournamentIds: ['t-new'],
          now: now + 100 + i * 60,
        });
        db.applySubmissionStatus({
          versionId: v.id,
          smokeStatus: 'failed',
          smokeError: 'crash',
          now: now + 100 + i * 60 + 10,
        });
        newerFailedIds.push(v.id);
      }

      const discarded = db.discardStagedVersion({versionId: olderStaged.id, agentId: alpha.id});
      expect(discarded.id).toBe(olderStaged.id);
      expect(discarded.smokeStatus).toBe('discarded');

      const remainingIds = db.getVersionsForAgent(alpha.id).map(v => v.id);
      expect(remainingIds).toHaveLength(database.MAX_RETAINED_FAILED_VERSIONS);
      expect(remainingIds).toContain(olderStaged.id);
      expect(remainingIds).not.toContain(newerFailedIds[0]);
      expect(remainingIds).toContain(newerFailedIds[newerFailedIds.length - 1]);
    } finally {
      db.close();
    }
  });

  test('getSmokeDiagnosticSummariesForAgent detects empty vs non-empty logs', () => {
    const {db, alpha, now} = setupDb();
    try {
      const v = db.createSubmission({
        agentId: alpha.id,
        version: '0.5.0',
        package: 'bundle',
        url: 'https://example.com/0.5.0.tar.zst',
        sha256: 'e'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: now + 10,
      });
      db.applySubmissionStatus({
        versionId: v.id,
        smokeStatus: 'staged',
        diagnostics: [
          makeDiag({ladderId: 'gen1ou20261109', battleLog: '', p1Stderr: undefined, p2Stderr: ''}),
          makeDiag({
            ladderId: 'gen1ou20261109',
            battleLog: '|turn|1\n',
            p1Stderr: 'p1 warn',
            p2Stderr: undefined,
          }),
        ],
        now: now + 20,
      });

      const summaries = db.getSmokeDiagnosticSummariesForAgent(alpha.id).get(v.id)!;
      expect(summaries).toHaveLength(2);
      expect(summaries[0]).toMatchObject({
        hasLog: false,
        hasStderr: false,
        hasP1Stderr: false,
        hasP2Stderr: false,
      });
      expect(summaries[1]).toMatchObject({
        hasLog: true,
        hasStderr: true,
        hasP1Stderr: true,
        hasP2Stderr: false,
      });
    } finally {
      db.close();
    }
  });
});
