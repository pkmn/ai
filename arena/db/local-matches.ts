import {DatabaseSync} from 'node:sqlite';

import {ExecutionMode} from './local-agents';

export type CheckpointStatus = 'in-progress' | 'g1-complete' | 'complete' | 'aborted';
export type TeamMode = 'random' | 'harvested' | 'pools';
export type GameOutcome = 'W' | 'L' | 'T';

export interface LocalMatchCheckpoint {
  id: string;
  ladderId: string;
  format: string;
  teamMode: TeamMode;
  p1VersionId: number;
  p1AgentId: number;
  p1Slug: string;
  p1Name: string;
  p1Version: string;
  p1Mode: ExecutionMode;
  p1Target: string;
  p2VersionId: number;
  p2AgentId: number;
  p2Slug: string;
  p2Name: string;
  p2Version: string;
  p2Mode: ExecutionMode;
  p2Target: string;
  seed: string;
  p1TeamPacked: string;
  p2TeamPacked: string;
  p1TeamLabel?: string;
  p2TeamLabel?: string;
  status: CheckpointStatus;
  g1Outcome?: GameOutcome;
  g1Turns?: number;
  g1EndReason?: string;
  g1P1BankSeconds?: number;
  g1P2BankSeconds?: number;
  g1P1Ram?: number;
  g1P2Ram?: number;
  g1P1TurnMillis?: number;
  g1P2TurnMillis?: number;
  startedAt: number;
  g1CompletedAt?: number;
  completedAt?: number;
}

export interface CreateMatchCheckpointInput {
  id: string;
  ladderId: string;
  format: string;
  teamMode: TeamMode;
  p1VersionId: number;
  p1AgentId: number;
  p1Slug: string;
  p1Name: string;
  p1Version: string;
  p1Mode: ExecutionMode;
  p1Target: string;
  p2VersionId: number;
  p2AgentId: number;
  p2Slug: string;
  p2Name: string;
  p2Version: string;
  p2Mode: ExecutionMode;
  p2Target: string;
  seed: string;
  p1TeamPacked: string;
  p2TeamPacked: string;
  p1TeamLabel?: string;
  p2TeamLabel?: string;
  startedAt?: number;
}

export interface CompleteGame1Input {
  id: string;
  outcome: GameOutcome;
  turns: number;
  endReason: string;
  p1BankSeconds: number;
  p2BankSeconds: number;
  p1Ram: number;
  p2Ram: number;
  p1TurnMillis: number;
  p2TurnMillis: number;
  completedAt?: number;
}

interface RawLocalMatchRow {
  id: string;
  ladder_id: string;
  format: string;
  team_mode: TeamMode;
  p1_version_id: number;
  p1_agent_id: number;
  p1_slug: string;
  p1_name: string;
  p1_version: string;
  p1_mode: ExecutionMode;
  p1_target: string;
  p2_version_id: number;
  p2_agent_id: number;
  p2_slug: string;
  p2_name: string;
  p2_version: string;
  p2_mode: ExecutionMode;
  p2_target: string;
  seed: string;
  p1_team_packed: string;
  p2_team_packed: string;
  p1_team_label: string | null;
  p2_team_label: string | null;
  status: CheckpointStatus;
  g1_outcome: GameOutcome | null;
  g1_turns: number | null;
  g1_end_reason: string | null;
  g1_p1_bank_seconds: number | null;
  g1_p2_bank_seconds: number | null;
  g1_p1_ram: number | null;
  g1_p2_ram: number | null;
  g1_p1_turn_millis: number | null;
  g1_p2_turn_millis: number | null;
  started_at: number;
  g1_completed_at: number | null;
  completed_at: number | null;
}

function mapLocalMatchRow(raw: RawLocalMatchRow): LocalMatchCheckpoint {
  return {
    id: raw.id,
    ladderId: raw.ladder_id,
    format: raw.format,
    teamMode: raw.team_mode,
    p1VersionId: raw.p1_version_id,
    p1AgentId: raw.p1_agent_id,
    p1Slug: raw.p1_slug,
    p1Name: raw.p1_name,
    p1Version: raw.p1_version,
    p1Mode: raw.p1_mode,
    p1Target: raw.p1_target,
    p2VersionId: raw.p2_version_id,
    p2AgentId: raw.p2_agent_id,
    p2Slug: raw.p2_slug,
    p2Name: raw.p2_name,
    p2Version: raw.p2_version,
    p2Mode: raw.p2_mode,
    p2Target: raw.p2_target,
    seed: raw.seed,
    p1TeamPacked: raw.p1_team_packed,
    p2TeamPacked: raw.p2_team_packed,
    p1TeamLabel: raw.p1_team_label ?? undefined,
    p2TeamLabel: raw.p2_team_label ?? undefined,
    status: raw.status,
    g1Outcome: raw.g1_outcome ?? undefined,
    g1Turns: raw.g1_turns ?? undefined,
    g1EndReason: raw.g1_end_reason ?? undefined,
    g1P1BankSeconds: raw.g1_p1_bank_seconds ?? undefined,
    g1P2BankSeconds: raw.g1_p2_bank_seconds ?? undefined,
    g1P1Ram: raw.g1_p1_ram ?? undefined,
    g1P2Ram: raw.g1_p2_ram ?? undefined,
    g1P1TurnMillis: raw.g1_p1_turn_millis ?? undefined,
    g1P2TurnMillis: raw.g1_p2_turn_millis ?? undefined,
    startedAt: raw.started_at,
    g1CompletedAt: raw.g1_completed_at ?? undefined,
    completedAt: raw.completed_at ?? undefined,
  };
}

export function createMatchCheckpoint(db: DatabaseSync, input: CreateMatchCheckpointInput) {
  const startedAt = input.startedAt ?? Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO local_matches (
      id, ladder_id, format, team_mode,
      p1_version_id, p1_agent_id, p1_slug, p1_name, p1_version, p1_mode, p1_target,
      p2_version_id, p2_agent_id, p2_slug, p2_name, p2_version, p2_mode, p2_target,
      seed, p1_team_packed, p2_team_packed, p1_team_label, p2_team_label,
      status, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in-progress', ?)
  `).run(
    input.id,
    input.ladderId,
    input.format,
    input.teamMode,
    input.p1VersionId,
    input.p1AgentId,
    input.p1Slug,
    input.p1Name,
    input.p1Version,
    input.p1Mode,
    input.p1Target,
    input.p2VersionId,
    input.p2AgentId,
    input.p2Slug,
    input.p2Name,
    input.p2Version,
    input.p2Mode,
    input.p2Target,
    input.seed,
    input.p1TeamPacked,
    input.p2TeamPacked,
    input.p1TeamLabel ?? null,
    input.p2TeamLabel ?? null,
    startedAt
  );
}

export function checkpointGame1Complete(db: DatabaseSync, input: CompleteGame1Input) {
  const completedAt = input.completedAt ?? Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE local_matches
    SET status = 'g1-complete',
        g1_outcome = ?,
        g1_turns = ?,
        g1_end_reason = ?,
        g1_p1_bank_seconds = ?,
        g1_p2_bank_seconds = ?,
        g1_p1_ram = ?,
        g1_p2_ram = ?,
        g1_p1_turn_millis = ?,
        g1_p2_turn_millis = ?,
        g1_completed_at = ?
    WHERE id = ?
  `).run(
    input.outcome,
    input.turns,
    input.endReason,
    input.p1BankSeconds,
    input.p2BankSeconds,
    input.p1Ram,
    input.p2Ram,
    input.p1TurnMillis,
    input.p2TurnMillis,
    completedAt,
    input.id
  );
}

export function markMatchCheckpointStatus(
  db: DatabaseSync,
  id: string,
  status: CheckpointStatus,
  now = Math.floor(Date.now() / 1000)
) {
  db.prepare(`
    UPDATE local_matches
    SET status = ?,
        completed_at = ?
    WHERE id = ?
  `).run(status, now, id);
}

export function getMatchCheckpoint(
  db: DatabaseSync,
  id: string
): LocalMatchCheckpoint | undefined {
  const raw = db.prepare(
    'SELECT * FROM local_matches WHERE id = ?'
  ).get(id) as RawLocalMatchRow | undefined;
  return raw ? mapLocalMatchRow(raw) : undefined;
}

export function listIncompleteMatchCheckpoints(db: DatabaseSync): LocalMatchCheckpoint[] {
  const rows = db.prepare(`
    SELECT * FROM local_matches
    WHERE status IN ('in-progress', 'g1-complete')
    ORDER BY started_at ASC
  `).all() as unknown as RawLocalMatchRow[];
  return rows.map(mapLocalMatchRow);
}
