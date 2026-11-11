import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ArenaDB,
  LADDERS_FILE,
  SCHEMA_DIR,
  parseArenaProjects,
  parseLaddersYaml,
} from '../db';
import {lookupSmogonUser, parseSmogonIdentifier} from '../server/smogon';

describe('db/schema/*.sql & db/migration/* lifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-migration-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('loads individual .sql table definitions from db/schema/', () => {
    const schemaFiles = fs.readdirSync(SCHEMA_DIR).filter(f => f.endsWith('.sql')).sort();
    expect(schemaFiles).toEqual([
      'bot-ladder-stats.sql',
      'bot-ladder-teams.sql',
      'bot-versions.sql',
      'bots.sql',
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

    const db = new ArenaDB(':memory:');
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
    const db1 = new ArenaDB(dbFile, {schemaDir, migrationDir, now: 1000});
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

    const db2 = new ArenaDB(dbFile, {schemaDir, migrationDir, now: 2000});
    expect(fs.existsSync(`${dbFile}.pre-0001-add-tag.bak`)).toBe(true);
    expect(db2.getAppliedMigrations()).toEqual([
      {version: '0001-add-tag.sql', applied_at: 2000},
      {version: '0002-rebuild-items.sql', applied_at: 2000},
    ]);
    const row = db2.db.prepare('SELECT id, name, tag FROM items WHERE id = 1').get();
    expect(row).toEqual({id: 1, name: 'alpha', tag: 'v1'});
    db2.close();

    // Fresh DB fast-forwards schemaDir and marks migrations applied without re-running ALTER
    const freshDb = new ArenaDB(':memory:', {schemaDir, migrationDir, now: 3000});
    expect(freshDb.getAppliedMigrations()).toEqual([
      {version: '0001-add-tag.sql', applied_at: 3000},
      {version: '0002-rebuild-items.sql', applied_at: 3000},
    ]);
    freshDb.close();

    fs.writeFileSync(
      path.join(migrationDir, '0003-break-fk.sql'),
      'DELETE FROM items WHERE id = 1;'
    );
    expect(() => new ArenaDB(dbFile, {schemaDir, migrationDir, now: 4000}))
      .toThrow(/Foreign key check failed in migration "0003-break-fk.sql"/);

    fs.rmSync(path.join(migrationDir, '0003-break-fk.sql'));
    const db3 = new ArenaDB(dbFile, {schemaDir, migrationDir, now: 5000});
    expect(db3.db.prepare('SELECT name FROM items WHERE id = 1').get()).toEqual({name: 'alpha'});
    expect(db3.getAppliedMigrations().map(m => m.version)).toEqual([
      '0001-add-tag.sql',
      '0002-rebuild-items.sql',
    ]);
    db3.close();
  });
});

describe('ladders.yml & ArenaDB ladder sync', () => {
  test('parses and syncs canonical config/ladders.yml', () => {
    const db = new ArenaDB(':memory:');
    try {
      db.syncLadders(LADDERS_FILE, 1_760_000_000);
      expect(db.getActiveLadders()).toEqual([]);
      const ladders = db.getCurrentLadders();
      expect(ladders.map(l => ({
        id: l.id,
        slot: l.slot,
        display_name: l.display_name,
        format_id: l.format_id,
        team_mode: l.team_mode,
        min_bots: l.min_bots,
        discord_role: l.discord_role,
        status: l.status,
      }))).toEqual([
        {
          id: 'gen1ou20261109',
          slot: 'rby',
          display_name: 'RBY',
          format_id: 'gen1ou',
          team_mode: 'harvested',
          min_bots: 2,
          discord_role: '1563716887131459685',
          status: 'upcoming',
        },
        {
          id: 'gen3ou20261109',
          slot: 'adv',
          display_name: 'ADV',
          format_id: 'gen3ou',
          team_mode: 'harvested',
          min_bots: 2,
          discord_role: '1563717163481825472',
          status: 'upcoming',
        },
        {
          id: 'gen9ou20261109',
          slot: 'sv',
          display_name: 'SV',
          format_id: 'gen9ou',
          team_mode: 'harvested',
          min_bots: 2,
          discord_role: '1563717708720377977',
          status: 'upcoming',
        },
        {
          id: 'gen9randombattle20261109',
          slot: 'rand',
          display_name: 'RAND',
          format_id: 'gen9randombattle',
          team_mode: 'random',
          min_bots: 2,
          discord_role: '1563718027994992752',
          status: 'upcoming',
        },
        {
          id: 'gen9championsvgc2026regmc',
          slot: 'vgc',
          display_name: 'VGC',
          format_id: 'gen9championsvgc2026regmc',
          team_mode: 'competitor_pool',
          min_bots: 3,
          discord_role: '1564121375558340768',
          status: 'upcoming',
        },
      ]);
    } finally {
      db.close();
    }
  });

  test('supports seasonal rotation and rejects duplicate active slots', () => {
    expect(() => parseLaddersYaml(`
- id: gen9championsvgc2026regmc
  slot: vgc
  display_name: VGC
  format_id: gen9championsvgc2026regmc
  team_mode: competitor_pool
  status: active
`)).toThrow(/must specify a positive team_count/);

    expect(() => parseLaddersYaml(`
- id: gen9championsvgc2026regmc
  slot: vgc
  display_name: VGC
  format_id: gen9championsvgc2026regmc
  team_mode: competitor_pool
  team_count: 20
  status: active
- id: gen9championsvgc2026regmd
  slot: vgc
  display_name: VGC
  format_id: gen9championsvgc2026regmd
  team_mode: competitor_pool
  team_count: 20
  status: active
`)).toThrow(/Multiple current ladders configured for slot "vgc"/);

    const db = new ArenaDB(':memory:');
    try {
      db.syncLaddersFromYaml(`
- id: gen9championsvgc2026regmc
  slot: vgc
  display_name: VGC 2026 Reg M-C
  format_id: gen9championsvgc2026regmc
  team_mode: competitor_pool
  team_count: 20
  status: archived
- id: gen9championsvgc2026regmd
  slot: vgc
  display_name: VGC
  format_id: gen9championsvgc2026regmd
  team_mode: competitor_pool
  team_count: 20
  status: active
`, 1_765_000_000);

      const currentVgc = db.getActiveLadderBySlot('vgc')!;
      expect(currentVgc.id).toBe('gen9championsvgc2026regmd');
      expect(currentVgc.team_count).toBe(20);
      const old = db.getLadder('gen9championsvgc2026regmc')!;
      expect(old.status).toBe('archived');
      expect(old.display_name).toBe('VGC 2026 Reg M-C');
      expect(old.archived_at).toBe(1_765_000_000);
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

  test('parseSmogonIdentifier extracts IDs from numbers, slugs, URLs, or usernames', () => {
    expect(parseSmogonIdentifier(10544)).toEqual({id: 10544});
    expect(parseSmogonIdentifier('10544')).toEqual({id: 10544});
    expect(parseSmogonIdentifier('pre.10544')).toEqual({id: 10544, username: 'pre'});
    expect(parseSmogonIdentifier('https://www.smogon.com/forums/members/pre.10544/'))
      .toEqual({id: 10544, username: 'pre'});
    expect(parseSmogonIdentifier('/forums/members/10544/'))
      .toEqual({id: 10544, username: undefined});
    expect(parseSmogonIdentifier('Dr. Perfidious')).toEqual({username: 'Dr. Perfidious'});
  });

  test('lookupSmogonUser resolves usernames via 303 and parses tooltip JSON', async () => {
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

    expect(await lookupSmogonUser('pre', 'test-token')).toEqual({
      id: 10544,
      username: 'pre',
      slug: 'pre',
      url: 'https://www.smogon.com/forums/members/pre.10544/',
      banned: false,
    });

    expect(await lookupSmogonUser(1, 'test-token')).toEqual({
      id: 1,
      username: "chaos & co's",
      slug: 'chaos',
      url: 'https://www.smogon.com/forums/members/chaos.1/',
      banned: false,
    });

    const banned = await lookupSmogonUser('cheater.666', 'test-token');
    expect(banned.banned).toBe(true);
  });

  test('enforces one-project-per-developer on GitHub login and numerical smogon_id', async () => {
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

    const db = new ArenaDB(':memory:');
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
    const db = new ArenaDB(':memory:');
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
        smogon_id: 10544,
        smogon_username: 'pre',
      });

      // Simulate user 10544 changing Smogon name to 'pre_new' while projects.yml still says 'pre'
      currentPreName = 'pre_new';
      lookupCalls.length = 0;
      await db.syncProjectsFromYamlWithSmogon(yamlText, {
        avatarsDir: tmpDir,
        lookupSmogon: mockLookup,
        now: 2000,
      });
      // Looked up by stored numerical ID (10544 & 535629), not stale string 'pre'!
      expect(lookupCalls).toEqual([10544, 535629]);
      expect(db.getDeveloperByGitHub('scheibo')).toMatchObject({
        smogon_id: 10544,
        smogon_username: 'pre_new',
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
    const db = new ArenaDB(dbFile);
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

      const fp = db.getBotBySlug('foul-play')!;
      expect(fp.name).toBe('Foul Play');
      expect(fp.logo_file).toBe('foul-play.png');
      expect(fp.status).toBe('qualified');

      const mm = db.getBotBySlug('metamon')!;
      expect(mm.logo_file).toBeNull();
      expect(mm.status).toBe('pending');
      expect(db.getBotBySlug('historical-only')).toBeUndefined();

      db.linkDeveloperGitHubId('PMariglia', 4242, 1_760_000_100);
      db.linkDeveloperDiscord('PMariglia', '283674461268344832', 'pmariglia', 1_760_000_100);

      // Re-sync after name change on ID 535629, removing CoAuthor, and dropping Metamon from arena
      db.syncProjectsFromYaml(`
- name: Foul Play
  active: 2021
  arena:
    owners:
      pmariglia: pmariglia_renamed.535629
      thirddev: third.1003
`, avatarsDir, 1_760_000_200);

      const dev = db.getDeveloperByGitHub('pmariglia')!;
      expect(dev.smogon_id).toBe(535629);
      expect(dev.smogon_username).toBe('pmariglia_renamed');
      expect(dev.github_id).toBe(4242);
      expect(dev.discord_id).toBe('283674461268344832');
      expect(dev.discord_username).toBe('pmariglia');

      expect(db.getDeveloperByGitHub('coauthor')).toBeUndefined();
      expect(db.getDevelopersForBot(fp.id).map(d => d.github_login)).toEqual([
        'pmariglia',
        'thirddev',
      ]);

      const disabledMm = db.getBotById(mm.id)!;
      expect(disabledMm.status).toBe('disabled');
      expect(db.getDeveloperByGitHub('jakegrigsby')).toBeUndefined();

      db.unlinkDeveloperDiscord('pmariglia', 1_760_000_300);
      expect(db.getDeveloperByGitHub('pmariglia')!.discord_id).toBeNull();
    } finally {
      db.close();
    }
  });

  test('syncs and checks Discord guild membership', () => {
    const db = new ArenaDB(':memory:');
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
