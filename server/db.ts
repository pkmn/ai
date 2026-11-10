import * as fs from 'fs';
import {DatabaseSync} from 'node:sqlite';
import * as path from 'path';

import * as yaml from 'yaml';

import type {Project} from '../static/projects';
import {root, slugify} from '../static/util';

import {
  type SmogonUser,
  lookupSmogonUser,
  parseSmogonIdentifier,
} from './smogon';

export const DB_PATH = process.env.ARENA_DB_PATH ?? '/var/lib/pkmn/arena.sqlite';
export const SCHEMA_DIR = root('db', 'schema');
export const MIGRATION_DIR = root('db', 'migration');
export const LADDERS_FILE = root('config', 'ladders.yml');
export const PROJECTS_FILE = root('static', 'projects.yml');
export const AVATARS_DIR = root('static', 'avatars');

export type LadderSlot = 'rby' | 'adv' | 'sv' | 'rand' | 'vgc';
export type TeamMode = 'harvested' | 'random' | 'competitor_pool';
export type LadderStatus = 'active' | 'settling' | 'archived';
export type BotStatus = 'approved' | 'disabled';

const SLOTS = new Set<LadderSlot>(['rby', 'adv', 'sv', 'rand', 'vgc']);
const TEAM_MODES = new Set<TeamMode>(['harvested', 'random', 'competitor_pool']);
const LADDER_STATUSES = new Set<LadderStatus>(['active', 'settling', 'archived']);
const MIGRATION_FILE_RE = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface ArenaDBOptions {
  schemaDir?: string;
  migrationDir?: string;
  backupBeforeMigrate?: boolean;
  now?: number;
}

export interface SyncProjectsOptions {
  avatarsDir?: string;
  smogonToken?: string;
  lookupSmogon?: (raw: string | number, token?: string) => Promise<SmogonUser>;
  refreshSmogonNames?: boolean;
  now?: number;
}

export interface LadderConfig {
  id: string;
  slot: LadderSlot;
  display_name: string;
  format_id: string;
  team_mode: TeamMode;
  min_bots?: number;
  status?: LadderStatus;
}

export interface LadderRow {
  id: string;
  slot: LadderSlot;
  display_name: string;
  format_id: string;
  team_mode: TeamMode;
  min_bots: number;
  status: LadderStatus;
  created_at: number;
  archived_at: number | null;
}

export interface BotRow {
  id: number;
  slug: string;
  name: string;
  logo_file: string | null;
  status: BotStatus;
  cooldown_refunded_at: number | null;
  updated_at: number;
}

export interface DeveloperRow {
  id: number;
  bot_id: number;
  github_login: string;
  github_id: number | null;
  smogon_id: number;
  smogon_username: string;
  discord_id: string | null;
  discord_username: string | null;
  updated_at: number;
}

export interface RawProjectOwner {
  github: string;
  rawSmogon: string | number;
  smogonId?: number;
  smogonUsername?: string;
}

export interface ResolvedProjectOwner {
  github: string;
  smogonId: number;
  smogonUsername: string;
}

export interface ParsedArenaProject<Owner = RawProjectOwner> {
  slug: string;
  name: string;
  logoFile: string | null;
  owners: Owner[];
}

export function extractProjectOwners(
  arena: NonNullable<Project['arena']>
): RawProjectOwner[] {
  const out: RawProjectOwner[] = [];
  const seen = new Set<string>();

  if (!arena.owners || typeof arena.owners !== 'object' || Array.isArray(arena.owners)) {
    return out;
  }
  for (const [ghRaw, smogonRaw] of Object.entries(arena.owners)) {
    const github = ghRaw.trim().toLowerCase();
    if (!github || smogonRaw === undefined || smogonRaw === null || smogonRaw === '') {
      throw new Error(`Invalid owner mapping "${ghRaw}: ${String(smogonRaw)}"`);
    }
    if (seen.has(github)) continue;
    seen.add(github);
    const parsed = parseSmogonIdentifier(smogonRaw);
    out.push({
      github,
      rawSmogon: smogonRaw,
      smogonId: parsed.id,
      smogonUsername: parsed.username,
    });
  }
  return out;
}

export function parseArenaProjects(
  projectsYaml: string,
  avatarsDir = AVATARS_DIR
): ParsedArenaProject[] {
  const entries = (yaml.parse(projectsYaml) ?? []) as Project[];
  if (!Array.isArray(entries)) {
    throw new Error('projects.yml must parse to a YAML array');
  }

  const seenSlugs = new Set<string>();
  const githubOwner = new Map<string, string>();
  const smogonIdOwner = new Map<number, string>();
  const smogonNameOwner = new Map<string, string>();
  const parsed: ParsedArenaProject[] = [];

  for (const entry of entries) {
    if (!entry?.arena) continue;
    const name = entry.name?.trim();
    if (!name) {
      throw new Error('Arena project entry is missing required "name"');
    }
    const slug = slugify(name).toLowerCase();
    if (!slug) {
      throw new Error(`Invalid arena project slug derived from "${name}"`);
    }
    if (seenSlugs.has(slug)) {
      throw new Error(`Duplicate arena project slug "${slug}" ("${name}")`);
    }
    seenSlugs.add(slug);

    const owners = extractProjectOwners(entry.arena);
    if (!owners.length) {
      throw new Error(`Arena project "${name}" must list at least one owner`);
    }

    for (const owner of owners) {
      const prevGh = githubOwner.get(owner.github);
      if (prevGh) {
        throw new Error(
          `GitHub owner "${owner.github}" is assigned to both "${prevGh}" and "${name}"`
        );
      }
      githubOwner.set(owner.github, name);

      if (owner.smogonId !== undefined) {
        const prevId = smogonIdOwner.get(owner.smogonId);
        if (prevId) {
          throw new Error(
            `Smogon ID ${owner.smogonId} is assigned to both "${prevId}" and "${name}"`
          );
        }
        smogonIdOwner.set(owner.smogonId, name);
      } else if (owner.smogonUsername) {
        const key = owner.smogonUsername.toLowerCase();
        const prevName = smogonNameOwner.get(key);
        if (prevName) {
          throw new Error(
            `Smogon account "${owner.smogonUsername}" is assigned ` +
            `to both "${prevName}" and "${name}"`
          );
        }
        smogonNameOwner.set(key, name);
      }
    }

    let logoFile: string | null = null;
    if (entry.arena.logo?.trim()) {
      logoFile = entry.arena.logo.trim();
    } else if (avatarsDir && fs.existsSync(path.join(avatarsDir, `${slug}.png`))) {
      logoFile = `${slug}.png`;
    }

    parsed.push({slug, name, logoFile, owners});
  }

  return parsed;
}

function validateUniqueSmogonIds(projects: Array<ParsedArenaProject<ResolvedProjectOwner>>) {
  const smogonIdOwner = new Map<number, string>();
  for (const proj of projects) {
    for (const owner of proj.owners) {
      const prev = smogonIdOwner.get(owner.smogonId);
      if (prev) {
        throw new Error(
          `Smogon ID ${owner.smogonId} ("${owner.smogonUsername}") ` +
          `is assigned to both "${prev}" and "${proj.name}"`
        );
      }
      smogonIdOwner.set(owner.smogonId, proj.name);
    }
  }
}

export function parseLaddersYaml(laddersYaml: string): LadderConfig[] {
  const entries = (yaml.parse(laddersYaml) ?? []) as LadderConfig[];
  if (!Array.isArray(entries)) {
    throw new Error('ladders.yml must parse to a YAML array');
  }

  const seenIds = new Set<string>();
  const activeSlots = new Map<LadderSlot, string>();

  for (const entry of entries) {
    const id = entry?.id?.trim();
    const slot = entry?.slot;
    const displayName = entry?.display_name?.trim();
    const formatId = entry?.format_id?.trim();
    const teamMode = entry?.team_mode;
    const status = entry?.status ?? 'active';
    const minBots = entry?.min_bots ?? (teamMode === 'competitor_pool' ? 3 : 2);

    if (!id || !displayName || !formatId) {
      throw new Error(`Invalid ladder entry in ladders.yml: ${JSON.stringify(entry)}`);
    }
    if (!SLOTS.has(slot)) {
      throw new Error(`Invalid ladder slot "${String(slot)}" for "${id}"`);
    }
    if (!TEAM_MODES.has(teamMode)) {
      throw new Error(`Invalid team_mode "${String(teamMode)}" for "${id}"`);
    }
    if (!LADDER_STATUSES.has(status)) {
      throw new Error(`Invalid ladder status "${String(status)}" for "${id}"`);
    }
    if (!Number.isInteger(minBots) || minBots < 2) {
      throw new Error(`Invalid min_bots "${String(minBots)}" for "${id}"`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate ladder id "${id}" in ladders.yml`);
    }
    seenIds.add(id);

    if (status === 'active') {
      const prev = activeSlots.get(slot);
      if (prev) {
        throw new Error(
          `Multiple active ladders configured for slot "${slot}": "${prev}" and "${id}"`
        );
      }
      activeSlots.set(slot, id);
    }
  }

  return entries;
}

function listSqlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.sql') && !f.startsWith('.'))
    .sort((a, b) => a.localeCompare(b));
}

const SLOT_ORDER_SQL = `
  CASE slot
    WHEN 'rby' THEN 0
    WHEN 'adv' THEN 1
    WHEN 'sv' THEN 2
    WHEN 'rand' THEN 3
    WHEN 'vgc' THEN 4
    ELSE 5
  END
`;

export class ArenaDB {
  readonly db: DatabaseSync;
  readonly dbPath: string;

  constructor(dbPath = DB_PATH, options: ArenaDBOptions = {}) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), {recursive: true});
    }
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.initializeSchema(options);
  }

  private initializeSchema(options: ArenaDBOptions) {
    const schemaDir = options.schemaDir ?? SCHEMA_DIR;
    const migrationDir = options.migrationDir ?? MIGRATION_DIR;
    const now = options.now ?? Math.floor(Date.now() / 1000);

    const existingTables = this.db.prepare(
      `SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    ).get() as {count: number};
    const isFresh = existingTables.count === 0;

    const schemaFiles = listSqlFiles(schemaDir);
    if (!schemaFiles.length) {
      throw new Error(`No .sql schema files found in ${schemaDir}`);
    }

    const migrationFiles = listSqlFiles(migrationDir);
    const seenNumbers = new Set<string>();
    for (const file of migrationFiles) {
      if (!MIGRATION_FILE_RE.test(file)) {
        throw new Error(
          `Invalid migration filename "${file}" (expected NNNN_description.sql)`
        );
      }
      const prefix = file.slice(0, 4);
      if (seenNumbers.has(prefix)) {
        throw new Error(`Duplicate migration sequence prefix "${prefix}" in "${file}"`);
      }
      seenNumbers.add(prefix);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);

    if (isFresh) {
      this.inTransaction(() => {
        for (const file of schemaFiles) {
          const sql = fs.readFileSync(path.join(schemaDir, file), 'utf8');
          this.db.exec(sql);
        }
        const recordMigration = this.db.prepare(
          'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)'
        );
        for (const file of migrationFiles) {
          recordMigration.run(file, now);
        }
      });
      return;
    }

    const appliedRows = this.db.prepare('SELECT version FROM schema_migrations')
      .all() as Array<{version: string}>;
    const applied = new Set(appliedRows.map(r => r.version));
    const pending = migrationFiles.filter(f => !applied.has(f));
    if (!pending.length) return;

    const shouldBackup = options.backupBeforeMigrate ?? (this.dbPath !== ':memory:');
    if (shouldBackup && this.dbPath !== ':memory:') {
      const tag = pending[0].replace(/\.sql$/, '');
      const backupPath = `${this.dbPath}.pre-${tag}.bak`;
      if (!fs.existsSync(backupPath)) {
        const escaped = backupPath.replace(/'/g, "''");
        this.db.exec(`VACUUM INTO '${escaped}';`);
      }
    }

    const recordMigration = this.db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
    );

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
      this.db.exec('PRAGMA foreign_keys = OFF;');
      try {
        this.inTransaction(() => {
          this.db.exec(sql);
          const fkErrors = this.db.prepare('PRAGMA foreign_key_check').all();
          if (fkErrors.length > 0) {
            throw new Error(
              `Foreign key check failed in migration "${file}": ${JSON.stringify(fkErrors)}`
            );
          }
          recordMigration.run(file, now);
        });
      } finally {
        this.db.exec('PRAGMA foreign_keys = ON;');
      }
    }
  }

  getAppliedMigrations(): Array<{version: string; applied_at: number}> {
    return this.db.prepare(
      'SELECT version, applied_at FROM schema_migrations ORDER BY version ASC'
    ).all() as unknown as Array<{version: string; applied_at: number}>;
  }

  close() {
    this.db.close();
  }

  inTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  syncLaddersFromYaml(laddersYaml: string, now = Math.floor(Date.now() / 1000)) {
    const configs = parseLaddersYaml(laddersYaml);
    const selectExisting = this.db.prepare(
      'SELECT status, archived_at FROM ladders WHERE id = ?'
    );
    const upsert = this.db.prepare(`
      INSERT INTO ladders (
        id, slot, display_name, format_id, team_mode, min_bots, status, created_at, archived_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        slot = excluded.slot,
        display_name = excluded.display_name,
        format_id = excluded.format_id,
        team_mode = excluded.team_mode,
        min_bots = excluded.min_bots,
        status = excluded.status,
        archived_at = excluded.archived_at
    `);

    this.inTransaction(() => {
      for (const cfg of configs) {
        const existing = selectExisting.get(cfg.id) as {
          status: LadderStatus;
          archived_at: number | null;
        } | undefined;
        let status: LadderStatus = cfg.status ?? 'active';
        if (existing?.status === 'archived' && status === 'settling') {
          status = 'archived';
        }
        const minBots = cfg.min_bots ?? (cfg.team_mode === 'competitor_pool' ? 3 : 2);
        const archivedAt = status === 'archived'
          ? (existing?.archived_at ?? now)
          : null;
        upsert.run(
          cfg.id,
          cfg.slot,
          cfg.display_name.trim(),
          cfg.format_id.trim(),
          cfg.team_mode,
          minBots,
          status,
          now,
          archivedAt
        );
      }
    });
  }

  syncLadders(file = LADDERS_FILE, now = Math.floor(Date.now() / 1000)) {
    if (!fs.existsSync(file)) return;
    this.syncLaddersFromYaml(fs.readFileSync(file, 'utf8'), now);
  }

  private applyResolvedProjects(
    projects: Array<ParsedArenaProject<ResolvedProjectOwner>>,
    now: number
  ) {
    validateUniqueSmogonIds(projects);

    const upsertBot = this.db.prepare(`
      INSERT INTO bots (slug, name, logo_file, status, updated_at)
      VALUES (?, ?, ?, 'approved', ?)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        logo_file = excluded.logo_file,
        status = 'approved',
        updated_at = excluded.updated_at
    `);
    const selectBotId = this.db.prepare('SELECT id FROM bots WHERE slug = ?');
    const selectAllBots = this.db.prepare('SELECT id, slug FROM bots');
    const disableBot = this.db.prepare(
      "UPDATE bots SET status = 'disabled', updated_at = ? WHERE id = ?"
    );
    const deleteRemovedDevsForBot = this.db.prepare(
      'DELETE FROM developers WHERE bot_id = ?'
    );
    const selectExistingDev = this.db.prepare(
      'SELECT id FROM developers WHERE github_login = ?'
    );
    const updateDev = this.db.prepare(`
      UPDATE developers
      SET bot_id = ?, smogon_id = ?, smogon_username = ?, updated_at = ?
      WHERE id = ?
    `);
    const insertDev = this.db.prepare(`
      INSERT INTO developers (bot_id, github_login, smogon_id, smogon_username, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const selectAllDevs = this.db.prepare('SELECT id, github_login FROM developers');
    const deleteDevById = this.db.prepare('DELETE FROM developers WHERE id = ?');

    this.inTransaction(() => {
      const activeSlugs = new Set<string>();
      const activeGitHubs = new Set<string>();

      for (const proj of projects) {
        activeSlugs.add(proj.slug);
        for (const owner of proj.owners) activeGitHubs.add(owner.github);
      }

      const allDevs = selectAllDevs.all() as Array<{id: number; github_login: string}>;
      for (const dev of allDevs) {
        if (!activeGitHubs.has(dev.github_login)) {
          deleteDevById.run(dev.id);
        }
      }

      for (const proj of projects) {
        upsertBot.run(proj.slug, proj.name, proj.logoFile, now);
        const bot = selectBotId.get(proj.slug) as {id: number};

        for (const owner of proj.owners) {
          const existing = selectExistingDev.get(owner.github) as {id: number} | undefined;
          if (existing) {
            updateDev.run(
              bot.id,
              owner.smogonId,
              owner.smogonUsername,
              now,
              existing.id
            );
          } else {
            insertDev.run(
              bot.id,
              owner.github,
              owner.smogonId,
              owner.smogonUsername,
              now
            );
          }
        }
      }

      const allBots = selectAllBots.all() as Array<{id: number; slug: string}>;
      for (const bot of allBots) {
        if (!activeSlugs.has(bot.slug)) {
          disableBot.run(now, bot.id);
          deleteRemovedDevsForBot.run(bot.id);
        }
      }
    });
  }

  syncProjectsFromYaml(
    projectsYaml: string,
    avatarsDir = AVATARS_DIR,
    now = Math.floor(Date.now() / 1000)
  ) {
    const rawProjects = parseArenaProjects(projectsYaml, avatarsDir);
    const resolved: Array<ParsedArenaProject<ResolvedProjectOwner>> = rawProjects.map(proj => ({
      slug: proj.slug,
      name: proj.name,
      logoFile: proj.logoFile,
      owners: proj.owners.map(owner => {
        if (owner.smogonId !== undefined) {
          const existing = this.getDeveloperByGitHub(owner.github);
          const smogonUsername = owner.smogonUsername ??
            (existing?.smogon_id === owner.smogonId ? existing.smogon_username : undefined) ??
            String(owner.smogonId);
          return {github: owner.github, smogonId: owner.smogonId, smogonUsername};
        }

        const existing = this.getDeveloperByGitHub(owner.github);
        if (existing) {
          return {
            github: owner.github,
            smogonId: existing.smogon_id,
            smogonUsername: existing.smogon_username,
          };
        }

        throw new Error(
          `Smogon account "${String(owner.rawSmogon)}" for GitHub owner "${owner.github}" ` +
          'has no numerical ID; pass <name>.<id> / <id> or use syncProjectsWithSmogon()'
        );
      }),
    }));

    this.applyResolvedProjects(resolved, now);
  }

  syncProjects(
    file = PROJECTS_FILE,
    avatarsDir = AVATARS_DIR,
    now = Math.floor(Date.now() / 1000)
  ) {
    if (!fs.existsSync(file)) return;
    this.syncProjectsFromYaml(fs.readFileSync(file, 'utf8'), avatarsDir, now);
  }

  async syncProjectsFromYamlWithSmogon(
    projectsYaml: string,
    options: SyncProjectsOptions = {}
  ) {
    const avatarsDir = options.avatarsDir ?? AVATARS_DIR;
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const smogonToken = options.smogonToken ?? process.env.SMOGON_TOKEN;
    const lookup = options.lookupSmogon ?? lookupSmogonUser;
    const refreshNames = options.refreshSmogonNames ?? Boolean(smogonToken || options.lookupSmogon);

    const rawProjects = parseArenaProjects(projectsYaml, avatarsDir);
    const resolved: Array<ParsedArenaProject<ResolvedProjectOwner>> = [];

    for (const proj of rawProjects) {
      const owners: ResolvedProjectOwner[] = [];
      for (const owner of proj.owners) {
        const existing = this.getDeveloperByGitHub(owner.github);

        if (owner.smogonId !== undefined) {
          if (refreshNames && (smogonToken || options.lookupSmogon)) {
            const profile = await lookup(owner.smogonId, smogonToken);
            if (profile.banned) {
              throw new Error(
                `Smogon account "${profile.username}" (${profile.id}) is banned`
              );
            }
            owners.push({
              github: owner.github,
              smogonId: profile.id,
              smogonUsername: profile.username,
            });
          } else {
            const smogonUsername = owner.smogonUsername ??
              (existing?.smogon_id === owner.smogonId ? existing.smogon_username : undefined) ??
              String(owner.smogonId);
            owners.push({github: owner.github, smogonId: owner.smogonId, smogonUsername});
          }
          continue;
        }

        // Bare username in projects.yml: if already synced in DB, prefer looking up by stored
        // numerical smogon_id so a Smogon forum username change never breaks resolution!
        if (existing && refreshNames && (smogonToken || options.lookupSmogon)) {
          const profile = await lookup(existing.smogon_id, smogonToken);
          if (profile.banned) {
            throw new Error(
              `Smogon account "${profile.username}" (${profile.id}) is banned`
            );
          }
          owners.push({
            github: owner.github,
            smogonId: profile.id,
            smogonUsername: profile.username,
          });
          continue;
        }

        if (existing && !smogonToken && !options.lookupSmogon) {
          owners.push({
            github: owner.github,
            smogonId: existing.smogon_id,
            smogonUsername: existing.smogon_username,
          });
          continue;
        }

        const profile = await lookup(owner.rawSmogon, smogonToken);
        if (profile.banned) {
          throw new Error(
            `Smogon account "${profile.username}" (${profile.id}) is banned`
          );
        }
        owners.push({
          github: owner.github,
          smogonId: profile.id,
          smogonUsername: profile.username,
        });
      }

      resolved.push({
        slug: proj.slug,
        name: proj.name,
        logoFile: proj.logoFile,
        owners,
      });
    }

    this.applyResolvedProjects(resolved, now);
  }

  async syncProjectsWithSmogon(
    file = PROJECTS_FILE,
    options: SyncProjectsOptions = {}
  ) {
    if (!fs.existsSync(file)) return;
    await this.syncProjectsFromYamlWithSmogon(fs.readFileSync(file, 'utf8'), options);
  }

  getLadders(): LadderRow[] {
    return this.db.prepare(
      `SELECT * FROM ladders ORDER BY ${SLOT_ORDER_SQL} ASC, created_at ASC, id ASC`
    ).all() as unknown as LadderRow[];
  }

  getActiveLadders(): LadderRow[] {
    return this.db.prepare(
      `SELECT * FROM ladders
       WHERE status = 'active'
       ORDER BY ${SLOT_ORDER_SQL} ASC, created_at ASC, id ASC`
    ).all() as unknown as LadderRow[];
  }

  getLadder(id: string): LadderRow | undefined {
    return this.db.prepare('SELECT * FROM ladders WHERE id = ?')
      .get(id) as unknown as LadderRow | undefined;
  }

  getActiveLadderBySlot(slot: LadderSlot): LadderRow | undefined {
    return this.db.prepare("SELECT * FROM ladders WHERE slot = ? AND status = 'active'")
      .get(slot) as unknown as LadderRow | undefined;
  }

  getBotBySlug(slug: string): BotRow | undefined {
    return this.db.prepare('SELECT * FROM bots WHERE slug = ?')
      .get(slug.toLowerCase()) as unknown as BotRow | undefined;
  }

  getBotById(id: number): BotRow | undefined {
    return this.db.prepare('SELECT * FROM bots WHERE id = ?')
      .get(id) as unknown as BotRow | undefined;
  }

  getDeveloperByGitHub(githubLogin: string): DeveloperRow | undefined {
    return this.db.prepare('SELECT * FROM developers WHERE github_login = ?')
      .get(githubLogin.trim().toLowerCase()) as unknown as DeveloperRow | undefined;
  }

  getDevelopersForBot(botId: number): DeveloperRow[] {
    return this.db.prepare(
      'SELECT * FROM developers WHERE bot_id = ? ORDER BY github_login ASC'
    ).all(botId) as unknown as DeveloperRow[];
  }

  linkDeveloperGitHubId(
    githubLogin: string,
    githubId: number,
    now = Math.floor(Date.now() / 1000)
  ) {
    this.db.prepare(
      'UPDATE developers SET github_id = ?, updated_at = ? WHERE github_login = ?'
    ).run(githubId, now, githubLogin.trim().toLowerCase());
  }

  linkDeveloperDiscord(
    githubLogin: string,
    discordId: string,
    discordUsername: string,
    now = Math.floor(Date.now() / 1000)
  ) {
    const cleanLogin = githubLogin.trim().toLowerCase();
    this.inTransaction(() => {
      this.db.prepare(
        `UPDATE developers
         SET discord_id = NULL, discord_username = NULL, updated_at = ?
         WHERE discord_id = ? AND github_login != ?`
      ).run(now, discordId, cleanLogin);

      this.db.prepare(
        `UPDATE developers
         SET discord_id = ?, discord_username = ?, updated_at = ?
         WHERE github_login = ?`
      ).run(discordId, discordUsername, now, cleanLogin);
    });
  }

  unlinkDeveloperDiscord(githubLogin: string, now = Math.floor(Date.now() / 1000)) {
    this.db.prepare(
      `UPDATE developers
       SET discord_id = NULL, discord_username = NULL, updated_at = ?
       WHERE github_login = ?`
    ).run(now, githubLogin.trim().toLowerCase());
  }

  syncDiscordMembers(
    members: Iterable<{id: string; username: string}>,
    now = Math.floor(Date.now() / 1000)
  ) {
    const clear = this.db.prepare('DELETE FROM discord_members');
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO discord_members (discord_id, username, updated_at) VALUES (?, ?, ?)'
    );
    this.inTransaction(() => {
      clear.run();
      for (const m of members) {
        insert.run(m.id, m.username, now);
      }
    });
  }

  isDiscordMember(discordId: string | undefined): boolean {
    if (!discordId) return false;
    const row = this.db.prepare('SELECT 1 FROM discord_members WHERE discord_id = ?')
      .get(discordId);
    return row !== undefined;
  }
}
