import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {Teams} from '@pkmn/sim';

import {
  Database,
  LADDERS_FILE,
  SCHEMA_DIR,
  getTournamentClosesAt,
  parseArenaProjects,
  parseLaddersYaml,
} from '../db';
import * as arena from '../server/arena';
import * as smogon from '../server/smogon';
import {validateHarvestedTeams} from '../server/teams';
import {validateAgentName, validateVersion} from '../static/util';
import {generateValidHarvestedTeams, generateValidVgcTeams} from '../tools/mock';

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
    const db1 = new Database(dbFile, {schemaDir, migrationDir, now: 1000});
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
      `
    );
    fs.writeFileSync(path.join(schemaDir, 'items.sql'), `
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        tag TEXT NOT NULL DEFAULT 'v1'
      );
    `);

    return {dbFile, schemaDir, migrationDir};
  }

  test('loads individual .sql table definitions from db/schema/', () => {
    const schemaFiles = fs.readdirSync(SCHEMA_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();
    expect(schemaFiles).toEqual([
      'agent-ladder-stats.sql',
      'agent-ladder-teams.sql',
      'agent-versions.sql',
      'agents.sql',
      'developers.sql',
      'discord-members.sql',
      'ladder-entries.sql',
      'ladder-teams.sql',
      'ladders.sql',
      'matches.sql',
      'pair-aggregates.sql',
      'rating-snapshots.sql',
      'schema-migrations.sql',
      'tournament-entrants.sql',
      'tournament-games.sql',
      'tournaments.sql',
    ]);

    const db = new Database(':memory:');
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
    const db = new Database(dbFile, {schemaDir, migrationDir, now: 2000});
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
    const freshDb = new Database(':memory:', {schemaDir, migrationDir, now: 3000});
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
    const db2 = new Database(dbFile, {schemaDir, migrationDir, now: 2000});
    db2.close();

    fs.writeFileSync(
      path.join(migrationDir, '0003-break-fk.sql'),
      'DELETE FROM items WHERE id = 1;'
    );
    expect(() => new Database(dbFile, {schemaDir, migrationDir, now: 4000}))
      .toThrow(/Foreign key check failed in migration "0003-break-fk.sql"/);

    fs.rmSync(path.join(migrationDir, '0003-break-fk.sql'));
    const db3 = new Database(dbFile, {schemaDir, migrationDir, now: 5000});
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
    const db = new Database(':memory:');
    try {
      db.syncProjectsFromYaml(`
- name: Good Proj
  active: 2026
  arena:
    qualified: true
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
});

describe('competitor saved teams lifecycle', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.syncLadders(LADDERS_FILE, 1_760_000_000);
    db.syncProjectsFromYaml(`
      - name: 0 ERROR
        active: 2026
        arena:
          qualified: true
          owners:
            pre: pre.10544
    `, undefined, 1_760_000_000);
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
    const db = new Database(':memory:');
    try {
      db.syncLadders(LADDERS_FILE, 1_760_000_000);
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
    expect(() => parseLaddersYaml(`
- name: VGC
  format: gen9championsvgc2026regmc
  id: gen9championsvgc2026regmc
  team: pools
  status: active
`)).toThrow(/must specify a positive teams count/);
  });

  test('rejects pools ladders with min below 4', () => {
    expect(() => parseLaddersYaml(`
- name: VGC
  format: gen9championsvgc2026regmc
  id: gen9championsvgc2026regmc
  team: pools
  status: active
  min: 3
  teams: 20
`)).toThrow(/Invalid min "3"/);
  });

  test('rejects multiple current ladders sharing the same slot', () => {
    expect(() => parseLaddersYaml(`
- name: VGC
  format: gen9championsvgc2026regmc
  id: gen9championsvgc2026regmc
  team: pools
  status: active
  teams: 20
- name: VGC
  format: gen9championsvgc2026regmd
  id: gen9championsvgc2026regmd
  team: pools
  status: active
  teams: 20
`)).toThrow(/Multiple current ladders configured for slot "vgc"/);
  });

  test('syncs archived seasons alongside active slot replacements', () => {
    const db = new Database(':memory:');
    try {
      db.syncLaddersFromYaml(`
- name: VGC 2026 Reg M-C
  format: gen9championsvgc2026regmc
  id: gen9championsvgc2026regmc
  team: pools
  status: archived
  teams: 20
- name: VGC
  format: gen9championsvgc2026regmd
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
    const db = new Database(':memory:');
    try {
      const laddersYaml = `
- name: VGC
  format: gen9championsvgc2026regmc
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
        newLadderId: 'gen9championsvgc2026regmd',
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

  test('rejects rotateLadder when newMin is below 4 on a pools ladder', () => {
    const db = new Database(':memory:');
    try {
      db.syncLaddersFromYaml(`
- name: VGC
  format: gen9championsvgc2026regmc
  id: gen9championsvgc2026regmc
  team: pools
  teams: 20
  status: active
  min: 4
`, 1_760_000_000);
      expect(() => db.rotateLadder({
        oldLadderId: 'gen9championsvgc2026regmc',
        archivedName: 'VGC 2026 Reg M-C',
        newLadderId: 'gen9championsvgc2026regmd',
        newMin: 2,
        now: 1_765_000_000,
      })).toThrow(/Invalid min/);
    } finally {
      db.close();
    }
  });

  function seedTwoProjectsWithFourActiveVersions(db: Database) {
    db.syncLaddersFromYaml(`
- name: VGC
  format: gen9championsvgc2026regmc
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
    qualified: true
    owners:
      pre: pre.10544
- name: Foul Play
  active: 2026
  arena:
    qualified: true
    owners:
      pmariglia: pmariglia.100001
`, undefined, 1_760_000_000);

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
    const db = new Database(':memory:');
    try {
      const ladderId = seedTwoProjectsWithFourActiveVersions(db);
      const entries = db.getLeaderboardEntries(ladderId);
      expect(entries.filter(e => e.role !== 'retired')).toHaveLength(4);
      expect(
        arena.buildLadderMatchState(
          db.getLadder(ladderId)!,
          entries,
          db.getPairAggregatesForLadder(ladderId)
        )
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('retains 14-day cooldown after self-quarantine until refunded', () => {
    const db = new Database(':memory:');
    try {
      db.syncLaddersFromYaml(`
- name: RAND
  format: gen9randombattle
  id: gen9randombattle
  team: random
  status: active
`, 1_760_000_000);
      db.syncProjectsFromYaml(`
- name: 0 ERROR
  active: 2026
  arena:
    qualified: true
    owners:
      pre: pre.10544
`, undefined, 1_760_000_000);
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
    const db = new Database(':memory:');
    try {
      const ladderId = seedTwoProjectsWithFourActiveVersions(db);
      const rotated = db.rotateLadder({
        oldLadderId: ladderId,
        archivedName: 'VGC 2026 Reg M-C',
        newLadderId: 'gen9championsvgc2026regmd',
        now: 1_766_000_000,
      });
      expect(rotated.oldLadder.status).toBe('archived');
      expect(db.getLeaderboardEntries(ladderId).every(e => e.role === 'retired')).toBe(true);
    } finally {
      db.close();
    }
  });

  test('keeps settling pools ladder active when one of four projects is quarantined', () => {
    const db = new Database(':memory:');
    try {
      db.syncLaddersFromYaml(`
- name: VGC
  format: gen9championsvgc2026regmc
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
    qualified: true
    owners:
      pre: pre.10544
- name: Foul Play
  active: 2026
  arena:
    qualified: true
    owners:
      pmariglia: pmariglia.100001
- name: PokeChamp
  active: 2026
  arena:
    qualified: true
    owners:
      seth: seth.100002
- name: Metamon
  active: 2026
  arena:
    qualified: true
    owners:
      jake: jake.100003
`, undefined, 1_760_000_000);

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
        newLadderId: 'gen9championsvgc2026regmd',
        now: 1_766_000_000,
      });
      expect(rotated.oldLadder.status).toBe('settling');

      db.quarantineVersion('0-error', '1.0.0', 'Strategic crash', 1_766_000_100);
      const ladderAfter = db.getLadder(ladderId)!;
      expect(ladderAfter.status).toBe('settling');

      const rosterIds = new Set(db.getActiveRosterForLadder(ladderId).map(r => r.agentId));
      expect(rosterIds.size).toBe(4);
      expect(arena.buildLadderMatchState(
        ladderAfter,
        db.getLeaderboardEntries(ladderId),
        db.getPairAggregatesForLadder(ladderId),
        0,
        rosterIds
      )).toBeDefined();
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
    globalThis.fetch = ((input: URL | RequestInfo) => {
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
      if (url.includes('members/10544/?tooltip=true')) {
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
      if (url.includes('members/1/?tooltip=true')) {
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
      if (url.includes('members/666/?tooltip=true')) {
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
    expect(() => parseArenaProjects(`
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
    expect(() => parseArenaProjects(`
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
    const db = new Database(':memory:');
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
    const db = new Database(':memory:');
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
    const db = new Database(':memory:');
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
    const db = new Database(':memory:');
    try {
      const yamlText = `
- name: Foul Play
  active: 2021
  arena:
    qualified: true
    owners:
      pmariglia: pmariglia.535629
`;
      db.syncProjectsFromYaml(yamlText, tmpDir, 1000);
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
    const db = new Database(':memory:');
    try {
      await expect(db.syncProjectsFromYamlWithSmogon(`
- name: Bad Proj
  active: 2026
  arena:
    qualified: true
    owners:
      badgh: 666
- name: Good Proj
  active: 2026
  arena:
    qualified: true
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
      db.linkDeveloperDiscord('badgh', '111111', 'baduser', 1_760_000_110);
      db.linkDeveloperDiscord('goodgh', '222222', 'gooduser', 1_760_000_110);
      expect(db.getCompetitorDiscordIds()).toEqual(['222222']);
    } finally {
      db.close();
    }
  });

  test('syncs active projects offline while ignoring historical-only projects', () => {
    const avatarsDir = path.join(tmpDir, 'avatars');
    fs.mkdirSync(avatarsDir, {recursive: true});
    fs.writeFileSync(path.join(avatarsDir, 'foul-play.png'), 'PNG');

    const db = new Database(':memory:');
    try {
      db.syncProjectsFromYaml(`
- name: Foul Play
  active: 2021
  arena:
    qualified: true
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

      const fp = db.getAgentBySlug('foul-play')!;
      expect(fp.logo).toBe('foul-play.png');
      expect(fp.status).toBe('qualified');
      expect(db.getAgentBySlug('metamon')?.status).toBe('pending');
      expect(db.getAgentBySlug('historical-only')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('preserves linked GitHub or Discord OAuth IDs across YAML re-syncs', () => {
    const db = new Database(':memory:');
    try {
      db.syncProjectsFromYaml(`
- name: Foul Play
  active: 2021
  arena:
    qualified: true
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
    const db = new Database(':memory:');
    try {
      db.syncProjectsFromYaml(`
- name: Foul Play
  active: 2021
  arena:
    qualified: true
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
    const db = new Database(':memory:');
    try {
      db.syncLadders(LADDERS_FILE, 1_760_000_000);
      db.db.prepare("UPDATE ladders SET status = 'active' WHERE id = 'gen1ou20261109'").run();
      db.syncProjectsFromYaml(`
- name: 0 ERROR
  active: 2026
  arena:
    qualified: true
    owners:
      scheibo: pre.10544
`, undefined, 1_760_000_100);
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
    qualified: true
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
    const db = new Database(':memory:');
    try {
      db.syncLadders(LADDERS_FILE, 1_760_000_000);
      db.db.prepare("UPDATE ladders SET status = 'active' WHERE id = 'gen1ou20261109'").run();
      db.syncProjectsFromYaml(`
- name: 0 ERROR
  active: 2026
  arena:
    qualified: true
    owners:
      scheibo: pre.10544
- name: Foul Play
  active: 2026
  arena:
    qualified: true
    owners:
      pmariglia: pmariglia.535629
`, undefined, 1_760_000_100);

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
    qualified: true
    owners: {}
- name: Foul Play
  active: 2026
  arena:
    qualified: true
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
    qualified: true
    owners:
      scheibo: pre.10544
- name: Foul Play
  active: 2026
  arena:
    qualified: true
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
    const db = new Database(':memory:');
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
    expect(() => parseArenaProjects(`
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
    const db = new Database(':memory:');
    try {
      db.syncLadders(LADDERS_FILE, 1_760_000_000);
      db.syncProjectsFromYaml(`
- name: 0 ERROR
  active: 2026
  arena:
    qualified: true
    owners:
      pre: pre.10544
`, undefined, 1_760_000_000);
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
    expect(getTournamentClosesAt(midDayStart)).toBe(sameDayMidnight);
    expect(getTournamentClosesAt(sameDayMidnight)).toBe(prevDayMidnight);
  });
});

describe('ladder activation invariants', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.syncLadders(LADDERS_FILE, 1_760_000_000);
    db.syncProjectsFromYaml(`
- name: Alpha
  active: 2026
  arena:
    qualified: true
    owners:
      alpha: alpha.1
- name: Beta
  active: 2026
  arena:
    qualified: true
    owners:
      beta: beta.2
- name: Gamma
  active: 2026
  arena:
    qualified: true
    owners:
      gamma: gamma.3
- name: Delta
  active: 2026
  arena:
    qualified: true
    owners:
      delta: delta.4
`, undefined, 1_760_000_000);
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
  let db: Database;
  let versionIds: number[];

  beforeEach(() => {
    db = new Database(':memory:');
    db.syncLaddersFromYaml(`
- name: RAND
  format: gen9randombattle
  id: gen9randombattle
  team: random
  status: upcoming
  min: 2
`, 1_760_000_000);
    db.syncProjectsFromYaml(`
- name: Alpha
  active: 2026
  arena:
    qualified: true
    owners:
      a: a.1
- name: Beta
  active: 2026
  arena:
    qualified: true
    owners:
      b: b.2
- name: Gamma
  active: 2026
  arena:
    qualified: true
    owners:
      c: c.3
`, undefined, 1_760_000_000);

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
            p1PeakRam: 64,
            p2PeakRam: 64,
            p1Game1BankSeconds: 100,
            p1Game2BankSeconds: 100,
            p2Game1BankSeconds: 100,
            p2Game2BankSeconds: 100,
            p1MeanTurnMillis: 50,
            p2MeanTurnMillis: 50,
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
          p1PeakRam: 64,
          p2PeakRam: 64,
          p1Game1BankSeconds: 100,
          p1Game2BankSeconds: 100,
          p2Game1BankSeconds: 100,
          p2Game2BankSeconds: 100,
          p1MeanTurnMillis: 50,
          p2MeanTurnMillis: 50,
          completedAt: 1_760_004_300,
        },
      })).toThrow(/archived/);
    });
});

describe('tournament standings', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.syncProjectsFromYaml(`
- name: Entrant A
  active: 2026
  arena:
    qualified: true
    owners:
      ea: ea.101
- name: Entrant B
  active: 2026
  arena:
    qualified: true
    owners:
      eb: eb.102
- name: Entrant C
  active: 2026
  arena:
    qualified: true
    owners:
      ec: ec.103
`, undefined, 1_760_000_300);
    db.upsertTournament({
      id: 'sf-test',
      name: 'SF Tiebreak',
      format: 'gen9ou',
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
        p1VersionId: p1,
        p2VersionId: p2,
        seed: '1,2,3,4',
        p1Team: 'Pikachu|||static|||||||]',
        p2Team: 'Pikachu|||static|||||||]',
        outcome,
        turns: 10,
        endReason: 'normal',
        p1BankSeconds: 100,
        p2BankSeconds: 100,
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
        p1VersionId: entVers[0].id,
        p2VersionId: entVers[1].id,
        seed: '1,2,3,4',
        p1Team: 'Pikachu|||static|||||||]',
        p2Team: 'Pikachu|||static|||||||]',
        outcome: 'W',
        turns: 10,
        endReason: 'normal',
        p1BankSeconds: 100,
        p2BankSeconds: 100,
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
});
