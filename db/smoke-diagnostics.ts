import {DatabaseSync} from 'node:sqlite';

import {InfoStatus} from '../static/util';

export type {InfoStatus};

export const MIN_INFO_STATUS_SQL =
  "CASE MIN(CASE sd.info_status WHEN 'full' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END) " +
  "WHEN 2 THEN 'full' WHEN 1 THEN 'partial' WHEN 0 THEN 'none' END";

export function combineInfoStatus(statuses: readonly InfoStatus[]): InfoStatus | undefined {
  if (statuses.length === 0) return undefined;
  if (statuses.some(s => s === 'none')) return 'none';
  if (statuses.some(s => s === 'partial')) return 'partial';
  return 'full';
}

export interface Input {
  ladderId?: string;
  tournamentId?: string;
  format: string;
  turns: number;
  endReason: string;
  durationMillis: number;
  battleLog: string;
  p1Stderr?: string;
  p2Stderr?: string;
  p1CpuCores?: number;
  p2CpuCores?: number;
  p1PeakRam?: number;
  p2PeakRam?: number;
  infoStatus?: InfoStatus;
}

export interface Row {
  id: number;
  versionId: number;
  agentId: number;
  version: string;
  ladderId?: string;
  tournamentId?: string;
  format: string;
  turns: number;
  endReason: string;
  durationMillis: number;
  battleLog: string;
  p1Stderr?: string;
  p2Stderr?: string;
  p1CpuCores?: number;
  p2CpuCores?: number;
  p1PeakRam?: number;
  p2PeakRam?: number;
  infoStatus: InfoStatus;
  createdAt: number;
}

export interface Summary {
  id: number;
  versionId: number;
  ladderId?: string;
  tournamentId?: string;
  format: string;
  turns: number;
  endReason: string;
  durationMillis: number;
  hasLog: boolean;
  hasStderr: boolean;
  hasP1Stderr: boolean;
  hasP2Stderr: boolean;
  infoStatus: InfoStatus;
  p1CpuCores?: number;
  p2CpuCores?: number;
  p1PeakRam?: number;
  p2PeakRam?: number;
  createdAt: number;
}

interface RawRow {
  id: number;
  version_id: number;
  agent_id: number;
  version: string;
  ladder_id: string | null;
  tournament_id: string | null;
  format: string;
  turns: number;
  end_reason: string;
  duration_millis: number;
  battle_log: string;
  p1_stderr: string | null;
  p2_stderr: string | null;
  p1_cpu_cores: number | null;
  p2_cpu_cores: number | null;
  p1_peak_ram: number | null;
  p2_peak_ram: number | null;
  info_status: InfoStatus;
  created_at: number;
}

interface RawSummaryRow {
  id: number;
  version_id: number;
  ladder_id: string | null;
  tournament_id: string | null;
  format: string;
  turns: number;
  end_reason: string;
  duration_millis: number;
  has_log: number;
  has_p1_stderr: number;
  has_p2_stderr: number;
  info_status: InfoStatus;
  p1_cpu_cores: number | null;
  p2_cpu_cores: number | null;
  p1_peak_ram: number | null;
  p2_peak_ram: number | null;
  created_at: number;
}

function mapRow(raw: RawRow): Row {
  return {
    id: raw.id,
    versionId: raw.version_id,
    agentId: raw.agent_id,
    version: raw.version,
    ladderId: raw.ladder_id ?? undefined,
    tournamentId: raw.tournament_id ?? undefined,
    format: raw.format,
    turns: raw.turns,
    endReason: raw.end_reason,
    durationMillis: raw.duration_millis,
    battleLog: raw.battle_log,
    p1Stderr: raw.p1_stderr ?? undefined,
    p2Stderr: raw.p2_stderr ?? undefined,
    p1CpuCores: raw.p1_cpu_cores ?? undefined,
    p2CpuCores: raw.p2_cpu_cores ?? undefined,
    p1PeakRam: raw.p1_peak_ram ?? undefined,
    p2PeakRam: raw.p2_peak_ram ?? undefined,
    infoStatus: raw.info_status,
    createdAt: raw.created_at,
  };
}

function mapSummary(raw: RawSummaryRow): Summary {
  const hasP1Stderr = raw.has_p1_stderr === 1;
  const hasP2Stderr = raw.has_p2_stderr === 1;
  return {
    id: raw.id,
    versionId: raw.version_id,
    ladderId: raw.ladder_id ?? undefined,
    tournamentId: raw.tournament_id ?? undefined,
    format: raw.format,
    turns: raw.turns,
    endReason: raw.end_reason,
    durationMillis: raw.duration_millis,
    hasLog: raw.has_log === 1,
    hasStderr: hasP1Stderr || hasP2Stderr,
    hasP1Stderr,
    hasP2Stderr,
    infoStatus: raw.info_status,
    p1CpuCores: raw.p1_cpu_cores ?? undefined,
    p2CpuCores: raw.p2_cpu_cores ?? undefined,
    p1PeakRam: raw.p1_peak_ram ?? undefined,
    p2PeakRam: raw.p2_peak_ram ?? undefined,
    createdAt: raw.created_at,
  };
}

export function replaceForVersion(
  db: DatabaseSync,
  versionId: number,
  diagnostics: readonly Input[],
  now: number
) {
  db.prepare('DELETE FROM smoke_diagnostics WHERE version_id = ?').run(versionId);
  if (!diagnostics.length) return;
  const insert = db.prepare(`
    INSERT INTO smoke_diagnostics (
      version_id, ladder_id, tournament_id, format, turns, end_reason, duration_millis,
      battle_log, p1_stderr, p2_stderr, p1_cpu_cores, p2_cpu_cores,
      p1_peak_ram, p2_peak_ram, info_status, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const d of diagnostics) {
    insert.run(
      versionId,
      d.ladderId ?? null,
      d.tournamentId ?? null,
      d.format,
      d.turns,
      d.endReason,
      d.durationMillis,
      d.battleLog,
      d.p1Stderr && d.p1Stderr.length > 0 ? d.p1Stderr : null,
      d.p2Stderr && d.p2Stderr.length > 0 ? d.p2Stderr : null,
      d.p1CpuCores ?? null,
      d.p2CpuCores ?? null,
      d.p1PeakRam ?? null,
      d.p2PeakRam ?? null,
      d.infoStatus ?? 'none',
      now
    );
  }
}

export function getForVersion(db: DatabaseSync, versionId: number): Row[] {
  const rows = db.prepare(`
    SELECT sd.*, av.agent_id, av.version
    FROM smoke_diagnostics sd
    JOIN agent_versions av ON av.id = sd.version_id
    WHERE sd.version_id = ?
    ORDER BY sd.id ASC
  `).all(versionId) as unknown as RawRow[];
  return rows.map(mapRow);
}

export function getSummariesForAgent(db: DatabaseSync, agentId: number): Map<number, Summary[]> {
  const rows = db.prepare(`
    SELECT
      sd.id,
      sd.version_id,
      sd.ladder_id,
      sd.tournament_id,
      sd.format,
      sd.turns,
      sd.end_reason,
      sd.duration_millis,
      CASE WHEN sd.battle_log != '' THEN 1 ELSE 0 END AS has_log,
      CASE WHEN sd.p1_stderr != '' THEN 1 ELSE 0 END AS has_p1_stderr,
      CASE WHEN sd.p2_stderr != '' THEN 1 ELSE 0 END AS has_p2_stderr,
      sd.info_status,
      sd.p1_cpu_cores,
      sd.p2_cpu_cores,
      sd.p1_peak_ram,
      sd.p2_peak_ram,
      sd.created_at
    FROM smoke_diagnostics sd
    JOIN agent_versions av ON av.id = sd.version_id
    WHERE av.agent_id = ?
    ORDER BY sd.version_id DESC, sd.id ASC
  `).all(agentId) as unknown as RawSummaryRow[];

  const byVersion = new Map<number, Summary[]>();
  for (const row of rows) {
    const summary = mapSummary(row);
    const list = byVersion.get(summary.versionId) ?? [];
    list.push(summary);
    byVersion.set(summary.versionId, list);
  }
  return byVersion;
}

export function getById(db: DatabaseSync, id: number): Row | undefined {
  const row = db.prepare(`
    SELECT sd.*, av.agent_id, av.version
    FROM smoke_diagnostics sd
    JOIN agent_versions av ON av.id = sd.version_id
    WHERE sd.id = ?
  `).get(id) as unknown as RawRow | undefined;
  return row ? mapRow(row) : undefined;
}
