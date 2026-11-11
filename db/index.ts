import * as fs from 'fs';
import {DatabaseSync} from 'node:sqlite';
import * as path from 'path';

import type {RatingResult} from '../server/ratings';
import {root} from '../static/util';

import {
  type BotLadderTeamRow,
  type TeamPoolStatus,
  getTeamsForBotLadder,
  hasActiveLadderTeams,
} from './bot_ladder_teams';
import {
  type AccountStatusLabel,
  type ApplySubmissionStatusInput,
  type ApplySubmissionStatusResult,
  type BotVersionRow,
  COOLDOWN_S,
  type CreateSubmissionInput,
  type FormatType,
  type PendingSubmissionRow,
  SETTLED_MAX_SE,
  SETTLED_MIN_MATCHES,
  type SmokeStatus,
  type SubmissionStatus,
  type VersionHistoryView,
  applySubmissionStatus,
  computeBotSubmissionStatus,
  createSubmission,
  getPendingSubmissions,
  getVersionById,
  getVersionBySlugAndStr,
  getVersionsForBot,
  quarantineVersion,
  unquarantineVersion,
} from './bot_versions';
import {
  AVATARS_DIR,
  type BotRow,
  type BotStatus,
  PROJECTS_FILE,
  type ParsedArenaProject,
  type RawProjectOwner,
  type SyncProjectsOptions,
  extractProjectOwners,
  getBotById,
  getBotBySlug,
  parseArenaProjects,
  refundCooldown,
  syncProjects,
  syncProjectsFromYaml,
  syncProjectsFromYamlWithSmogon,
  syncProjectsWithSmogon,
} from './bots';
import {
  type DeveloperRow,
  type ResolvedProjectOwner,
  getDeveloperByDiscordId,
  getDeveloperByGitHub,
  getDevelopersForBot,
  linkDeveloperDiscord,
  linkDeveloperGitHubId,
  unlinkDeveloperDiscord,
} from './developers';
import {type DiscordMemberRow, isDiscordMember, syncDiscordMembers} from './discord_members';
import {
  type ActiveEntryView,
  type EntryRole,
  type LadderStandingOverride,
  type LeaderboardEntryView,
  type ProjectArenaLadderBadge,
  type ProjectArenaSummary,
  getActiveEntriesForBot,
  getLeaderboardEntries,
  getProjectArenaSummaries,
  hasAnyLeaderboardEntry,
  recomputeLadderRatings,
  setLadderAnchor,
} from './ladder_entries';
import {
  LADDERS_FILE,
  type LadderConfig,
  type LadderRow,
  type LadderSlot,
  type LadderStatus,
  type RotateLadderInput,
  type TeamMode,
  getActiveLadderBySlot,
  getActiveLadders,
  getCurrentLadders,
  getLadder,
  getLadders,
  getPlayableLadders,
  loadLadderPoolDirs,
  parseLaddersYaml,
  rotateLadder,
  setLadderStatus,
  syncLadders,
  syncLaddersFromYaml,
} from './ladders';
import {
  type CompletedMatchPayload,
  type RecentMatchView,
  type RecordMatchInput,
  getRecentMatches,
  recordCompletedMatch,
} from './matches';
import {type PairAggregateRow, getPairAggregatesForLadder} from './pair_aggregates';
import {
  type LadderSnapshotHistoryRow,
  type RatingSnapshotRow,
  getRatingSnapshotsForLadder,
} from './rating_snapshots';

export type TransactionRunner = <T>(fn: () => T) => T;

export interface ArenaDBOptions {
  schemaDir?: string;
  migrationDir?: string;
  backupBeforeMigrate?: boolean;
  now?: number;
}

export {
  type AccountStatusLabel,
  type ActiveEntryView,
  type ApplySubmissionStatusInput,
  type ApplySubmissionStatusResult,
  AVATARS_DIR,
  type BotLadderTeamRow,
  type BotRow,
  type BotStatus,
  type BotVersionRow,
  COOLDOWN_S,
  type CompletedMatchPayload,
  type CreateSubmissionInput,
  type DeveloperRow,
  type DiscordMemberRow,
  type EntryRole,
  type FormatType,
  LADDERS_FILE,
  type LadderConfig,
  type LadderRow,
  type LadderSlot,
  type LadderSnapshotHistoryRow,
  type LadderStandingOverride,
  type LadderStatus,
  type LeaderboardEntryView,
  PROJECTS_FILE,
  type PairAggregateRow,
  type ParsedArenaProject,
  type PendingSubmissionRow,
  type ProjectArenaLadderBadge,
  type ProjectArenaSummary,
  type RatingSnapshotRow,
  type RawProjectOwner,
  type RecentMatchView,
  type RecordMatchInput,
  type ResolvedProjectOwner,
  type RotateLadderInput,
  SETTLED_MAX_SE,
  SETTLED_MIN_MATCHES,
  type SmokeStatus,
  type SubmissionStatus,
  type SyncProjectsOptions,
  type TeamMode,
  type TeamPoolStatus,
  type VersionHistoryView,
  extractProjectOwners,
  loadLadderPoolDirs,
  parseArenaProjects,
  parseLaddersYaml,
};

export const DB_PATH = process.env.ARENA_DB_PATH ?? (
  process.env.NODE_ENV === 'production' || fs.existsSync('/var/lib/pkmn')
    ? '/var/lib/pkmn/arena.sqlite'
    : root('private', 'arena.sqlite')
);
export const SCHEMA_DIR = root('db', 'schema');
export const MIGRATION_DIR = root('db', 'migration');

const MIGRATION_FILE_RE = /^\d{4}_[a-z0-9_]+\.sql$/;

function listSqlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.sql') && !f.startsWith('.'))
    .sort((a, b) => a.localeCompare(b));
}

export class ArenaDB {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  private readonly txRunner: TransactionRunner = fn => this.inTransaction(fn);

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
          this.db.exec(fs.readFileSync(path.join(schemaDir, file), 'utf8'));
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

  syncLaddersFromYaml(laddersYaml: string, now?: number) {
    syncLaddersFromYaml(this.db, this.txRunner, laddersYaml, now);
  }

  syncLadders(file?: string, now?: number) {
    syncLadders(this.db, this.txRunner, file, now);
  }

  getLadders(): LadderRow[] {
    return getLadders(this.db);
  }

  getCurrentLadders(): LadderRow[] {
    return getCurrentLadders(this.db);
  }

  getActiveLadders(): LadderRow[] {
    return getActiveLadders(this.db);
  }

  getPlayableLadders(): LadderRow[] {
    return getPlayableLadders(this.db);
  }

  getLadder(id: string): LadderRow | undefined {
    return getLadder(this.db, id);
  }

  getActiveLadderBySlot(slot: LadderSlot): LadderRow | undefined {
    return getActiveLadderBySlot(this.db, slot);
  }

  setLadderStatus(ladderId: string, status: LadderStatus, now?: number): LadderRow {
    return setLadderStatus(this.db, this.txRunner, ladderId, status, now);
  }

  rotateLadder(input: RotateLadderInput): {oldLadder: LadderRow; newLadder?: LadderRow} {
    return rotateLadder(this.db, this.txRunner, input);
  }

  syncProjectsFromYaml(projectsYaml: string, avatarsDir?: string, now?: number) {
    syncProjectsFromYaml(this.db, this.txRunner, projectsYaml, avatarsDir, now);
  }

  syncProjects(file?: string, avatarsDir?: string, now?: number) {
    syncProjects(this.db, this.txRunner, file, avatarsDir, now);
  }

  async syncProjectsFromYamlWithSmogon(projectsYaml: string, options?: SyncProjectsOptions) {
    await syncProjectsFromYamlWithSmogon(this.db, this.txRunner, projectsYaml, options);
  }

  async syncProjectsWithSmogon(file?: string, options?: SyncProjectsOptions) {
    await syncProjectsWithSmogon(this.db, this.txRunner, file, options);
  }

  getBotBySlug(slug: string): BotRow | undefined {
    return getBotBySlug(this.db, slug);
  }

  getBotById(id: number): BotRow | undefined {
    return getBotById(this.db, id);
  }

  refundCooldown(botSlug: string, now?: number): BotRow {
    return refundCooldown(this.db, botSlug, now);
  }

  getDeveloperByGitHub(githubLogin: string): DeveloperRow | undefined {
    return getDeveloperByGitHub(this.db, githubLogin);
  }

  getDeveloperByDiscordId(discordId: string): DeveloperRow | undefined {
    return getDeveloperByDiscordId(this.db, discordId);
  }

  getDevelopersForBot(botId: number): DeveloperRow[] {
    return getDevelopersForBot(this.db, botId);
  }

  linkDeveloperGitHubId(githubLogin: string, githubId: number, now?: number) {
    linkDeveloperGitHubId(this.db, githubLogin, githubId, now);
  }

  linkDeveloperDiscord(
    githubLogin: string,
    discordId: string,
    discordUsername: string,
    now?: number
  ) {
    linkDeveloperDiscord(this.db, this.txRunner, githubLogin, discordId, discordUsername, now);
  }

  unlinkDeveloperDiscord(githubLogin: string, now?: number) {
    unlinkDeveloperDiscord(this.db, githubLogin, now);
  }

  syncDiscordMembers(members: Iterable<{id: string; username: string}>, now?: number) {
    syncDiscordMembers(this.db, this.txRunner, members, now);
  }

  isDiscordMember(discordId: string | undefined): boolean {
    return isDiscordMember(this.db, discordId);
  }

  hasActiveLadderTeams(ladderId: string, botId: number): boolean {
    return hasActiveLadderTeams(this.db, ladderId, botId);
  }

  getTeamsForBotLadder(
    ladderId: string,
    botId: number,
    status?: TeamPoolStatus
  ): string[] {
    return getTeamsForBotLadder(this.db, ladderId, botId, status);
  }

  getVersionById(versionId: number): BotVersionRow | undefined {
    return getVersionById(this.db, versionId);
  }

  getVersionBySlugAndStr(
    botSlug: string,
    versionStr: string
  ): (BotVersionRow & {bot_slug: string; bot_name: string}) | undefined {
    return getVersionBySlugAndStr(this.db, botSlug, versionStr);
  }

  getActiveEntriesForBot(botId: number): ActiveEntryView[] {
    return getActiveEntriesForBot(this.db, botId);
  }

  getVersionsForBot(botId: number): VersionHistoryView[] {
    return getVersionsForBot(this.db, botId);
  }

  hasAnyLeaderboardEntry(botId: number): boolean {
    return hasAnyLeaderboardEntry(this.db, botId);
  }

  computeBotSubmissionStatus(botId: number, now?: number): SubmissionStatus {
    return computeBotSubmissionStatus(this.db, botId, now);
  }

  createSubmission(input: CreateSubmissionInput): BotVersionRow {
    return createSubmission(this.db, this.txRunner, input);
  }

  getPendingSubmissions(): PendingSubmissionRow[] {
    return getPendingSubmissions(this.db);
  }

  applySubmissionStatus(input: ApplySubmissionStatusInput): ApplySubmissionStatusResult {
    return applySubmissionStatus(this.db, this.txRunner, input);
  }

  quarantineVersion(
    botSlug: string,
    versionStr: string,
    reason?: string,
    now?: number
  ): ApplySubmissionStatusResult {
    return quarantineVersion(this.db, this.txRunner, botSlug, versionStr, reason, now);
  }

  unquarantineVersion(botSlug: string, versionStr: string, now?: number): BotVersionRow {
    return unquarantineVersion(this.db, this.txRunner, botSlug, versionStr, now);
  }

  recomputeLadderRatings(
    ladderId: string,
    nowSec?: number,
    prevMatchSec?: number | null,
    dayUtc?: string
  ): RatingResult {
    return recomputeLadderRatings(this.db, ladderId, nowSec, prevMatchSec, dayUtc);
  }

  setLadderAnchor(ladderId: string, botSlug: string, versionStr: string, now?: number) {
    const ver = this.getVersionBySlugAndStr(botSlug, versionStr);
    if (!ver) {
      throw new Error(`Version "${versionStr}" not found for bot "${botSlug}"`);
    }
    setLadderAnchor(this.db, this.txRunner, ladderId, ver.id, now);
  }

  recordCompletedMatch(input: RecordMatchInput): {duplicate: boolean; archivedLadder: boolean} {
    return recordCompletedMatch(this.db, this.txRunner, input);
  }

  getRecentMatches(limit?: number): RecentMatchView[] {
    return getRecentMatches(this.db, limit);
  }

  getLeaderboardEntries(ladderId: string): LeaderboardEntryView[] {
    return getLeaderboardEntries(this.db, ladderId);
  }

  getProjectArenaSummaries(): ProjectArenaSummary[] {
    return getProjectArenaSummaries(this.db);
  }

  getPairAggregatesForLadder(ladderId: string): PairAggregateRow[] {
    return getPairAggregatesForLadder(this.db, ladderId);
  }

  getRatingSnapshotsForLadder(ladderId: string): LadderSnapshotHistoryRow[] {
    return getRatingSnapshotsForLadder(this.db, ladderId);
  }
}
