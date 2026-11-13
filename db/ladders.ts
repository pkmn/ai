import * as fs from 'fs';
import {DatabaseSync} from 'node:sqlite';

import * as yaml from 'yaml';

import {root} from '../static/util';

import {countLadderTeams} from './ladder-teams';

import {TransactionRunner} from './index';

export type LadderSlot = 'rby' | 'adv' | 'sv' | 'rand' | 'vgc';
export type TeamMode = 'harvested' | 'random' | 'pools';
export type LadderStatus = 'upcoming' | 'active' | 'settling' | 'archived';

export const LADDERS_FILE = process.env.MOCK === '1'
  ? root('.mock', 'ladders.yml')
  : root('config', 'ladders.yml');

export const SLOTS = new Set<LadderSlot>(['rby', 'adv', 'sv', 'rand', 'vgc']);
export const TEAM_MODES = new Set<TeamMode>(['harvested', 'random', 'pools']);
export const LADDER_STATUSES = new Set<LadderStatus>([
  'upcoming', 'active', 'settling', 'archived',
]);

export const SLOT_ORDER_SQL = `
  CASE slot
    WHEN 'rby' THEN 0
    WHEN 'adv' THEN 1
    WHEN 'sv' THEN 2
    WHEN 'rand' THEN 3
    WHEN 'vgc' THEN 4
    ELSE 5
  END
`;

// Canonical field order mirrors config/ladders.yml.
export interface LadderConfig {
  name: string;
  format: string;
  id: string;
  discord?: string;
  team: TeamMode;
  status?: LadderStatus;
  min?: number;
  teams?: number;
  pools?: string[];
}

export interface LadderRow {
  id: string;
  slot: LadderSlot;
  name: string;
  format: string;
  team: TeamMode;
  min: number;
  teams?: number;
  discord?: string;
  status: LadderStatus;
  createdAt: number;
  archivedAt?: number;
}

export interface RotateLadderInput {
  oldLadderId: string;
  archivedName: string;
  newLadderId?: string;
  newName?: string;
  newFormat?: string;
  newTeam?: TeamMode;
  newMin?: number;
  newTeams?: number;
  newDiscord?: string;
  now?: number;
}

interface RawLadderRow {
  id: string;
  slot: LadderSlot;
  name: string;
  format: string;
  team: TeamMode;
  min: number;
  teams: number | null;
  discord: string | null;
  status: LadderStatus;
  created_at: number;
  archived_at: number | null;
}

function mapLadderRow(raw: RawLadderRow): LadderRow {
  return {
    id: raw.id,
    slot: raw.slot,
    name: raw.name,
    format: raw.format,
    team: raw.team,
    min: raw.min,
    teams: raw.teams ?? undefined,
    discord: raw.discord ?? undefined,
    status: raw.status,
    createdAt: raw.created_at,
    archivedAt: raw.archived_at ?? undefined,
  };
}

// Infers the canonical URL slot ('rby' | 'adv' | 'sv' | 'rand' | 'vgc') from a ladder's display
// name ('VGC' or an archived season title such as 'VGC 2026 Reg M-C') so config/ladders.yml does
// not need a redundant `slot` key.
export function inferLadderSlot(name: string): LadderSlot {
  const token = name.trim().split(/\s+/)[0]?.toLowerCase() as LadderSlot;
  if (!SLOTS.has(token)) {
    throw new Error(`Cannot infer valid ladder slot from name "${name}"`);
  }
  return token;
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
    const name = entry?.name?.trim();
    const format = entry?.format?.trim();
    const team = entry?.team;
    const status = entry?.status ?? 'active';
    const min = entry?.min ?? (team === 'pools' ? 4 : 2);

    if (!id || !name || !format) {
      throw new Error(`Invalid ladder entry in ladders.yml: ${JSON.stringify(entry)}`);
    }
    const slot = inferLadderSlot(name);
    if (!TEAM_MODES.has(team)) {
      throw new Error(`Invalid team mode "${String(team)}" for "${id}"`);
    }
    if (!LADDER_STATUSES.has(status)) {
      throw new Error(`Invalid ladder status "${String(status)}" for "${id}"`);
    }
    // `pools` ladders require >= 4 distinct active agents so every agent's submitted pool can be
    // sampled with exact uniform probability `2 / N` while keeping `X_A + X_B <= 1` (`4 / N <= 1`).
    if (!Number.isInteger(min) || min < 2 || (team === 'pools' && min < 4)) {
      throw new Error(`Invalid min "${String(min)}" for "${id}"`);
    }
    if (team === 'pools') {
      if (!Number.isInteger(entry.teams) || entry.teams! < 1) {
        throw new Error(`pools ladder "${id}" must specify a positive teams count`);
      }
    } else if (entry.teams !== undefined) {
      throw new Error(`teams is only valid on pools ladders ("${id}")`);
    }
    if (
      entry.discord !== undefined &&
      (typeof entry.discord !== 'string' || !/^\d+$/.test(entry.discord.trim()))
    ) {
      throw new Error(`Invalid discord role "${String(entry.discord)}" for "${id}"`);
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

export function loadLadderPools(file = LADDERS_FILE): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!fs.existsSync(file)) return out;
  const entries = parseLaddersYaml(fs.readFileSync(file, 'utf8'));
  for (const entry of entries) {
    if (Array.isArray(entry.pools) && entry.pools.length) {
      out.set(entry.id, entry.pools.map(p => root(p)));
    }
  }
  return out;
}

export function syncLaddersFromYaml(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  laddersYaml: string,
  now = Math.floor(Date.now() / 1000)
) {
  const configs = parseLaddersYaml(laddersYaml);
  const selectExisting = db.prepare('SELECT status, archived_at FROM ladders WHERE id = ?');
  const upsert = db.prepare(`
    INSERT INTO ladders (
      id, slot, name, format, team, min,
      teams, discord, status, created_at, archived_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      slot = excluded.slot,
      name = excluded.name,
      format = excluded.format,
      team = excluded.team,
      min = excluded.min,
      teams = excluded.teams,
      discord = excluded.discord,
      status = excluded.status,
      archived_at = excluded.archived_at
  `);

  inTransaction(() => {
    for (const cfg of configs) {
      const existing = selectExisting.get(cfg.id) as {
        status: LadderStatus;
        archived_at: number | null;
      } | undefined;
      let status: LadderStatus = cfg.status ?? 'active';
      // If a settling season already finished settling and transitioned to 'archived' in SQLite,
      // do not regress it back to 'settling' on server restart before ladders.yml is updated.
      // Likewise, do not downgrade an already activated/settling/archived ladder back to 'upcoming'
      // if config/ladders.yml still lists `status: upcoming`.
      if (existing?.status === 'archived' && status === 'settling') {
        status = 'archived';
      } else if (existing && existing.status !== 'upcoming' && status === 'upcoming') {
        status = existing.status;
      }
      const slot = inferLadderSlot(cfg.name);
      const min = cfg.min ?? (cfg.team === 'pools' ? 4 : 2);
      const teams = cfg.teams ?? null;
      const discord = cfg.discord?.trim() || null;
      const archivedAt = status === 'archived'
        ? (existing?.archived_at ?? now)
        : null;
      upsert.run(
        cfg.id,
        slot,
        cfg.name.trim(),
        cfg.format.trim(),
        cfg.team,
        min,
        teams,
        discord,
        status,
        now,
        archivedAt
      );
    }
  });
}

export function syncLadders(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  file = LADDERS_FILE,
  now = Math.floor(Date.now() / 1000)
) {
  if (!fs.existsSync(file)) return;
  syncLaddersFromYaml(db, inTransaction, fs.readFileSync(file, 'utf8'), now);
}

export function getLadders(db: DatabaseSync): LadderRow[] {
  const rows = db.prepare(
    `SELECT * FROM ladders ORDER BY ${SLOT_ORDER_SQL} ASC, created_at ASC, id ASC`
  ).all() as unknown as RawLadderRow[];
  return rows.map(mapLadderRow);
}

export function getCurrentLadders(db: DatabaseSync): LadderRow[] {
  const rows = db.prepare(
    `SELECT * FROM ladders
     WHERE status IN ('upcoming', 'active')
     ORDER BY ${SLOT_ORDER_SQL} ASC, created_at ASC, id ASC`
  ).all() as unknown as RawLadderRow[];
  return rows.map(mapLadderRow);
}

export function getActiveLadders(db: DatabaseSync): LadderRow[] {
  const rows = db.prepare(
    `SELECT * FROM ladders
     WHERE status = 'active'
     ORDER BY ${SLOT_ORDER_SQL} ASC, created_at ASC, id ASC`
  ).all() as unknown as RawLadderRow[];
  return rows.map(mapLadderRow);
}

export function getPlayableLadders(db: DatabaseSync): LadderRow[] {
  const rows = db.prepare(
    `SELECT * FROM ladders
     WHERE status IN ('active', 'settling')
     ORDER BY ${SLOT_ORDER_SQL} ASC, created_at ASC, id ASC`
  ).all() as unknown as RawLadderRow[];
  return rows.map(mapLadderRow);
}

export function getLadder(db: DatabaseSync, id: string): LadderRow | undefined {
  const raw = db.prepare('SELECT * FROM ladders WHERE id = ?')
    .get(id) as unknown as RawLadderRow | undefined;
  return raw ? mapLadderRow(raw) : undefined;
}

export function getActiveLadderBySlot(db: DatabaseSync, slot: LadderSlot): LadderRow | undefined {
  const raw = db.prepare("SELECT * FROM ladders WHERE slot = ? AND status = 'active'")
    .get(slot) as unknown as RawLadderRow | undefined;
  return raw ? mapLadderRow(raw) : undefined;
}

export function validateLadderActivation(db: DatabaseSync, ladder: LadderRow): void {
  if (ladder.team === 'harvested' && countLadderTeams(db, ladder.id) < 2) {
    throw new Error(
      `Cannot activate harvested ladder "${ladder.id}": harvested teams have not been uploaded yet.`
    );
  }

  const requiredMin = Math.max(ladder.team === 'pools' ? 4 : 2, ladder.min);
  const activeCount = countDistinctActiveLadderAgents(db, ladder.id);
  if (activeCount < requiredMin) {
    throw new Error(
      `Cannot activate ladder "${ladder.id}": requires at least ${requiredMin} ` +
      `distinct active entries (found ${activeCount}).`
    );
  }

  const anchor = db.prepare(`
    SELECT 1
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
    JOIN agents a ON a.id = av.agent_id
    WHERE le.ladder_id = ?
      AND le.is_anchor = 1
      AND le.role IN ('champion', 'challenger')
      AND av.smoke_status = 'passed'
      AND a.status != 'disabled'
    LIMIT 1
  `).get(ladder.id);
  if (!anchor) {
    throw new Error(
      `Cannot activate ladder "${ladder.id}": no active 1500-Elo anchor entry has been set.`
    );
  }
}

export function setLadderStatus(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  ladderId: string,
  status: LadderStatus,
  now = Math.floor(Date.now() / 1000)
): LadderRow {
  if (!LADDER_STATUSES.has(status)) {
    throw new Error(`Invalid ladder status "${status}"`);
  }
  return inTransaction(() => {
    const ladder = getLadder(db, ladderId);
    if (!ladder) throw new Error(`Ladder "${ladderId}" not found`);

    if (status === 'active' || status === 'upcoming') {
      const conflict = db.prepare(`
        SELECT id FROM ladders
        WHERE slot = ? AND id != ? AND status IN ('upcoming', 'active')
      `).get(ladder.slot, ladderId) as {id: string} | undefined;
      if (conflict) {
        throw new Error(`Slot "${ladder.slot}" already has current ladder "${conflict.id}"`);
      }
    }

    if (status === 'active') {
      validateLadderActivation(db, ladder);
    }

    const archivedAt = status === 'archived' ? (ladder.archivedAt ?? now) : null;
    db.prepare('UPDATE ladders SET status = ?, archived_at = ? WHERE id = ?')
      .run(status, archivedAt, ladderId);

    if (status === 'archived') {
      db.prepare(`
        UPDATE ladder_entries
        SET role = 'retired', retired_at = ?
        WHERE ladder_id = ? AND role IN ('champion', 'challenger')
      `).run(now, ladderId);
    }

    return getLadder(db, ladderId)!;
  });
}

export function countDistinctActiveLadderAgents(db: DatabaseSync, ladderId: string): number {
  const ladder = getLadder(db, ladderId);
  if (!ladder) return 0;
  if (ladder.team === 'pools') {
    const row = db.prepare(`
      SELECT COUNT(DISTINCT av.agent_id) AS cnt
      FROM ladder_entries le
      JOIN agent_versions av ON av.id = le.version_id
      JOIN agents a ON a.id = av.agent_id
      WHERE le.ladder_id = ?
        AND le.role IN ('champion', 'challenger')
        AND av.smoke_status = 'passed'
        AND a.status != 'disabled'
        AND EXISTS (
          SELECT 1 FROM agent_ladder_teams alt
          WHERE alt.ladder_id = le.ladder_id
            AND alt.agent_id = av.agent_id
            AND alt.status = 'active'
        )
    `).get(ladderId) as {cnt: number};
    return row.cnt;
  }
  const row = db.prepare(`
    SELECT COUNT(DISTINCT av.agent_id) AS cnt
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
    JOIN agents a ON a.id = av.agent_id
    WHERE le.ladder_id = ?
      AND le.role IN ('champion', 'challenger')
      AND av.smoke_status = 'passed'
      AND a.status != 'disabled'
  `).get(ladderId) as {cnt: number};
  return row.cnt;
}

export function canSettleLadder(db: DatabaseSync, ladder: LadderRow): boolean {
  const minActiveAgents = ladder.status === 'settling' ? 2 : Math.max(2, ladder.min);
  if (countDistinctActiveLadderAgents(db, ladder.id) < minActiveAgents) {
    return false;
  }
  if (ladder.status === 'settling' && ladder.team === 'pools') {
    const poolRow = db.prepare(`
      SELECT COUNT(DISTINCT alt.agent_id) AS cnt
      FROM agent_ladder_teams alt
      WHERE alt.ladder_id = ? AND alt.status = 'active'
    `).get(ladder.id) as {cnt: number};
    if (poolRow.cnt < Math.max(2, ladder.min)) {
      return false;
    }
  }
  const unsettled = db.prepare(`
    SELECT 1
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
    JOIN agents a ON a.id = av.agent_id
    WHERE le.ladder_id = ?
      AND le.role IN ('champion', 'challenger')
      AND av.smoke_status = 'passed'
      AND a.status != 'disabled'
      AND le.settled_at IS NULL
    LIMIT 1
  `).get(ladder.id);
  return unsettled !== undefined;
}

export function archiveLadderInPlace(db: DatabaseSync, ladderId: string, now: number): void {
  db.prepare(`
    UPDATE ladders
    SET status = 'archived', archived_at = COALESCE(archived_at, ?)
    WHERE id = ?
  `).run(now, ladderId);
  db.prepare(`
    UPDATE ladder_entries
    SET role = 'retired', retired_at = ?
    WHERE ladder_id = ? AND role IN ('champion', 'challenger')
  `).run(now, ladderId);
}

// Rotates a seasonal regulation (e.g. VGC Reg M-C -> Reg M-D) without losing historical matches or
// ratings: if `>= min` distinct active projects remain on `oldLadderId` and still have unsettled
// ratings (`settled_at IS NULL`), the outgoing season enters `'settling'` so in-flight competitors
// finish their 25-match / SE <= 30 settlement before freezing into `'archived'`.
export function rotateLadder(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  input: RotateLadderInput
): {oldLadder: LadderRow; newLadder?: LadderRow} {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  return inTransaction(() => {
    const oldLadder = getLadder(db, input.oldLadderId);
    if (!oldLadder) {
      throw new Error(`Ladder "${input.oldLadderId}" not found`);
    }

    const nextOldStatus: LadderStatus = canSettleLadder(db, oldLadder) ? 'settling' : 'archived';
    const archivedAt = nextOldStatus === 'archived' ? (oldLadder.archivedAt ?? now) : null;

    db.prepare(`
      UPDATE ladders
      SET name = ?, status = ?, archived_at = ?
      WHERE id = ?
    `).run(input.archivedName.trim(), nextOldStatus, archivedAt, oldLadder.id);

    if (nextOldStatus === 'archived') {
      db.prepare(`
        UPDATE ladder_entries
        SET role = 'retired', retired_at = ?
        WHERE ladder_id = ? AND role IN ('champion', 'challenger')
      `).run(now, oldLadder.id);
    }

    let newLadder: LadderRow | undefined;
    if (input.newLadderId) {
      const newId = input.newLadderId.trim();
      const existingNew = getLadder(db, newId);
      if (existingNew) {
        if (existingNew.status === 'archived') {
          db.prepare("UPDATE ladders SET status = 'upcoming', archived_at = NULL WHERE id = ?")
            .run(newId);
        }
      } else {
        const team = input.newTeam ?? oldLadder.team;
        const min = input.newMin ?? oldLadder.min;
        const teams = input.newTeams !== undefined
          ? input.newTeams
          : (team === 'pools' ? (oldLadder.teams ?? 20) : undefined);
        const discord = input.newDiscord !== undefined
          ? input.newDiscord
          : oldLadder.discord;
        const name = input.newName?.trim() || oldLadder.slot.toUpperCase();
        const format = input.newFormat?.trim() || oldLadder.format;

        db.prepare(`
          INSERT INTO ladders (
            id, slot, name, format, team,
            min, teams, discord, status, created_at, archived_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'upcoming', ?, NULL)
        `).run(
          newId,
          oldLadder.slot,
          name,
          format,
          team,
          min,
          teams ?? null,
          discord ?? null,
          now
        );
      }
      newLadder = getLadder(db, newId)!;
    }

    return {oldLadder: getLadder(db, oldLadder.id)!, newLadder};
  });
}
