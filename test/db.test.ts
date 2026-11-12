import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {Database, LADDERS_FILE, SCHEMA_DIR, parseArenaProjects, parseLaddersYaml} from '../db';
import * as smogon from '../server/smogon';
import {validateAgentName, validateVersion} from '../static/util';

describe('db/schema/*.sql & db/migration/* lifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-migration-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

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

  test('applies migrations with pre-backup, rebuilds tables, and rolls back FK errors', () => {
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
    expect(db1.getAppliedMigrations()).toEqual([]);
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

    const db2 = new Database(dbFile, {schemaDir, migrationDir, now: 2000});
    expect(fs.existsSync(`${dbFile}.pre-0001-add-tag.bak`)).toBe(true);
    expect(db2.getAppliedMigrations()).toEqual([
      {version: '0001-add-tag.sql', appliedAt: 2000},
      {version: '0002-rebuild-items.sql', appliedAt: 2000},
    ]);
    const row = db2.db.prepare('SELECT id, name, tag FROM items WHERE id = 1').get();
    expect(row).toEqual({id: 1, name: 'alpha', tag: 'v1'});
    db2.close();

    // Fresh DB fast-forwards schemaDir and marks migrations applied without re-running ALTER
    const freshDb = new Database(':memory:', {schemaDir, migrationDir, now: 3000});
    expect(freshDb.getAppliedMigrations()).toEqual([
      {version: '0001-add-tag.sql', appliedAt: 3000},
      {version: '0002-rebuild-items.sql', appliedAt: 3000},
    ]);
    freshDb.close();

    fs.writeFileSync(
      path.join(migrationDir, '0003-break-fk.sql'),
      'DELETE FROM items WHERE id = 1;'
    );
    expect(() => new Database(dbFile, {schemaDir, migrationDir, now: 4000}))
      .toThrow(/Foreign key check failed in migration "0003-break-fk.sql"/);

    fs.rmSync(path.join(migrationDir, '0003-break-fk.sql'));
    const db3 = new Database(dbFile, {schemaDir, migrationDir, now: 5000});
    expect(db3.db.prepare('SELECT name FROM items WHERE id = 1').get()).toEqual({name: 'alpha'});
    expect(db3.getAppliedMigrations().map(m => m.version)).toEqual([
      '0001-add-tag.sql',
      '0002-rebuild-items.sql',
    ]);
    db3.close();
  });
});

describe('ladders.yml & Database ladder sync', () => {
  test('parses and syncs canonical config/ladders.yml with inferred slots', () => {
    const db = new Database(':memory:');
    try {
      db.syncLadders(LADDERS_FILE, 1_760_000_000);
      expect(db.getActiveLadders()).toEqual([]);
      const ladders = db.getCurrentLadders();
      expect(ladders.map(l => ({
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

  test('supports seasonal rotation and rejects duplicate active slots', () => {
    expect(() => parseLaddersYaml(`
- name: VGC
  format: gen9championsvgc2026regmc
  id: gen9championsvgc2026regmc
  team: pools
  status: active
`)).toThrow(/must specify a positive teams count/);

    expect(() => parseLaddersYaml(`
- name: VGC
  format: gen9championsvgc2026regmc
  id: gen9championsvgc2026regmc
  team: pools
  status: active
  min: 3
  teams: 20
`)).toThrow(/Invalid min "3"/);

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
});

describe('Smogon lookup & projects.yml arena sync', () => {
  let tmpDir: string;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-db-test-'));
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('parseIdentifier extracts IDs from numbers, slugs, URLs, or usernames', () => {
    expect(smogon.parseIdentifier(10544)).toEqual({id: 10544});
    expect(smogon.parseIdentifier('10544')).toEqual({id: 10544});
    expect(smogon.parseIdentifier('pre.10544')).toEqual({id: 10544, username: 'pre'});
    expect(smogon.parseIdentifier('https://www.smogon.com/forums/members/pre.10544/'))
      .toEqual({id: 10544, username: 'pre'});
    expect(smogon.parseIdentifier('/forums/members/10544/'))
      .toEqual({id: 10544, username: undefined});
    expect(smogon.parseIdentifier('Dr. Perfidious')).toEqual({username: 'Dr. Perfidious'});
  });

  test('lookupUser resolves usernames via 303 and parses tooltip JSON', async () => {
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

    expect(await smogon.lookupUser('pre', 'test-token')).toEqual({
      id: 10544,
      username: 'pre',
      slug: 'pre',
      url: 'https://www.smogon.com/forums/members/pre.10544/',
      banned: false,
    });

    expect(await smogon.lookupUser(1, 'test-token')).toEqual({
      id: 1,
      username: "chaos & co's",
      slug: 'chaos',
      url: 'https://www.smogon.com/forums/members/chaos.1/',
      banned: false,
    });

    const banned = await smogon.lookupUser('cheater.666', 'test-token');
    expect(banned.banned).toBe(true);
  });

  test('enforces one-project-per-developer on GitHub login and numerical smogonId', async () => {
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

  test('resolves Smogon usernames, refreshes renames by ID, and blocks banned users', async () => {
    const db = new Database(':memory:');
    try {
      let currentPreName = 'pre';
      const lookupCalls: Array<string | number> = [];
      const mockLookup = (raw: string | number) => {
        lookupCalls.push(raw);
        if (raw === 'pre' || raw === 10544) {
          return Promise.resolve({
            id: 10544,
            username: currentPreName,
            slug: currentPreName,
            url: `https://www.smogon.com/forums/members/${currentPreName}.10544/`,
            banned: false,
          });
        }
        return Promise.resolve({
          id: 535629,
          username: 'pmariglia',
          slug: 'pmariglia',
          url: 'https://www.smogon.com/forums/members/pmariglia.535629/',
          banned: currentPreName === 'BANNED_MODE',
        });
      };

      const yamlText = `
- name: Foul Play
  active: 2021
  arena:
    owners:
      scheibo: pre
      pmariglia: pmariglia
`;

      await db.syncProjectsFromYamlWithSmogon(yamlText, {
        avatarsDir: tmpDir,
        lookupSmogon: mockLookup,
        now: 1000,
      });
      expect(lookupCalls).toEqual(['pre', 'pmariglia']);
      expect(db.getDeveloperByGitHub('scheibo')).toMatchObject({
        smogonId: 10544,
        smogonUsername: 'pre',
      });

      // Simulate user 10544 changing Smogon name to 'pre_new' while projects.yml still says 'pre'
      currentPreName = 'pre_new';
      lookupCalls.length = 0;
      await db.syncProjectsFromYamlWithSmogon(yamlText, {
        avatarsDir: tmpDir,
        lookupSmogon: mockLookup,
        now: 2000,
      });
      expect(lookupCalls).toEqual([10544, 535629]);
      expect(db.getDeveloperByGitHub('scheibo')).toMatchObject({
        smogonId: 10544,
        smogonUsername: 'pre_new',
      });

      // Banned Smogon user is rejected
      currentPreName = 'BANNED_MODE';
      await expect(db.syncProjectsFromYamlWithSmogon(yamlText, {
        avatarsDir: tmpDir,
        lookupSmogon: mockLookup,
        now: 3000,
      })).rejects.toThrow(/is banned/);
    } finally {
      db.close();
    }
  });

  test('syncs multi-owner projects offline via <slug>.<id> and preserves OAuth IDs', () => {
    const avatarsDir = path.join(tmpDir, 'avatars');
    fs.mkdirSync(avatarsDir, {recursive: true});
    fs.writeFileSync(path.join(avatarsDir, 'foul-play.png'), 'PNG');

    const dbFile = path.join(tmpDir, 'arena.sqlite');
    const db = new Database(dbFile);
    try {
      db.syncProjectsFromYaml(`
- name: Foul Play
  active: 2021
  arena:
    qualified: true
    owners:
      PMariglia: pmariglia.535629
      CoAuthor: coauthor.1002
- name: Metamon
  active: 2025
  arena:
    owners:
      jakegrigsby: 2001
- name: Historical Only
  active: [2019, 2020]
`, avatarsDir, 1_760_000_000);

      const fp = db.getAgentBySlug('foul-play')!;
      expect(fp.name).toBe('Foul Play');
      expect(fp.logo).toBe('foul-play.png');
      expect(fp.status).toBe('qualified');

      const mm = db.getAgentBySlug('metamon')!;
      expect(mm.logo).toBeUndefined();
      expect(mm.status).toBe('pending');
      expect(db.getAgentBySlug('historical-only')).toBeUndefined();

      db.linkDeveloperGitHubId('PMariglia', 4242, 1_760_000_100);
      db.linkDeveloperDiscord('PMariglia', '283674461268344832', 'pmariglia', 1_760_000_100);

      db.syncProjectsFromYaml(`
- name: Foul Play
  active: 2021
  arena:
    owners:
      pmariglia: pmariglia_renamed.535629
      thirddev: third.1003
`, avatarsDir, 1_760_000_200);

      const dev = db.getDeveloperByGitHub('pmariglia')!;
      expect(dev.smogonId).toBe(535629);
      expect(dev.smogonUsername).toBe('pmariglia_renamed');
      expect(dev.githubId).toBe(4242);
      expect(dev.discordId).toBe('283674461268344832');
      expect(dev.discordUsername).toBe('pmariglia');

      expect(db.getDeveloperByGitHub('coauthor')).toBeUndefined();
      expect(db.getDevelopersForAgent(fp.id).map(d => d.githubLogin)).toEqual([
        'pmariglia',
        'thirddev',
      ]);

      const disabledMm = db.getAgentById(mm.id)!;
      expect(disabledMm.status).toBe('disabled');
      expect(db.getDeveloperByGitHub('jakegrigsby')).toBeUndefined();

      db.unlinkDeveloperDiscord('pmariglia', 1_760_000_300);
      expect(db.getDeveloperByGitHub('pmariglia')!.discordId).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('syncs and checks Discord guild membership', () => {
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

  test('supports developer reassignment (A -> B -> A) and unowned active projects', () => {
    const db = new Database(':memory:');
    try {
      db.syncLadders(LADDERS_FILE, 1_760_000_000);
      db.setLadderStatus('gen1ou20261109', 'active', 1_760_000_010);

      // Initial state: scheibo owns 0 ERROR (Project A), pmariglia owns Foul Play (Project B)
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
        url: 'https://example.com/0-error-1.0.0.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_760_000_200,
      });
      db.applySubmissionStatus({versionId: vZero.id, smokeStatus: 'passed', now: 1_760_000_210});

      // Move scheibo A -> B while retiring 0 ERROR to owners: {} (unowned active project)
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

      // 0 ERROR stays qualified and keeps its active ladder entry, with 0 owners able to submit
      expect(db.getAgentBySlug('0-error')!.status).toBe('qualified');
      expect(db.getDevelopersForAgent(zeroAgent.id)).toEqual([]);
      expect(db.getActiveEntriesForAgent(zeroAgent.id)).toHaveLength(1);

      // scheibo keeps primary key, OAuth IDs, and past submission attribution, now on Foul Play
      const movedDev = db.getDeveloperByGitHub('scheibo')!;
      expect(movedDev.id).toBe(initialDev.id);
      expect(movedDev.agentId).toBe(fpAgent.id);
      expect(movedDev.githubId).toBe(1001);
      expect(movedDev.discordId).toBe('513513270670262284');
      expect(db.getVersionById(vZero.id)!.developerId).toBe(initialDev.id);

      // Move scheibo B -> A (back to 0 ERROR)
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
      expect(returnedDev.discordId).toBe('513513270670262284');
      expect(db.getDevelopersForAgent(zeroAgent.id).map(d => d.githubLogin)).toEqual(['scheibo']);
      expect(db.getDevelopersForAgent(fpAgent.id).map(d => d.githubLogin)).toEqual(['pmariglia']);
    } finally {
      db.close();
    }
  });

  test('enforces <=18-char Pokémon Showdown agent names, toID uniqueness, and <=12-char versions',
    () => {
      expect(validateAgentName('0 ERROR')).toBe('0 ERROR');
      expect(validateAgentName("Mew's Truck")).toBe("Mew's Truck");
      expect(validateAgentName('PokéChamp 18Chars!')).toBe('PokéChamp 18Chars!');

      expect(() => validateAgentName('Name With Nineteen!')).toThrow(/1–18 characters/);
      expect(() => validateAgentName('Guest 1234')).toThrow(/guest/i);
      expect(() => validateAgentName('@RankPrefix')).toThrow(/rank or command/);
      expect(() => validateAgentName('~AdminBot')).toThrow(/rank or command/);
      expect(() => validateAgentName('/slashcmd')).toThrow(/rank or command/);
      expect(() => validateAgentName('Pipe|Name')).toThrow(/Showdown|reserved/i);
      expect(() => validateAgentName('Double  Space')).toThrow(/Showdown/);
      expect(() => validateAgentName('12345')).toThrow(/at least one ASCII letter/);

      expect(validateVersion('1.0.0')).toBe('1.0.0');
      expect(validateVersion('1.4.1-t3')).toBe('1.4.1-t3');
      expect(validateVersion('v2026.11.11a')).toBe('v2026.11.11a'); // 12 chars
      expect(() => validateVersion('v2026.11.11ab')).toThrow(/1–12 characters/); // 13 chars
      expect(() => validateVersion('-bad')).toThrow(/1–12 characters/);
      expect(() => validateVersion('..')).toThrow(/1–12 characters/);
      expect(() => validateVersion('1.0/bad')).toThrow(/1–12 characters/);

      // Duplicate Showdown `toID` across distinct slugs (`Foo Bar` vs `FooBar`) is rejected
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
          url: 'https://example.com/0-error.tar.zst',
          sha256: 'a'.repeat(64),
          ladderIds: ['gen1ou20261109'],
        })).toThrow(/1–12 characters/);
      } finally {
        db.close();
      }
    });
});
