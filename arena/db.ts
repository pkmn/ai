import * as fs from 'fs';
import {DatabaseSync} from 'node:sqlite';
import * as path from 'path';

import * as arena from '../server/arena';
import * as ratings from '../server/ratings';

export type AgentMode = 'container' | 'native';
export type AgentResidency = 'hot' | 'cold';
export type CheckpointStatus = 'in_progress' | 'g1_complete' | 'complete' | 'aborted';
export type OutboxEndpoint = 'match-complete' | 'submission-status';

export interface LocalAgentRow {
  versionId: number;
  agentId: number;
  slug: string;
  version: string;
  mode: AgentMode;
  target: string;
  residency: AgentResidency;
  unpackedBytes: number;
  lastPlayedAt: number;
  totalGames: number;
  totalFaults: number;
  consecutiveFaults: number;
}

export interface MatchCheckpoint {
  id: string;
  ladderId: string;
  format: string;
  teamMode: 'random' | 'harvested' | 'pools';
  p1VersionId: number;
  p1AgentId: number;
  p1Slug: string;
  p1Name: string;
  p1Version: string;
  p1Mode: AgentMode;
  p1Target: string;
  p2VersionId: number;
  p2AgentId: number;
  p2Slug: string;
  p2Name: string;
  p2Version: string;
  p2Mode: AgentMode;
  p2Target: string;
  seed: string;
  p1TeamPacked?: string;
  p2TeamPacked?: string;
  p1TeamLabel?: string;
  p2TeamLabel?: string;
  status: CheckpointStatus;
  game1Outcome?: ratings.GameOutcome;
  game1Turns?: number;
  game1EndReason?: string;
  p1Game1BankSeconds?: number;
  p2Game1BankSeconds?: number;
  p1Game1Ram?: number;
  p2Game1Ram?: number;
  p1Game1TurnMillis?: number;
  p2Game1TurnMillis?: number;
  startedAt: number;
  updatedAt: number;
}

export interface OutboxEntry {
  id: number;
  endpoint: OutboxEndpoint;
  payloadJson: string;
  createdAt: number;
}

interface RawLocalAgentRow {
  version_id: number;
  agent_id: number;
  slug: string;
  version: string;
  mode: AgentMode;
  target: string;
  residency: AgentResidency;
  unpacked_bytes: number;
  last_played_at: number;
  total_games: number;
  total_faults: number;
  consecutive_faults: number;
}

interface RawMatchCheckpointRow {
  id: string;
  ladder_id: string;
  format: string;
  team_mode: 'random' | 'harvested' | 'pools';
  p1_version_id: number;
  p1_agent_id: number;
  p1_slug: string;
  p1_name: string;
  p1_version: string;
  p1_mode: AgentMode;
  p1_target: string;
  p2_version_id: number;
  p2_agent_id: number;
  p2_slug: string;
  p2_name: string;
  p2_version: string;
  p2_mode: AgentMode;
  p2_target: string;
  seed: string;
  p1_team_packed: string | null;
  p2_team_packed: string | null;
  p1_team_label: string | null;
  p2_team_label: string | null;
  status: CheckpointStatus;
  game1_outcome: ratings.GameOutcome | null;
  game1_turns: number | null;
  game1_end_reason: string | null;
  p1_game1_bank_seconds: number | null;
  p2_game1_bank_seconds: number | null;
  p1_game1_ram: number | null;
  p2_game1_ram: number | null;
  p1_game1_turn_millis: number | null;
  p2_game1_turn_millis: number | null;
  started_at: number;
  updated_at: number;
}

function toLocalAgent(row: RawLocalAgentRow): LocalAgentRow {
  return {
    versionId: row.version_id,
    agentId: row.agent_id,
    slug: row.slug,
    version: row.version,
    mode: row.mode,
    target: row.target,
    residency: row.residency,
    unpackedBytes: row.unpacked_bytes,
    lastPlayedAt: row.last_played_at,
    totalGames: row.total_games,
    totalFaults: row.total_faults,
    consecutiveFaults: row.consecutive_faults,
  };
}

function toCheckpoint(row: RawMatchCheckpointRow): MatchCheckpoint {
  return {
    id: row.id,
    ladderId: row.ladder_id,
    format: row.format,
    teamMode: row.team_mode,
    p1VersionId: row.p1_version_id,
    p1AgentId: row.p1_agent_id,
    p1Slug: row.p1_slug,
    p1Name: row.p1_name,
    p1Version: row.p1_version,
    p1Mode: row.p1_mode,
    p1Target: row.p1_target,
    p2VersionId: row.p2_version_id,
    p2AgentId: row.p2_agent_id,
    p2Slug: row.p2_slug,
    p2Name: row.p2_name,
    p2Version: row.p2_version,
    p2Mode: row.p2_mode,
    p2Target: row.p2_target,
    seed: row.seed,
    p1TeamPacked: row.p1_team_packed ?? undefined,
    p2TeamPacked: row.p2_team_packed ?? undefined,
    p1TeamLabel: row.p1_team_label ?? undefined,
    p2TeamLabel: row.p2_team_label ?? undefined,
    status: row.status,
    game1Outcome: row.game1_outcome ?? undefined,
    game1Turns: row.game1_turns ?? undefined,
    game1EndReason: row.game1_end_reason ?? undefined,
    p1Game1BankSeconds: row.p1_game1_bank_seconds ?? undefined,
    p2Game1BankSeconds: row.p2_game1_bank_seconds ?? undefined,
    p1Game1Ram: row.p1_game1_ram ?? undefined,
    p2Game1Ram: row.p2_game1_ram ?? undefined,
    p1Game1TurnMillis: row.p1_game1_turn_millis ?? undefined,
    p2Game1TurnMillis: row.p2_game1_turn_millis ?? undefined,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

export const STATE_DB_PATH =
  process.env.ARENA_STATE_DB ?? '/opt/arena/state/arena.sqlite';

export class StateDatabase {
  readonly db: DatabaseSync;
  readonly dbPath: string;

  constructor(dbPath = STATE_DB_PATH) {
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
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_agents (
        version_id         INTEGER PRIMARY KEY,
        agent_id           INTEGER NOT NULL,
        slug               TEXT NOT NULL,
        version            TEXT NOT NULL,
        mode               TEXT NOT NULL CHECK (mode IN ('container', 'native')),
        target             TEXT NOT NULL,
        residency          TEXT NOT NULL DEFAULT 'hot' CHECK (residency IN ('hot', 'cold')),
        unpacked_bytes     INTEGER NOT NULL DEFAULT 0,
        last_played_at     INTEGER NOT NULL DEFAULT 0,
        total_games        INTEGER NOT NULL DEFAULT 0,
        total_faults       INTEGER NOT NULL DEFAULT 0,
        consecutive_faults INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS local_matches (
        id                    TEXT PRIMARY KEY,
        ladder_id             TEXT NOT NULL,
        format                TEXT NOT NULL,
        team_mode             TEXT NOT NULL CHECK (team_mode IN ('random', 'harvested', 'pools')),
        p1_version_id         INTEGER NOT NULL,
        p1_agent_id           INTEGER NOT NULL,
        p1_slug               TEXT NOT NULL,
        p1_name               TEXT NOT NULL,
        p1_version            TEXT NOT NULL,
        p1_mode               TEXT NOT NULL CHECK (p1_mode IN ('container', 'native')),
        p1_target             TEXT NOT NULL,
        p2_version_id         INTEGER NOT NULL,
        p2_agent_id           INTEGER NOT NULL,
        p2_slug               TEXT NOT NULL,
        p2_name               TEXT NOT NULL,
        p2_version            TEXT NOT NULL,
        p2_mode               TEXT NOT NULL CHECK (p2_mode IN ('container', 'native')),
        p2_target             TEXT NOT NULL,
        seed                  TEXT NOT NULL,
        p1_team_packed        TEXT,
        p2_team_packed        TEXT,
        p1_team_label         TEXT,
        p2_team_label         TEXT,
        status                TEXT NOT NULL CHECK (
          status IN ('in_progress', 'g1_complete', 'complete', 'aborted')
        ),
        game1_outcome         TEXT CHECK (game1_outcome IN ('W', 'L', 'T')),
        game1_turns           INTEGER,
        game1_end_reason      TEXT,
        p1_game1_bank_seconds INTEGER,
        p2_game1_bank_seconds INTEGER,
        p1_game1_ram          INTEGER,
        p2_game1_ram          INTEGER,
        p1_game1_turn_millis  INTEGER,
        p2_game1_turn_millis  INTEGER,
        started_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint     TEXT NOT NULL CHECK (endpoint IN ('match-complete', 'submission-status')),
        payload_json TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ladder_counters (
        ladder_id  TEXT PRIMARY KEY,
        last_seq   INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  close() {
    this.db.close();
  }

  inTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const res = fn();
      this.db.exec('COMMIT;');
      return res;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  nextMatchSequence(ladderId: string): number {
    return this.inTransaction(() => {
      this.db.prepare(`
        INSERT INTO ladder_counters (ladder_id, last_seq)
        VALUES (?, 1)
        ON CONFLICT(ladder_id) DO UPDATE SET last_seq = last_seq + 1
      `).run(ladderId);
      const row = this.db.prepare(
        'SELECT last_seq FROM ladder_counters WHERE ladder_id = ?'
      ).get(ladderId) as {last_seq: number};
      return row.last_seq;
    });
  }

  getMatchSequence(ladderId: string): number {
    const row = this.db.prepare(
      'SELECT last_seq FROM ladder_counters WHERE ladder_id = ?'
    ).get(ladderId) as {last_seq: number} | undefined;
    return row?.last_seq ?? 0;
  }

  upsertLocalAgent(agent: {
    versionId: number;
    agentId: number;
    slug: string;
    version: string;
    mode: AgentMode;
    target: string;
    residency?: AgentResidency;
    unpackedBytes?: number;
    lastPlayedAt?: number;
  }) {
    this.db.prepare(`
      INSERT INTO local_agents (
        version_id, agent_id, slug, version, mode, target,
        residency, unpacked_bytes, last_played_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(version_id) DO UPDATE SET
        slug = excluded.slug,
        version = excluded.version,
        mode = excluded.mode,
        target = excluded.target,
        residency = excluded.residency,
        unpacked_bytes = excluded.unpacked_bytes,
        last_played_at = MAX(local_agents.last_played_at, excluded.last_played_at)
    `).run(
      agent.versionId,
      agent.agentId,
      agent.slug,
      agent.version,
      agent.mode,
      agent.target,
      agent.residency ?? 'hot',
      agent.unpackedBytes ?? 0,
      agent.lastPlayedAt ?? Math.floor(Date.now() / 1000)
    );
  }

  getLocalAgent(versionId: number): LocalAgentRow | undefined {
    const row = this.db.prepare(
      'SELECT * FROM local_agents WHERE version_id = ?'
    ).get(versionId) as RawLocalAgentRow | undefined;
    return row ? toLocalAgent(row) : undefined;
  }

  listLocalAgents(): LocalAgentRow[] {
    const rows = this.db.prepare(
      'SELECT * FROM local_agents ORDER BY version_id ASC'
    ).all() as unknown as RawLocalAgentRow[];
    return rows.map(toLocalAgent);
  }

  setAgentResidency(versionId: number, residency: AgentResidency, nowSeconds?: number) {
    if (nowSeconds !== undefined) {
      this.db.prepare(
        'UPDATE local_agents SET residency = ?, last_played_at = ? WHERE version_id = ?'
      ).run(residency, nowSeconds, versionId);
    } else {
      this.db.prepare(
        'UPDATE local_agents SET residency = ? WHERE version_id = ?'
      ).run(residency, versionId);
    }
  }

  recordAgentGameResult(
    versionId: number,
    faulted: boolean,
    nowSeconds = Math.floor(Date.now() / 1000)
  ): LocalAgentRow | undefined {
    this.db.prepare(`
      UPDATE local_agents
      SET last_played_at = ?,
          total_games = total_games + 1,
          total_faults = total_faults + ?,
          consecutive_faults = CASE WHEN ? = 1 THEN consecutive_faults + 1 ELSE 0 END
      WHERE version_id = ?
    `).run(nowSeconds, faulted ? 1 : 0, faulted ? 1 : 0, versionId);
    return this.getLocalAgent(versionId);
  }

  createMatchCheckpoint(cp: Omit<MatchCheckpoint, 'status' | 'updatedAt'>) {
    this.db.prepare(`
      INSERT OR REPLACE INTO local_matches (
        id, ladder_id, format, team_mode,
        p1_version_id, p1_agent_id, p1_slug, p1_name, p1_version, p1_mode, p1_target,
        p2_version_id, p2_agent_id, p2_slug, p2_name, p2_version, p2_mode, p2_target,
        seed, p1_team_packed, p2_team_packed, p1_team_label, p2_team_label,
        status, started_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        'in_progress', ?, ?
      )
    `).run(
      cp.id,
      cp.ladderId,
      cp.format,
      cp.teamMode,
      cp.p1VersionId,
      cp.p1AgentId,
      cp.p1Slug,
      cp.p1Name,
      cp.p1Version,
      cp.p1Mode,
      cp.p1Target,
      cp.p2VersionId,
      cp.p2AgentId,
      cp.p2Slug,
      cp.p2Name,
      cp.p2Version,
      cp.p2Mode,
      cp.p2Target,
      cp.seed,
      cp.p1TeamPacked ?? null,
      cp.p2TeamPacked ?? null,
      cp.p1TeamLabel ?? null,
      cp.p2TeamLabel ?? null,
      cp.startedAt,
      cp.startedAt
    );
  }

  checkpointGame1Complete(opts: {
    id: string;
    outcome: ratings.GameOutcome;
    turns: number;
    endReason: string;
    p1BankSeconds: number;
    p2BankSeconds: number;
    p1Ram: number;
    p2Ram: number;
    p1TurnMillis: number;
    p2TurnMillis: number;
    now?: number;
  }) {
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    this.db.prepare(`
      UPDATE local_matches
      SET status = 'g1_complete',
          game1_outcome = ?,
          game1_turns = ?,
          game1_end_reason = ?,
          p1_game1_bank_seconds = ?,
          p2_game1_bank_seconds = ?,
          p1_game1_ram = ?,
          p2_game1_ram = ?,
          p1_game1_turn_millis = ?,
          p2_game1_turn_millis = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      opts.outcome,
      opts.turns,
      opts.endReason,
      opts.p1BankSeconds,
      opts.p2BankSeconds,
      opts.p1Ram,
      opts.p2Ram,
      opts.p1TurnMillis,
      opts.p2TurnMillis,
      now,
      opts.id
    );
  }

  markMatchStatus(id: string, status: 'complete' | 'aborted', now = Math.floor(Date.now() / 1000)) {
    this.db.prepare(
      'UPDATE local_matches SET status = ?, updated_at = ? WHERE id = ?'
    ).run(status, now, id);
  }

  getIncompleteMatches(): MatchCheckpoint[] {
    const rows = this.db.prepare(`
      SELECT * FROM local_matches
      WHERE status IN ('in_progress', 'g1_complete')
      ORDER BY started_at ASC
    `).all() as unknown as RawMatchCheckpointRow[];
    return rows.map(toCheckpoint);
  }

  getMatchCheckpoint(id: string): MatchCheckpoint | undefined {
    const row = this.db.prepare(
      'SELECT * FROM local_matches WHERE id = ?'
    ).get(id) as RawMatchCheckpointRow | undefined;
    return row ? toCheckpoint(row) : undefined;
  }

  enqueueOutbox(
    endpoint: OutboxEndpoint,
    payload: arena.MatchCompletePayload | arena.SubmissionStatusPayload,
    now = Math.floor(Date.now() / 1000)
  ): number {
    const res = this.db.prepare(
      'INSERT INTO outbox (endpoint, payload_json, created_at) VALUES (?, ?, ?)'
    ).run(endpoint, JSON.stringify(payload), now);
    return Number(res.lastInsertRowid);
  }

  listOutbox(): OutboxEntry[] {
    const rows = this.db.prepare(
      'SELECT id, endpoint, payload_json, created_at FROM outbox ORDER BY id ASC'
    ).all() as Array<{
      id: number;
      endpoint: OutboxEndpoint;
      payload_json: string;
      created_at: number;
    }>;
    return rows.map(r => ({
      id: r.id,
      endpoint: r.endpoint,
      payloadJson: r.payload_json,
      createdAt: r.created_at,
    }));
  }

  deleteOutboxEntry(id: number) {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
  }
}
