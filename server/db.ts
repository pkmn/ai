import * as crypto from 'crypto';
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

export const DB_PATH = process.env.ARENA_DB_PATH ?? (
  process.env.NODE_ENV === 'production' || fs.existsSync('/var/lib/pkmn')
    ? '/var/lib/pkmn/arena.sqlite'
    : root('private', 'arena.sqlite')
);
export const SCHEMA_DIR = root('db', 'schema');
export const MIGRATION_DIR = root('db', 'migration');
export const LADDERS_FILE = root('config', 'ladders.yml');
export const PROJECTS_FILE = root('static', 'projects.yml');
export const AVATARS_DIR = root('static', 'avatars');

export type LadderSlot = 'rby' | 'adv' | 'sv' | 'rand' | 'vgc';
export type TeamMode = 'harvested' | 'random' | 'competitor_pool';
export type LadderStatus = 'upcoming' | 'active' | 'settling' | 'archived';
export type BotStatus = 'pending' | 'qualified' | 'disabled';
export type FormatType = 'bundle' | 'oci';
export type SmokeStatus = 'pending_pull' | 'passed' | 'failed_smoke_test' | 'quarantined';
export type AccountStatusLabel = 'Pending' | 'Qualified' | 'Eligible' | 'Ineligible';

export const COOLDOWN_S = 14 * 24 * 60 * 60;
export const SETTLED_MAX_SE = 30;
export const SETTLED_MIN_MATCHES = 25;

const SLOTS = new Set<LadderSlot>(['rby', 'adv', 'sv', 'rand', 'vgc']);
const TEAM_MODES = new Set<TeamMode>(['harvested', 'random', 'competitor_pool']);
const LADDER_STATUSES = new Set<LadderStatus>(['upcoming', 'active', 'settling', 'archived']);
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
  team_count?: number;
  status?: LadderStatus;
  pool_dirs?: string[];
}

export interface LadderRow {
  id: string;
  slot: LadderSlot;
  display_name: string;
  format_id: string;
  team_mode: TeamMode;
  min_bots: number;
  team_count: number | null;
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

export interface BotVersionRow {
  id: number;
  bot_id: number;
  submitted_by_dev_id: number | null;
  version_str: string;
  format_type: FormatType;
  download_url: string;
  sha256: string;
  auth_token_enc: string | null;
  ladders_json: string;
  unpacked_bytes: number | null;
  smoke_status: SmokeStatus;
  smoke_duration_ms: number | null;
  smoke_turn_ms: number | null;
  smoke_peak_ram_mb: number | null;
  smoke_error_log: string | null;
  dm_sent: number;
  created_at: number;
}

export interface ActiveEntryView {
  ladder_id: string;
  slot: LadderSlot;
  display_name: string;
  version_id: number;
  version_str: string;
  role: 'champion' | 'challenger';
  rating_elo: number;
  rating_se: number;
  rank_current: number | null;
  matches_played: number;
  ww: number;
  wt: number;
  split: number;
  tl: number;
  ll: number;
  settled_at: number | null;
}

export interface VersionHistoryView extends BotVersionRow {
  active_ladder_names: string[];
}

export interface SubmissionStatus {
  label: AccountStatusLabel;
  canSubmit: boolean;
  reason?: string;
  nextEligibleAt?: number;
}

export interface CreateSubmissionInput {
  botId: number;
  submittedByDevId: number | null;
  versionStr: string;
  formatType: FormatType;
  downloadUrl: string;
  sha256: string;
  authTokenEnc: string | null;
  ladderIds: string[];
  teamsByLadder?: Record<string, string[]>;
  now?: number;
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
  qualified: boolean;
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

    parsed.push({
      slug,
      name,
      logoFile,
      qualified: Boolean(entry.arena.qualified),
      owners,
    });
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
    if (teamMode === 'competitor_pool') {
      if (!Number.isInteger(entry.team_count) || entry.team_count! < 1) {
        throw new Error(`competitor_pool ladder "${id}" must specify a positive team_count`);
      }
    } else if (entry.team_count !== undefined) {
      throw new Error(`team_count is only valid on competitor_pool ladders ("${id}")`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate ladder id "${id}" in ladders.yml`);
    }
    seenIds.add(id);

    if (status === 'active' || status === 'upcoming') {
      const prev = activeSlots.get(slot);
      if (prev) {
        throw new Error(
          `Multiple current ladders configured for slot "${slot}": "${prev}" and "${id}"`
        );
      }
      activeSlots.set(slot, id);
    }
  }

  return entries;
}

export function loadLadderPoolDirs(file = LADDERS_FILE): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!fs.existsSync(file)) return out;
  const entries = parseLaddersYaml(fs.readFileSync(file, 'utf8'));
  for (const entry of entries) {
    if (Array.isArray(entry.pool_dirs) && entry.pool_dirs.length) {
      out.set(entry.id, entry.pool_dirs.map(p => root(p)));
    }
  }
  return out;
}

export function deduceFormatType(downloadUrl: string): FormatType {
  const cleanPath = downloadUrl.split('?')[0].toLowerCase();
  if (
    cleanPath.endsWith('.tar.gz') ||
    cleanPath.endsWith('.tgz') ||
    cleanPath.endsWith('.tar.xz') ||
    cleanPath.endsWith('.txz') ||
    cleanPath.endsWith('.tar.zst') ||
    cleanPath.endsWith('.tzst')
  ) {
    return 'bundle';
  }
  return 'oci';
}

function deriveSecretKey(secret: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', secret, '', 'pkmn-arena-auth-token-v1', 32)
  );
}

export function encryptSecret(plaintext: string, secret: string): string {
  const key = deriveSecretKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptSecret(encoded: string, secret: string): string {
  const parts = encoded.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted secret format');
  const key = deriveSecretKey(secret);
  const iv = Buffer.from(parts[0], 'base64url');
  const tag = Buffer.from(parts[1], 'base64url');
  const data = Buffer.from(parts[2], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
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
        id, slot, display_name, format_id, team_mode, min_bots,
        team_count, status, created_at, archived_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        slot = excluded.slot,
        display_name = excluded.display_name,
        format_id = excluded.format_id,
        team_mode = excluded.team_mode,
        min_bots = excluded.min_bots,
        team_count = excluded.team_count,
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
        const teamCount = cfg.team_count ?? null;
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
          teamCount,
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
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        logo_file = excluded.logo_file,
        status = excluded.status,
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
        const botStatus: BotStatus = proj.qualified ? 'qualified' : 'pending';
        upsertBot.run(proj.slug, proj.name, proj.logoFile, botStatus, now);
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
      qualified: proj.qualified,
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
        qualified: proj.qualified,
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

  getCurrentLadders(): LadderRow[] {
    return this.db.prepare(
      `SELECT * FROM ladders
       WHERE status IN ('upcoming', 'active')
       ORDER BY ${SLOT_ORDER_SQL} ASC, created_at ASC, id ASC`
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

  getDeveloperByDiscordId(discordId: string): DeveloperRow | undefined {
    return this.db.prepare('SELECT * FROM developers WHERE discord_id = ?')
      .get(discordId.trim()) as unknown as DeveloperRow | undefined;
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
    const cleanDiscordId = discordId.trim();
    this.inTransaction(() => {
      const existing = this.getDeveloperByDiscordId(cleanDiscordId);
      if (existing && existing.github_login !== cleanLogin) {
        throw new Error(
          `Discord account @${discordUsername} is already linked to another developer`
        );
      }

      this.db.prepare(
        `UPDATE developers
         SET discord_id = ?, discord_username = ?, updated_at = ?
         WHERE github_login = ?`
      ).run(cleanDiscordId, discordUsername, now, cleanLogin);
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

  hasActiveLadderTeams(ladderId: string, botId: number): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM bot_ladder_teams
       WHERE ladder_id = ? AND bot_id = ? AND status = 'active'
       LIMIT 1`
    ).get(ladderId, botId);
    return row !== undefined;
  }

  getTeamsForBotLadder(
    ladderId: string,
    botId: number,
    status?: 'pending' | 'active'
  ): string[] {
    const rows = status
      ? this.db.prepare(
        `SELECT canonical_packed FROM bot_ladder_teams
         WHERE ladder_id = ? AND bot_id = ? AND status = ?
         ORDER BY slot_index ASC`
      ).all(ladderId, botId, status)
      : this.db.prepare(
        `SELECT canonical_packed FROM bot_ladder_teams
         WHERE ladder_id = ? AND bot_id = ?
         ORDER BY slot_index ASC`
      ).all(ladderId, botId);
    return (rows as Array<{canonical_packed: string}>).map(r => r.canonical_packed);
  }

  getActiveEntriesForBot(botId: number): ActiveEntryView[] {
    return this.db.prepare(`
      SELECT
        le.ladder_id,
        l.slot,
        l.display_name,
        le.version_id,
        bv.version_str,
        le.role,
        le.rating_elo,
        le.rating_se,
        le.rank_current,
        le.matches_played,
        le.ww,
        le.wt,
        le.split,
        le.tl,
        le.ll,
        le.settled_at
      FROM ladder_entries le
      JOIN bot_versions bv ON bv.id = le.version_id
      JOIN ladders l ON l.id = le.ladder_id
      WHERE bv.bot_id = ?
        AND bv.smoke_status = 'passed'
        AND le.role IN ('champion', 'challenger')
        AND l.status IN ('active', 'settling')
      ORDER BY
        CASE l.slot
          WHEN 'rby' THEN 0
          WHEN 'adv' THEN 1
          WHEN 'sv' THEN 2
          WHEN 'rand' THEN 3
          WHEN 'vgc' THEN 4
          ELSE 5
        END ASC,
        CASE le.role WHEN 'champion' THEN 0 ELSE 1 END ASC,
        le.rating_elo DESC
    `).all(botId) as unknown as ActiveEntryView[];
  }

  getVersionsForBot(botId: number): VersionHistoryView[] {
    const versions = this.db.prepare(
      'SELECT * FROM bot_versions WHERE bot_id = ? ORDER BY created_at DESC, id DESC'
    ).all(botId) as unknown as BotVersionRow[];

    const activeRows = this.db.prepare(`
      SELECT le.version_id, l.display_name
      FROM ladder_entries le
      JOIN bot_versions bv ON bv.id = le.version_id
      JOIN ladders l ON l.id = le.ladder_id
      WHERE bv.bot_id = ?
        AND le.role IN ('champion', 'challenger')
        AND l.status IN ('active', 'settling')
      ORDER BY
        CASE l.slot
          WHEN 'rby' THEN 0
          WHEN 'adv' THEN 1
          WHEN 'sv' THEN 2
          WHEN 'rand' THEN 3
          WHEN 'vgc' THEN 4
          ELSE 5
        END ASC
    `).all(botId) as Array<{version_id: number; display_name: string}>;

    const activeByVersion = new Map<number, string[]>();
    for (const r of activeRows) {
      const list = activeByVersion.get(r.version_id) ?? [];
      list.push(r.display_name);
      activeByVersion.set(r.version_id, list);
    }

    return versions.map(v => ({
      ...v,
      active_ladder_names: activeByVersion.get(v.id) ?? [],
    }));
  }

  hasAnyLeaderboardEntry(botId: number): boolean {
    const row = this.db.prepare(`
      SELECT 1
      FROM ladder_entries le
      JOIN bot_versions bv ON bv.id = le.version_id
      WHERE bv.bot_id = ?
      LIMIT 1
    `).get(botId);
    return row !== undefined;
  }

  computeBotSubmissionStatus(
    botId: number,
    now = Math.floor(Date.now() / 1000)
  ): SubmissionStatus {
    const bot = this.getBotById(botId);
    if (!bot || bot.status === 'disabled') {
      return {
        label: 'Ineligible',
        canSubmit: false,
        reason: 'Project is disabled.',
      };
    }

    if (bot.status === 'pending') {
      return {
        label: 'Pending',
        canSubmit: false,
        reason: 'Project qualification is pending staff review.',
      };
    }

    const openLadders = this.getActiveLadders();
    if (!openLadders.length) {
      return {
        label: 'Qualified',
        canSubmit: false,
        reason: 'Ladders are not open for submissions yet.',
      };
    }

    const pendingRow = this.db.prepare(
      `SELECT version_str FROM bot_versions
       WHERE bot_id = ? AND smoke_status = 'pending_pull'
       LIMIT 1`
    ).get(botId) as {version_str: string} | undefined;
    if (pendingRow) {
      return {
        label: 'Ineligible',
        canSubmit: false,
        reason: `Version ${pendingRow.version_str} is currently awaiting Arena smoke testing.`,
      };
    }

    const refundedAt = bot.cooldown_refunded_at ?? 0;
    const latestPassed = this.db.prepare(
      `SELECT created_at, version_str FROM bot_versions
       WHERE bot_id = ? AND smoke_status = 'passed' AND created_at > ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    ).get(botId, refundedAt) as {created_at: number; version_str: string} | undefined;

    if (latestPassed) {
      const nextEligibleAt = latestPassed.created_at + COOLDOWN_S;
      if (now < nextEligibleAt) {
        const daysLeft = Math.ceil((nextEligibleAt - now) / 86400);
        return {
          label: 'Ineligible',
          canSubmit: false,
          reason:
            `14-day cooldown active (${daysLeft}d remaining after ${latestPassed.version_str}).`,
          nextEligibleAt,
        };
      }
    }

    const activeEntries = this.getActiveEntriesForBot(botId);
    for (const entry of activeEntries) {
      const settled = entry.settled_at !== null || (
        entry.rating_se <= SETTLED_MAX_SE && entry.matches_played >= SETTLED_MIN_MATCHES
      );
      if (!settled) {
        return {
          label: 'Ineligible',
          canSubmit: false,
          reason:
            `Active version ${entry.version_str} on ${entry.display_name} has not settled ` +
            `(SE=${entry.rating_se.toFixed(1)}, ` +
            `matches=${entry.matches_played}/${SETTLED_MIN_MATCHES}).`,
        };
      }
    }

    return {
      label: 'Eligible',
      canSubmit: true,
    };
  }

  createSubmission(input: CreateSubmissionInput): BotVersionRow {
    const now = input.now ?? Math.floor(Date.now() / 1000);
    return this.inTransaction(() => {
      const existing = this.db.prepare(
        'SELECT id FROM bot_versions WHERE bot_id = ? AND version_str = ?'
      ).get(input.botId, input.versionStr) as {id: number} | undefined;
      if (existing) {
        throw Object.assign(
          new Error(`Version "${input.versionStr}" already exists for this project.`),
          {status: 409}
        );
      }

      const status = this.computeBotSubmissionStatus(input.botId, now);
      if (!status.canSubmit) {
        const code = status.label === 'Pending' || status.label === 'Qualified' ? 403 : 429;
        throw Object.assign(
          new Error(status.reason ?? 'Project is not currently eligible to submit.'),
          {status: code}
        );
      }

      const insertVersion = this.db.prepare(`
        INSERT INTO bot_versions (
          bot_id, submitted_by_dev_id, version_str, format_type, download_url,
          sha256, auth_token_enc, ladders_json, smoke_status, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_pull', ?)
      `);
      const res = insertVersion.run(
        input.botId,
        input.submittedByDevId,
        input.versionStr,
        input.formatType,
        input.downloadUrl,
        input.sha256,
        input.authTokenEnc,
        JSON.stringify(input.ladderIds),
        now
      );
      const versionId = Number(res.lastInsertRowid);

      if (input.teamsByLadder) {
        const clearPending = this.db.prepare(
          `DELETE FROM bot_ladder_teams
           WHERE ladder_id = ? AND bot_id = ? AND status = 'pending'`
        );
        const insertTeam = this.db.prepare(`
          INSERT INTO bot_ladder_teams (
            ladder_id, bot_id, slot_index, canonical_packed, status, created_at
          )
          VALUES (?, ?, ?, ?, 'pending', ?)
        `);
        for (const [ladderId, packedTeams] of Object.entries(input.teamsByLadder)) {
          clearPending.run(ladderId, input.botId);
          for (let i = 0; i < packedTeams.length; i++) {
            insertTeam.run(ladderId, input.botId, i, packedTeams[i], now);
          }
        }
      }

      return this.db.prepare('SELECT * FROM bot_versions WHERE id = ?')
        .get(versionId) as unknown as BotVersionRow;
    });
  }
}
