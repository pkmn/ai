import {DatabaseSync} from 'node:sqlite';

import {ExecutionMode} from './local-agents';

export type CheckpointStatus = 'in-progress' | 'g1-complete' | 'complete' | 'aborted';
export type TeamMode = 'random' | 'harvested' | 'pools';
export type GameOutcome = 'W' | 'L' | 'T';

export interface CheckpointPlayer {
  versionId: number;
  agentId: number;
  slug: string;
  name: string;
  version: string;
  mode: ExecutionMode;
  target: string;
  teamPacked: string;
  teamLabel?: string;
}

export interface CheckpointGameStats {
  bankSeconds: number;
  ram: number;
  turnMillis: number;
}

export interface CheckpointGame1 {
  outcome: GameOutcome;
  turns: number;
  endReason: string;
  p1: CheckpointGameStats;
  p2: CheckpointGameStats;
  completedAt?: number;
}

export interface LocalMatchCheckpoint {
  id: string;
  ladderId: string;
  format: string;
  teamMode: TeamMode;
  seed: string;
  p1: CheckpointPlayer;
  p2: CheckpointPlayer;
  status: CheckpointStatus;
  g1?: CheckpointGame1;
  startedAt: number;
  completedAt?: number;
}

export interface CreateMatchCheckpointInput {
  id: string;
  ladderId: string;
  format: string;
  teamMode: TeamMode;
  seed: string;
  p1: CheckpointPlayer;
  p2: CheckpointPlayer;
  startedAt?: number;
}

export interface CompleteGame1Input {
  id: string;
  outcome: GameOutcome;
  turns: number;
  endReason: string;
  p1: CheckpointGameStats;
  p2: CheckpointGameStats;
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
  const hasG1 = raw.g1_outcome !== null;
  return {
    id: raw.id,
    ladderId: raw.ladder_id,
    format: raw.format,
    teamMode: raw.team_mode,
    seed: raw.seed,
    p1: {
      versionId: raw.p1_version_id,
      agentId: raw.p1_agent_id,
      slug: raw.p1_slug,
      name: raw.p1_name,
      version: raw.p1_version,
      mode: raw.p1_mode,
      target: raw.p1_target,
      teamPacked: raw.p1_team_packed,
      teamLabel: raw.p1_team_label ?? undefined,
    },
    p2: {
      versionId: raw.p2_version_id,
      agentId: raw.p2_agent_id,
      slug: raw.p2_slug,
      name: raw.p2_name,
      version: raw.p2_version,
      mode: raw.p2_mode,
      target: raw.p2_target,
      teamPacked: raw.p2_team_packed,
      teamLabel: raw.p2_team_label ?? undefined,
    },
    status: raw.status,
    ...(hasG1
      ? {
        g1: {
          outcome: raw.g1_outcome!,
          turns: raw.g1_turns ?? 1,
          endReason: raw.g1_end_reason ?? 'win',
          p1: {
            bankSeconds: raw.g1_p1_bank_seconds ?? 0,
            ram: raw.g1_p1_ram ?? 64,
            turnMillis: raw.g1_p1_turn_millis ?? 0,
          },
          p2: {
            bankSeconds: raw.g1_p2_bank_seconds ?? 0,
            ram: raw.g1_p2_ram ?? 64,
            turnMillis: raw.g1_p2_turn_millis ?? 0,
          },
          completedAt: raw.g1_completed_at ?? undefined,
        },
      }
      : {}),
    startedAt: raw.started_at,
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
    input.p1.versionId,
    input.p1.agentId,
    input.p1.slug,
    input.p1.name,
    input.p1.version,
    input.p1.mode,
    input.p1.target,
    input.p2.versionId,
    input.p2.agentId,
    input.p2.slug,
    input.p2.name,
    input.p2.version,
    input.p2.mode,
    input.p2.target,
    input.seed,
    input.p1.teamPacked,
    input.p2.teamPacked,
    input.p1.teamLabel ?? null,
    input.p2.teamLabel ?? null,
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
    input.p1.bankSeconds,
    input.p2.bankSeconds,
    input.p1.ram,
    input.p2.ram,
    input.p1.turnMillis,
    input.p2.turnMillis,
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
