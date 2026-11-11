import * as fs from 'fs';
import type {DatabaseSync} from 'node:sqlite';

import * as yaml from 'yaml';

import {root} from '../static/util';

import type {TransactionRunner} from './index';

export type LadderSlot = 'rby' | 'adv' | 'sv' | 'rand' | 'vgc';
export type TeamMode = 'harvested' | 'random' | 'competitor_pool';
export type LadderStatus = 'upcoming' | 'active' | 'settling' | 'archived';

export const LADDERS_FILE = root('config', 'ladders.yml');

export const SLOTS = new Set<LadderSlot>(['rby', 'adv', 'sv', 'rand', 'vgc']);
export const TEAM_MODES = new Set<TeamMode>(['harvested', 'random', 'competitor_pool']);
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

export interface LadderConfig {
  id: string;
  slot: LadderSlot;
  display_name: string;
  format_id: string;
  team_mode: TeamMode;
  min_bots?: number;
  team_count?: number;
  discord_role?: string;
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
  discord_role: string | null;
  status: LadderStatus;
  created_at: number;
  archived_at: number | null;
}

export interface RotateLadderInput {
  oldLadderId: string;
  archivedDisplayName: string;
  newLadderId?: string;
  newDisplayName?: string;
  newFormatId?: string;
  newTeamMode?: TeamMode;
  newMinBots?: number;
  newTeamCount?: number | null;
  newDiscordRole?: string | null;
  now?: number;
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
    if (
      entry.discord_role !== undefined &&
      (typeof entry.discord_role !== 'string' || !/^\d+$/.test(entry.discord_role.trim()))
    ) {
      throw new Error(`Invalid discord_role "${String(entry.discord_role)}" for "${id}"`);
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
      id, slot, display_name, format_id, team_mode, min_bots,
      team_count, discord_role, status, created_at, archived_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      slot = excluded.slot,
      display_name = excluded.display_name,
      format_id = excluded.format_id,
      team_mode = excluded.team_mode,
      min_bots = excluded.min_bots,
      team_count = excluded.team_count,
      discord_role = excluded.discord_role,
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
      if (existing?.status === 'archived' && status === 'settling') {
        status = 'archived';
      }
      const minBots = cfg.min_bots ?? (cfg.team_mode === 'competitor_pool' ? 3 : 2);
      const teamCount = cfg.team_count ?? null;
      const discordRole = cfg.discord_role?.trim() || null;
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
        discordRole,
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
  return db.prepare(
    `SELECT * FROM ladders ORDER BY ${SLOT_ORDER_SQL} ASC, created_at ASC, id ASC`
  ).all() as unknown as LadderRow[];
}

export function getCurrentLadders(db: DatabaseSync): LadderRow[] {
  return db.prepare(
    `SELECT * FROM ladders
     WHERE status IN ('upcoming', 'active')
     ORDER BY ${SLOT_ORDER_SQL} ASC, created_at ASC, id ASC`
  ).all() as unknown as LadderRow[];
}

export function getActiveLadders(db: DatabaseSync): LadderRow[] {
  return db.prepare(
    `SELECT * FROM ladders
     WHERE status = 'active'
     ORDER BY ${SLOT_ORDER_SQL} ASC, created_at ASC, id ASC`
  ).all() as unknown as LadderRow[];
}

export function getPlayableLadders(db: DatabaseSync): LadderRow[] {
  return db.prepare(
    `SELECT * FROM ladders
     WHERE status IN ('active', 'settling')
     ORDER BY ${SLOT_ORDER_SQL} ASC, created_at ASC, id ASC`
  ).all() as unknown as LadderRow[];
}

export function getLadder(db: DatabaseSync, id: string): LadderRow | undefined {
  return db.prepare('SELECT * FROM ladders WHERE id = ?')
    .get(id) as unknown as LadderRow | undefined;
}

export function getActiveLadderBySlot(db: DatabaseSync, slot: LadderSlot): LadderRow | undefined {
  return db.prepare("SELECT * FROM ladders WHERE slot = ? AND status = 'active'")
    .get(slot) as unknown as LadderRow | undefined;
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

    const archivedAt = status === 'archived' ? (ladder.archived_at ?? now) : null;
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

    const unsettled = db.prepare(`
      SELECT 1 FROM ladder_entries
      WHERE ladder_id = ?
        AND role IN ('champion', 'challenger')
        AND settled_at IS NULL
      LIMIT 1
    `).get(oldLadder.id);

    const nextOldStatus: LadderStatus = unsettled ? 'settling' : 'archived';
    const archivedAt = nextOldStatus === 'archived' ? (oldLadder.archived_at ?? now) : null;

    db.prepare(`
      UPDATE ladders
      SET display_name = ?, status = ?, archived_at = ?
      WHERE id = ?
    `).run(input.archivedDisplayName.trim(), nextOldStatus, archivedAt, oldLadder.id);

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
        db.prepare("UPDATE ladders SET status = 'active', archived_at = NULL WHERE id = ?")
          .run(newId);
      } else {
        const teamMode = input.newTeamMode ?? oldLadder.team_mode;
        const minBots = input.newMinBots ?? oldLadder.min_bots;
        const teamCount = input.newTeamCount !== undefined
          ? input.newTeamCount
          : (teamMode === 'competitor_pool' ? (oldLadder.team_count ?? 20) : null);
        const discordRole = input.newDiscordRole !== undefined
          ? input.newDiscordRole
          : oldLadder.discord_role;
        const displayName = input.newDisplayName?.trim() || oldLadder.slot.toUpperCase();
        const formatId = input.newFormatId?.trim() || oldLadder.format_id;

        db.prepare(`
          INSERT INTO ladders (
            id, slot, display_name, format_id, team_mode,
            min_bots, team_count, discord_role, status, created_at, archived_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)
        `).run(
          newId,
          oldLadder.slot,
          displayName,
          formatId,
          teamMode,
          minBots,
          teamCount,
          discordRole,
          now
        );
      }
      newLadder = getLadder(db, newId)!;
    }

    return {oldLadder: getLadder(db, oldLadder.id)!, newLadder};
  });
}
