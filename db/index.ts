import * as fs from 'fs';
import {DatabaseSync} from 'node:sqlite';
import * as path from 'path';

import {RatingResult} from '../server/ratings';
import {root} from '../static/util';

import * as stats from './agent-ladder-stats';
import * as teams from './agent-ladder-teams';
import * as versions from './agent-versions';
import * as agents from './agents';
import * as developers from './developers';
import * as discordMembers from './discord-members';
import * as entries from './ladder-entries';
import * as ladderTeams from './ladder-teams';
import * as ladders from './ladders';
import * as matches from './matches';
import * as pairs from './pair-aggregates';
import * as snapshots from './rating-snapshots';
import * as entrants from './tournament-entrants';
import * as games from './tournament-games';
import * as tournaments from './tournaments';

export type TransactionRunner = <T>(fn: () => T) => T;

export interface Options {
  schemaDir?: string;
  migrationDir?: string;
  backupBeforeMigrate?: boolean;
  now?: number;
}

export interface AppliedMigration {
  version: string;
  appliedAt: number;
}

export type MigrationKind = 'additive' | 'destructive' | 'mixed';

function stripSqlCommentsAndStrings(sql: string): string {
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      i = sql.indexOf('\n', i + 2);
      if (i === -1) break;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated /* comment in migration SQL');
      i = end + 1;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += quote === "'" ? "''" : ch;
      for (i++; i < sql.length; i++) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i++;
            continue;
          }
          break;
        }
        if (quote === '"') out += sql[i];
      }
      if (i >= sql.length) throw new Error(`Unterminated ${quote} literal in migration SQL`);
      if (quote === '"') out += '"';
      continue;
    }
    out += ch;
  }
  return out;
}

const ADDITIVE_STATEMENT_RE = new RegExp(
  '^(?:CREATE\\s+(?:(?:UNIQUE\\s+)?INDEX|TABLE|TRIGGER|VIEW)\\b|' +
  'ALTER\\s+TABLE\\s+\\S+\\s+ADD\\b|INSERT\\b)',
  'i'
);
const DESTRUCTIVE_STATEMENT_RE = new RegExp(
  '^(?:DROP\\s+(?:INDEX|TABLE|TRIGGER|VIEW)\\b|' +
  'ALTER\\s+TABLE\\s+\\S+\\s+(?:DROP|RENAME)\\b|DELETE\\b|UPDATE\\b)',
  'i'
);
const RENAME_STAGING_RE =
  /^ALTER\s+TABLE\s+"?([A-Za-z0-9_]+)"?\s+RENAME\s+TO\s+"?[A-Za-z0-9_]+"?$/i;

export function classifyMigrationSql(sql: string): MigrationKind {
  const statements = stripSqlCommentsAndStrings(sql)
    .split(';')
    .map(stmt => stmt.trim().replace(/\s+/g, ' '))
    .filter(stmt => stmt.length > 0 && !/^PRAGMA\b/i.test(stmt));
  if (statements.length === 0) {
    throw new Error('Migration SQL contains no executable statements');
  }

  // Recognize SQLite's standard 4-step table rebuild (`CREATE TABLE x_new`, `INSERT INTO x_new`,
  // `DROP TABLE x`, `ALTER TABLE x_new RENAME TO x`) so staging-table creation/copy is treated as
  // part of the destructive table rebuild rather than a mixed additive+destructive migration.
  const stagingTables = new Set<string>();
  for (const stmt of statements) {
    const m = RENAME_STAGING_RE.exec(stmt);
    if (m) stagingTables.add(m[1].toLowerCase());
  }

  let hasAdditive = false;
  let hasDestructive = false;
  for (const stmt of statements) {
    const createMatch = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?\b/i.exec(
      stmt
    );
    const insertMatch = /^INSERT\s+(?:OR\s+\S+\s+)?INTO\s+"?([A-Za-z0-9_]+)"?\b/i.exec(stmt);
    if (
      (createMatch && stagingTables.has(createMatch[1].toLowerCase())) ||
      (insertMatch && stagingTables.has(insertMatch[1].toLowerCase()))
    ) {
      hasDestructive = true;
      continue;
    }
    if (ADDITIVE_STATEMENT_RE.test(stmt)) {
      hasAdditive = true;
    } else if (DESTRUCTIVE_STATEMENT_RE.test(stmt)) {
      hasDestructive = true;
    } else {
      throw new Error(`Unrecognized SQL migration statement: "${stmt}"`);
    }
  }

  if (hasAdditive && hasDestructive) return 'mixed';
  return hasDestructive ? 'destructive' : 'additive';
}

export function compareDatabaseSchemas(dbA: DatabaseSync, dbB: DatabaseSync): string[] {
  const inspect = (conn: DatabaseSync) => {
    const tables = (conn.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name ASC`
    ).all() as Array<{name: string}>).map(r => r.name);
    const snapshot = new Map<string, string>();
    for (const table of tables) {
      const cols = conn.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;
      const fks = conn.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
      }>;
      snapshot.set(
        table,
        JSON.stringify({
          cols: cols.map(c => ({
            name: c.name,
            type: c.type.toUpperCase(),
            notnull: c.notnull,
            dflt: c.dflt_value ?? undefined,
            pk: c.pk,
          })),
          fks: fks
            .map(f => ({
              table: f.table,
              from: f.from,
              to: f.to,
              onUpdate: f.on_update,
              onDelete: f.on_delete,
            }))
            .sort((x, y) =>
              `${x.from}:${x.table}.${x.to}`.localeCompare(`${y.from}:${y.table}.${y.to}`)),
        })
      );
    }
    return snapshot;
  };

  const snapA = inspect(dbA);
  const snapB = inspect(dbB);
  const allTables = [...new Set([...snapA.keys(), ...snapB.keys()])].sort();
  const diffs: string[] = [];
  for (const table of allTables) {
    const a = snapA.get(table);
    const b = snapB.get(table);
    if (a === undefined) {
      diffs.push(`table "${table}" missing in first schema`);
    } else if (b === undefined) {
      diffs.push(`table "${table}" missing in second schema`);
    } else if (a !== b) {
      diffs.push(`table "${table}" definition mismatch: ${a} vs ${b}`);
    }
  }
  return diffs;
}

function defaultDbPath(): string {
  return process.env.ARENA_DB_PATH ?? (
    process.env.NODE_ENV === 'production' || fs.existsSync('/var/lib/pkmn')
      ? '/var/lib/pkmn/arena.sqlite'
      : root('db', 'data', 'arena.sqlite')
  );
}

export const DB_PATH = defaultDbPath();
export const SCHEMA_DIR = root('db', 'schema');
export const MIGRATION_DIR = root('db', 'migration');
export const SCHEMA_FILES = listSqlFiles(SCHEMA_DIR);

const MIGRATION_FILE_RE = /^\d{4}-[a-z0-9-]+\.sql$/;

export function listSqlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.sql') && !f.startsWith('.'))
    .sort((a, b) => a.localeCompare(b));
}

export class SqliteDatabase {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  private txDepth = 0;
  protected readonly txRunner: TransactionRunner = fn => this.inTransaction(fn);

  constructor(
    dbPath: string,
    defaultSchemaDir: string,
    defaultMigrationDir: string,
    options: Options = {}
  ) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), {recursive: true});
    }
    this.db = new DatabaseSync(dbPath);
    // WAL + synchronous=NORMAL gives safe single-writer concurrency on local SSD while allowing
    // external CLI tools (`pkmn quarantine`, `pkmn rotate-ladder`, `.backup`) to read/write
    // alongside the live Node process within `busy_timeout = 5000` ms.
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.initializeSchema(defaultSchemaDir, defaultMigrationDir, options);
  }

  // Dual schema bootstrap:
  //   - Fresh databases (`:memory:` in tests, first boot in prod) execute every declarative
  //     `schema/*.sql` file and mark all existing `migration/NNNN-*.sql` files as applied.
  //   - Existing databases create an atomic `VACUUM INTO` backup before applying unapplied
  //     `NNNN-description.sql` migrations in sequence. `PRAGMA foreign_keys = OFF` is toggled
  //     outside `inTransaction` because SQLite ignores `PRAGMA foreign_keys` inside an open
  //     transaction; `PRAGMA foreign_key_check` validates referential integrity before `COMMIT`.
  private initializeSchema(
    defaultSchemaDir: string,
    defaultMigrationDir: string,
    options: Options
  ) {
    const schemaDir = options.schemaDir ?? defaultSchemaDir;
    const migrationDir = options.migrationDir ?? defaultMigrationDir;
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
          `Invalid migration filename "${file}" (expected NNNN-description.sql)`
        );
      }
      const prefix = file.slice(0, 4);
      if (seenNumbers.has(prefix)) {
        throw new Error(`Duplicate migration sequence prefix "${prefix}" in "${file}"`);
      }
      seenNumbers.add(prefix);
      const kind = classifyMigrationSql(fs.readFileSync(path.join(migrationDir, file), 'utf8'));
      if (kind === 'mixed') {
        throw new Error(
          `Migration "${file}" mixes additive and destructive SQL statements; ` +
          'split into separate migrations'
        );
      }
    }

    const createMigrationsTableSql = `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `;

    if (isFresh) {
      this.inTransaction(() => {
        this.db.exec(createMigrationsTableSql);
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

    this.db.exec(createMigrationsTableSql);

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

  getAppliedMigrations(): AppliedMigration[] {
    const rows = this.db.prepare(
      'SELECT version, applied_at FROM schema_migrations ORDER BY version ASC'
    ).all() as Array<{version: string; applied_at: number}>;
    return rows.map(r => ({version: r.version, appliedAt: r.applied_at}));
  }

  close() {
    this.db.close();
  }

  // Combines SQLite's cross-process WAL `data_version` (bumped whenever an external CLI process
  // commits to `arena.sqlite`) with `total_changes()` (bumped on every statement in this process,
  // including `:memory:`) into an O(1) cache-invalidation token for SSR routes.
  getChangeToken(): string {
    const dv = this.db.prepare('PRAGMA data_version').get() as {data_version?: number} | undefined;
    const tc = this.db.prepare('SELECT total_changes() AS c').get() as {c?: number} | undefined;
    return `${dv?.data_version ?? 0}:${tc?.c ?? 0}`;
  }

  inTransaction<T>(fn: () => T): T {
    const depth = this.txDepth;
    const sp = `sp_${depth}`;
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      this.txDepth = depth;
      try {
        if (depth === 0) {
          this.db.exec('ROLLBACK');
        } else {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`);
        }
      } catch {}
      throw err;
    }
  }
}

export class Database extends SqliteDatabase {
  constructor(dbPath = defaultDbPath(), options: Options = {}) {
    super(dbPath, SCHEMA_DIR, MIGRATION_DIR, options);
  }

  syncLaddersFromYaml(laddersYaml: string, now?: number) {
    ladders.syncLaddersFromYaml(this.db, this.txRunner, laddersYaml, now);
  }

  syncLadders(file?: string, now?: number) {
    ladders.syncLadders(this.db, this.txRunner, file, now);
  }

  getLadders(): ladders.LadderRow[] {
    return ladders.getLadders(this.db);
  }

  getCurrentLadders(): ladders.LadderRow[] {
    return ladders.getCurrentLadders(this.db);
  }

  getActiveLadders(): ladders.LadderRow[] {
    return ladders.getActiveLadders(this.db);
  }

  getPlayableLadders(): ladders.LadderRow[] {
    return ladders.getPlayableLadders(this.db);
  }

  getLadder(id: string): ladders.LadderRow | undefined {
    return ladders.getLadder(this.db, id);
  }

  getActiveLadderBySlot(slot: ladders.LadderSlot): ladders.LadderRow | undefined {
    return ladders.getActiveLadderBySlot(this.db, slot);
  }

  setLadderStatus(ladderId: string, status: ladders.LadderStatus, now?: number): ladders.LadderRow {
    return ladders.setLadderStatus(this.db, this.txRunner, ladderId, status, now);
  }

  countLadderTeams(ladderId: string): number {
    return ladderTeams.countLadderTeams(this.db, ladderId);
  }

  hasLadderTeams(ladderId: string): boolean {
    return ladderTeams.hasLadderTeams(this.db, ladderId);
  }

  getLadderTeams(ladderId: string): string[] {
    return ladderTeams.getLadderTeams(this.db, ladderId);
  }

  replaceLadderTeams(ladderId: string, packedTeams: string[], now?: number): number {
    return ladderTeams.replaceLadderTeams(this.db, this.txRunner, ladderId, packedTeams, now);
  }

  rotateLadder(
    input: ladders.RotateLadderInput
  ): {oldLadder: ladders.LadderRow; newLadder?: ladders.LadderRow} {
    return ladders.rotateLadder(this.db, this.txRunner, input);
  }

  syncProjectsFromYaml(projectsYaml: string, avatarsDir?: string, now?: number) {
    agents.syncProjectsFromYaml(this.db, this.txRunner, projectsYaml, avatarsDir, now);
  }

  syncProjects(file?: string, avatarsDir?: string, now?: number) {
    agents.syncProjects(this.db, this.txRunner, file, avatarsDir, now);
  }

  async syncProjectsFromYamlWithSmogon(
    projectsYaml: string,
    options?: agents.SyncProjectsOptions
  ) {
    await agents.syncProjectsFromYamlWithSmogon(this.db, this.txRunner, projectsYaml, options);
  }

  async syncProjectsWithSmogon(file?: string, options?: agents.SyncProjectsOptions) {
    await agents.syncProjectsWithSmogon(this.db, this.txRunner, file, options);
  }

  getAgentBySlug(slug: string): agents.AgentRow | undefined {
    return agents.getAgentBySlug(this.db, slug);
  }

  getAgentById(id: number): agents.AgentRow | undefined {
    return agents.getAgentById(this.db, id);
  }

  refundCooldown(agentSlug: string, now?: number): agents.AgentRow {
    return agents.refundCooldown(this.db, agentSlug, now);
  }

  getDeveloperByGitHub(githubLogin: string): developers.DeveloperRow | undefined {
    return developers.getDeveloperByGitHub(this.db, githubLogin);
  }

  getDeveloperByGitHubId(githubId: number): developers.DeveloperRow | undefined {
    return developers.getDeveloperByGitHubId(this.db, githubId);
  }

  getDeveloperByDiscordId(discordId: string): developers.DeveloperRow | undefined {
    return developers.getDeveloperByDiscordId(this.db, discordId);
  }

  getDevelopersForAgent(agentId: number): developers.DeveloperRow[] {
    return developers.getDevelopersForAgent(this.db, agentId);
  }

  getCompetitorDiscordIds(): string[] {
    return developers.getCompetitorDiscordIds(this.db);
  }

  linkDeveloperGitHubId(githubLogin: string, githubId: number, now?: number): boolean {
    return developers.linkDeveloperGitHubId(this.db, githubLogin, githubId, now);
  }

  linkDeveloperDiscord(
    githubLogin: string,
    discordId: string,
    discordUsername: string,
    now?: number
  ) {
    developers.linkDeveloperDiscord(
      this.db,
      this.txRunner,
      githubLogin,
      discordId,
      discordUsername,
      now
    );
  }

  unlinkDeveloperDiscord(githubLogin: string, now?: number) {
    developers.unlinkDeveloperDiscord(this.db, githubLogin, now);
  }

  syncDiscordMembers(members: Iterable<{id: string; username: string}>, now?: number) {
    discordMembers.syncDiscordMembers(this.db, this.txRunner, members, now);
  }

  isDiscordMember(discordId: string | undefined): boolean {
    return discordMembers.isDiscordMember(this.db, discordId);
  }

  hasActiveLadderTeams(ladderId: string, agentId: number): boolean {
    return teams.hasActiveLadderTeams(this.db, ladderId, agentId);
  }

  getTeamsForAgentLadder(
    ladderId: string,
    agentId: number,
    status?: teams.TeamPoolStatus
  ): string[] {
    return teams.getTeamsForAgentLadder(this.db, ladderId, agentId, status);
  }

  replaceSavedTeams(ladderId: string, agentId: number, packedTeams: string[], now?: number) {
    this.inTransaction(() => {
      teams.replaceSavedTeams(this.db, ladderId, agentId, packedTeams, now);
    });
  }

  clearSavedTeams(ladderId: string, agentId: number) {
    teams.clearSavedTeams(this.db, ladderId, agentId);
  }

  getActiveRosterForLadder(ladderId: string): teams.LadderRosterEntry[] {
    return teams.getActiveRosterForLadder(this.db, ladderId);
  }

  getVersionById(versionId: number): versions.AgentVersionRow | undefined {
    return versions.getVersionById(this.db, versionId);
  }

  getVersionBySlugAndLabel(
    agentSlug: string,
    version: string
  ): (versions.AgentVersionRow & {agentSlug: string; agentName: string}) | undefined {
    return versions.getVersionBySlugAndLabel(this.db, agentSlug, version);
  }

  getActiveEntriesForAgent(agentId: number): entries.ActiveEntryView[] {
    return entries.getActiveEntriesForAgent(this.db, agentId);
  }

  getVersionsForAgent(agentId: number): versions.VersionHistoryView[] {
    return versions.getVersionsForAgent(this.db, agentId);
  }

  computeAgentSubmissionStatus(agentId: number, now?: number): versions.SubmissionStatus {
    return versions.computeAgentSubmissionStatus(this.db, agentId, now);
  }

  computeAgentTournamentStatuses(
    agentId: number,
    now?: number
  ): versions.TournamentSubmissionStatus[] {
    return versions.computeAgentTournamentStatuses(this.db, agentId, now);
  }

  createSubmission(input: versions.CreateSubmissionInput): versions.AgentVersionRow {
    return versions.createSubmission(this.db, this.txRunner, input);
  }

  getPendingSubmissions(): versions.PendingSubmissionRow[] {
    return versions.getPendingSubmissions(this.db);
  }

  getVersionOwnerDiscordIds(agentId: number, developerId?: number): string[] {
    return versions.getVersionOwnerDiscordIds(this.db, agentId, developerId);
  }

  getPendingVersionDms(): versions.PendingVersionDmRow[] {
    return versions.getPendingVersionDms(this.db);
  }

  markVersionNotified(versionId: number) {
    versions.markVersionNotified(this.db, versionId);
  }

  applySubmissionStatus(
    input: versions.ApplySubmissionStatusInput
  ): versions.ApplySubmissionStatusResult {
    return versions.applySubmissionStatus(this.db, this.txRunner, input);
  }

  quarantineVersion(
    agentSlug: string,
    version: string,
    reason?: string,
    now?: number
  ): versions.ApplySubmissionStatusResult {
    return versions.quarantineVersion(this.db, this.txRunner, agentSlug, version, reason, now);
  }

  unquarantineVersion(
    agentSlug: string,
    version: string,
    now?: number
  ): versions.AgentVersionRow {
    return versions.unquarantineVersion(this.db, this.txRunner, agentSlug, version, now);
  }

  recomputeLadderRatings(
    ladderId: string,
    nowSec?: number,
    prevMatchSec?: number,
    dayUtc?: string
  ): RatingResult {
    return entries.recomputeLadderRatings(this.db, ladderId, nowSec, prevMatchSec, dayUtc);
  }

  setLadderAnchor(ladderId: string, agentSlug: string, version: string, now?: number) {
    const ver = this.getVersionBySlugAndLabel(agentSlug, version);
    if (!ver) {
      throw new Error(`Version "${version}" not found for agent "${agentSlug}"`);
    }
    entries.setLadderAnchor(this.db, this.txRunner, ladderId, ver.id, now);
  }

  recordCompletedMatch(
    input: matches.RecordMatchInput
  ): {duplicate: boolean; archivedLadder: boolean} {
    return matches.recordCompletedMatch(this.db, this.txRunner, input);
  }

  getRecentMatches(limit?: number): matches.RecentMatchView[] {
    return matches.getRecentMatches(this.db, limit);
  }

  getMatch(id: string): matches.RecentMatchView | undefined {
    return matches.getMatch(this.db, id);
  }

  getMatchesPage(query?: matches.MatchesPageQuery): matches.MatchesPageResult {
    return matches.getMatchesPage(this.db, query);
  }

  getMatchCountsBySlot(): Record<string, number> {
    return matches.getMatchCountsBySlot(this.db);
  }

  getLeaderboardEntries(ladderId: string): entries.LeaderboardEntryView[] {
    return entries.getLeaderboardEntries(this.db, ladderId);
  }

  getProjectArenaSummaries(): entries.ProjectArenaSummary[] {
    return entries.getProjectArenaSummaries(this.db);
  }

  getArenaLadderRoleTargets(): entries.ArenaLadderRoleTarget[] {
    return entries.getArenaLadderRoleTargets(this.db);
  }

  getPairAggregatesForLadder(ladderId: string): pairs.PairAggregateRow[] {
    return pairs.getPairAggregatesForLadder(this.db, ladderId);
  }

  getRatingSnapshotsForLadder(
    ladderId: string,
    agentId?: number
  ): snapshots.LadderSnapshotHistoryRow[] {
    return snapshots.getRatingSnapshotsForLadder(this.db, ladderId, agentId);
  }

  getAllActiveAgents(): agents.AgentRow[] {
    return agents.getAllActiveAgents(this.db);
  }

  getAgentParticipatedLadders(agentId: number): ladders.LadderRow[] {
    return entries.getAgentParticipatedLadders(this.db, agentId);
  }

  getAgentLadderProfileEntries(
    agentId: number,
    ladderId: string
  ): entries.AgentLadderProfileEntry[] {
    return entries.getAgentLadderProfileEntries(this.db, agentId, ladderId);
  }

  getAgentLadderStats(ladderId: string, agentId: number): stats.AgentLadderStatsRow | undefined {
    return stats.getAgentLadderStats(this.db, ladderId, agentId);
  }

  getRecentMatchesForAgentOnLadder(
    agentId: number,
    ladderId: string,
    limit?: number
  ): matches.RecentMatchView[] {
    return matches.getRecentMatchesForAgentOnLadder(this.db, agentId, ladderId, limit);
  }

  upsertTournament(input: tournaments.UpsertTournamentInput) {
    tournaments.upsertTournament(this.db, input);
  }

  getTournaments(): tournaments.TournamentRow[] {
    return tournaments.getTournaments(this.db);
  }

  getTournament(id: string): tournaments.TournamentRow | undefined {
    return tournaments.getTournament(this.db, id);
  }

  getRunningTournament(): tournaments.TournamentRow | undefined {
    return tournaments.getRunningTournament(this.db);
  }

  getTournamentClosesAt(startsAt: number): number {
    return tournaments.getTournamentClosesAt(startsAt);
  }

  setTournamentStatus(
    id: string,
    status: tournaments.TournamentStatus,
    now?: number
  ): tournaments.TournamentRow {
    return tournaments.setTournamentStatus(this.db, this.txRunner, id, status, now);
  }

  seedTournamentEntrants(tournamentId: string): number {
    return tournaments.seedTournamentEntrants(this.db, this.txRunner, tournamentId);
  }

  upsertTournamentEntrant(input: entrants.UpsertTournamentEntrantInput) {
    entrants.upsertTournamentEntrant(this.db, input);
  }

  recomputeTournamentStandings(tournamentId: string, assignFinalRanks = false) {
    this.inTransaction(() => {
      entrants.recomputeTournamentStandings(this.db, tournamentId, assignFinalRanks);
    });
  }

  getTournamentEntrants(tournamentId: string): entrants.TournamentEntrantView[] {
    return entrants.getTournamentEntrants(this.db, tournamentId);
  }

  upsertTournamentGame(input: games.UpsertTournamentGameInput) {
    games.upsertTournamentGame(this.db, input);
  }

  getTournamentGame(gameId: string): games.TournamentGameView | undefined {
    return games.getTournamentGame(this.db, gameId);
  }

  recordCompletedTournamentGame(
    game: games.CompletedTournamentGamePayload
  ): {duplicate: boolean; game: games.TournamentGameView} {
    return games.recordCompletedTournamentGame(this.db, this.txRunner, game);
  }

  getTournamentGames(tournamentId: string, limit?: number): games.TournamentGameView[] {
    return games.getTournamentGames(this.db, tournamentId, limit);
  }

  getTournamentCrosstable(
    tournamentId: string,
    stage?: games.TournamentGameStage
  ): games.TournamentPairRecord[] {
    return games.getTournamentCrosstable(this.db, tournamentId, stage);
  }
}

export * from './agent-ladder-stats';
export * from './agent-ladder-teams';
export * from './agent-versions';
export * from './agents';
export * from './developers';
export * from './discord-members';
export * from './ladder-entries';
export * from './ladder-teams';
export * from './ladders';
export * from './matches';
export * from './pair-aggregates';
export * from './rating-snapshots';
export * from './tournament-entrants';
export * from './tournament-games';
export * from './tournaments';
