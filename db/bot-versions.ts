import type {DatabaseSync} from 'node:sqlite';

import {ensureBotLadderStats} from './bot-ladder-stats';
import {
  deletePendingTeams,
  getTeamsForBotLadder,
  promotePendingTeams,
  replacePendingTeams,
} from './bot-ladder-teams';
import {type BotRow, getBotById} from './bots';
import {
  type EntryRole,
  getActiveEntriesForBot,
  promoteRemainingActiveToChampion,
  recomputeLadderRatings,
} from './ladder-entries';
import {getActiveLadders, getLadder} from './ladders';

import type {TransactionRunner} from './index';

export type FormatType = 'bundle' | 'oci';
export type SmokeStatus = 'pending_pull' | 'passed' | 'failed_smoke_test' | 'quarantined';
export type AccountStatusLabel = 'Pending' | 'Qualified' | 'Eligible' | 'Ineligible';

export const COOLDOWN_S = 14 * 24 * 60 * 60;
export const SETTLED_MAX_SE = 30;
export const SETTLED_MIN_MATCHES = 25;

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

export interface PendingSubmissionRow {
  version_id: number;
  bot_id: number;
  bot_slug: string;
  bot_name: string;
  version_str: string;
  format_type: FormatType;
  download_url: string;
  sha256: string;
  auth_token_enc: string | null;
  ladders: string[];
  teams_by_ladder: Record<string, string[]>;
}

export interface ApplySubmissionStatusInput {
  versionId: number;
  smokeStatus: Exclude<SmokeStatus, 'pending_pull'>;
  unpackedBytes?: number | null;
  smokeDurationMs?: number | null;
  smokeTurnMs?: number | null;
  smokePeakRamMb?: number | null;
  smokeErrorLog?: string | null;
  retiredVersionIdsByLadder?: Record<string, number>;
  now?: number;
}

export interface ApplySubmissionStatusResult {
  version: BotVersionRow;
  bot: BotRow;
  retiredByLadder: Record<string, number>;
}

export interface PendingVersionDmRow {
  version_id: number;
  bot_id: number;
  bot_slug: string;
  bot_name: string;
  version_str: string;
  smoke_status: 'failed_smoke_test' | 'quarantined';
  smoke_error_log: string | null;
  ladders_json: string;
  created_at: number;
  owner_discord_ids: string[];
}

export function getVersionById(db: DatabaseSync, versionId: number): BotVersionRow | undefined {
  return db.prepare('SELECT * FROM bot_versions WHERE id = ?')
    .get(versionId) as unknown as BotVersionRow | undefined;
}

export function getVersionBySlugAndStr(
  db: DatabaseSync,
  botSlug: string,
  versionStr: string
): (BotVersionRow & {bot_slug: string; bot_name: string}) | undefined {
  return db.prepare(`
    SELECT bv.*, b.slug AS bot_slug, b.name AS bot_name
    FROM bot_versions bv
    JOIN bots b ON b.id = bv.bot_id
    WHERE b.slug = ? AND bv.version_str = ?
  `).get(botSlug.trim().toLowerCase(), versionStr.trim()) as unknown as (
    BotVersionRow & {bot_slug: string; bot_name: string}
  ) | undefined;
}

export function getVersionsForBot(db: DatabaseSync, botId: number): VersionHistoryView[] {
  const versions = db.prepare(
    'SELECT * FROM bot_versions WHERE bot_id = ? ORDER BY created_at DESC, id DESC'
  ).all(botId) as unknown as BotVersionRow[];

  const activeRows = db.prepare(`
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

export function computeBotSubmissionStatus(
  db: DatabaseSync,
  botId: number,
  now = Math.floor(Date.now() / 1000)
): SubmissionStatus {
  const bot = getBotById(db, botId);
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

  const openLadders = getActiveLadders(db);
  if (!openLadders.length) {
    return {
      label: 'Qualified',
      canSubmit: false,
      reason: 'Ladders are not open for submissions yet.',
    };
  }

  const pendingRow = db.prepare(
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
  const latestPassed = db.prepare(
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

  const activeEntries = getActiveEntriesForBot(db, botId);
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

export function createSubmission(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  input: CreateSubmissionInput
): BotVersionRow {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  return inTransaction(() => {
    const existing = db.prepare(
      'SELECT id FROM bot_versions WHERE bot_id = ? AND version_str = ?'
    ).get(input.botId, input.versionStr) as {id: number} | undefined;
    if (existing) {
      throw Object.assign(
        new Error(`Version "${input.versionStr}" already exists for this project.`),
        {status: 409}
      );
    }

    const status = computeBotSubmissionStatus(db, input.botId, now);
    if (!status.canSubmit) {
      const code = status.label === 'Pending' || status.label === 'Qualified' ? 403 : 429;
      throw Object.assign(
        new Error(status.reason ?? 'Project is not currently eligible to submit.'),
        {status: code}
      );
    }

    const res = db.prepare(`
      INSERT INTO bot_versions (
        bot_id, submitted_by_dev_id, version_str, format_type, download_url,
        sha256, auth_token_enc, ladders_json, smoke_status, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_pull', ?)
    `).run(
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
      replacePendingTeams(db, input.botId, input.teamsByLadder, now);
    }

    return getVersionById(db, versionId)!;
  });
}

export function getPendingSubmissions(db: DatabaseSync): PendingSubmissionRow[] {
  const rows = db.prepare(`
    SELECT bv.*, b.slug AS bot_slug, b.name AS bot_name
    FROM bot_versions bv
    JOIN bots b ON b.id = bv.bot_id
    WHERE bv.smoke_status = 'pending_pull'
    ORDER BY bv.created_at ASC, bv.id ASC
  `).all() as unknown as Array<BotVersionRow & {bot_slug: string; bot_name: string}>;

  return rows.map(row => {
    const ladders = JSON.parse(row.ladders_json) as string[];
    const teamsByLadder: Record<string, string[]> = {};
    for (const ladderId of ladders) {
      const pendingTeams = getTeamsForBotLadder(db, ladderId, row.bot_id, 'pending');
      if (pendingTeams.length > 0) {
        teamsByLadder[ladderId] = pendingTeams;
      }
    }
    return {
      version_id: row.id,
      bot_id: row.bot_id,
      bot_slug: row.bot_slug,
      bot_name: row.bot_name,
      version_str: row.version_str,
      format_type: row.format_type,
      download_url: row.download_url,
      sha256: row.sha256,
      auth_token_enc: row.auth_token_enc,
      ladders,
      teams_by_ladder: teamsByLadder,
    };
  });
}

export function applySubmissionStatus(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  input: ApplySubmissionStatusInput
): ApplySubmissionStatusResult {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  return inTransaction(() => {
    const prev = getVersionById(db, input.versionId);
    if (!prev) {
      throw Object.assign(new Error(`Unknown version_id ${input.versionId}`), {status: 404});
    }
    const bot = getBotById(db, prev.bot_id)!;
    const shouldResetDm = (
      (input.smokeStatus === 'failed_smoke_test' || input.smokeStatus === 'quarantined') &&
      prev.smoke_status !== input.smokeStatus
    );

    db.prepare(`
      UPDATE bot_versions
      SET auth_token_enc = NULL,
          smoke_status = ?,
          unpacked_bytes = COALESCE(?, unpacked_bytes),
          smoke_duration_ms = COALESCE(?, smoke_duration_ms),
          smoke_turn_ms = COALESCE(?, smoke_turn_ms),
          smoke_peak_ram_mb = COALESCE(?, smoke_peak_ram_mb),
          smoke_error_log = ?,
          dm_sent = CASE WHEN ? = 1 THEN 0 ELSE dm_sent END
      WHERE id = ?
    `).run(
      input.smokeStatus,
      input.unpackedBytes ?? null,
      input.smokeDurationMs ?? null,
      input.smokeTurnMs ?? null,
      input.smokePeakRamMb ?? null,
      input.smokeErrorLog !== undefined ? input.smokeErrorLog : prev.smoke_error_log,
      shouldResetDm ? 1 : 0,
      input.versionId
    );

    const ladderIds = JSON.parse(prev.ladders_json) as string[];
    const retiredByLadder: Record<string, number> = {};

    if (input.smokeStatus === 'passed') {
      const retireEntry = db.prepare(`
        UPDATE ladder_entries
        SET role = 'retired',
            retired_at = ?,
            rank_current = NULL,
            rank_min = NULL,
            rank_max = NULL
        WHERE ladder_id = ? AND version_id = ?
      `);
      const selectOtherActive = db.prepare(`
        SELECT le.version_id, le.rating_lcb, le.rating_elo
        FROM ladder_entries le
        JOIN bot_versions bv ON bv.id = le.version_id
        WHERE le.ladder_id = ?
          AND bv.bot_id = ?
          AND le.version_id != ?
          AND le.role IN ('champion', 'challenger')
        ORDER BY le.rating_lcb ASC, le.rating_elo ASC, le.version_id ASC
      `);
      const upsertEntry = db.prepare(`
        INSERT INTO ladder_entries (
          ladder_id, version_id, role, avg_turn_ms, peak_ram_mb
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(ladder_id, version_id) DO UPDATE SET
          role = excluded.role,
          retired_at = NULL,
          avg_turn_ms = CASE
            WHEN ladder_entries.matches_played = 0 THEN excluded.avg_turn_ms
            ELSE ladder_entries.avg_turn_ms
          END,
          peak_ram_mb = MAX(ladder_entries.peak_ram_mb, excluded.peak_ram_mb)
      `);

      if (input.retiredVersionIdsByLadder) {
        for (const [ladderId, retiredId] of Object.entries(input.retiredVersionIdsByLadder)) {
          if (!Number.isInteger(retiredId) || retiredId === prev.id) continue;
          const target = getVersionById(db, retiredId);
          if (target?.bot_id !== prev.bot_id) continue;
          const info = retireEntry.run(now, ladderId, retiredId);
          if (info.changes > 0) retiredByLadder[ladderId] = retiredId;
        }
      }

      for (const ladderId of ladderIds) {
        const ladder = getLadder(db, ladderId);
        if (!ladder) continue;
        promotePendingTeams(db, ladderId, prev.bot_id);

        const otherActive = selectOtherActive.all(
          ladderId,
          prev.bot_id,
          prev.id
        ) as Array<{version_id: number; rating_lcb: number; rating_elo: number}>;

        while (otherActive.length >= 2) {
          const weakest = otherActive.shift()!;
          retireEntry.run(now, ladderId, weakest.version_id);
          retiredByLadder[ladderId] = weakest.version_id;
        }

        const role: EntryRole = otherActive.length === 0 ? 'champion' : 'challenger';
        if (otherActive.length === 1) {
          db.prepare(
            "UPDATE ladder_entries SET role = 'champion' WHERE ladder_id = ? AND version_id = ?"
          ).run(ladderId, otherActive[0].version_id);
        }
        upsertEntry.run(
          ladderId,
          prev.id,
          role,
          input.smokeTurnMs ?? 0,
          input.smokePeakRamMb ?? 0
        );
        ensureBotLadderStats(db, ladderId, prev.bot_id);
      }
    } else if (input.smokeStatus === 'failed_smoke_test') {
      deletePendingTeams(db, ladderIds, prev.bot_id);
    } else if (input.smokeStatus === 'quarantined') {
      deletePendingTeams(db, ladderIds, prev.bot_id);
      const affected = db.prepare(`
        SELECT ladder_id FROM ladder_entries
        WHERE version_id = ? AND role IN ('champion', 'challenger')
      `).all(prev.id) as Array<{ladder_id: string}>;
      db.prepare(`
        UPDATE ladder_entries
        SET role = 'quarantined', rank_current = NULL, rank_min = NULL, rank_max = NULL
        WHERE version_id = ? AND role IN ('champion', 'challenger')
      `).run(prev.id);
      for (const row of affected) {
        promoteRemainingActiveToChampion(db, row.ladder_id, prev.bot_id);
      }
    }

    return {version: getVersionById(db, input.versionId)!, bot, retiredByLadder};
  });
}

export function quarantineVersion(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  botSlug: string,
  versionStr: string,
  reason?: string,
  now = Math.floor(Date.now() / 1000)
): ApplySubmissionStatusResult {
  const ver = getVersionBySlugAndStr(db, botSlug, versionStr);
  if (!ver) {
    throw new Error(`Version "${versionStr}" not found for bot "${botSlug}"`);
  }
  return applySubmissionStatus(db, inTransaction, {
    versionId: ver.id,
    smokeStatus: 'quarantined',
    smokeErrorLog: reason ?? ver.smoke_error_log,
    now,
  });
}

export function unquarantineVersion(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  botSlug: string,
  versionStr: string,
  now = Math.floor(Date.now() / 1000)
): BotVersionRow {
  return inTransaction(() => {
    const ver = getVersionBySlugAndStr(db, botSlug, versionStr);
    if (!ver) {
      throw new Error(`Version "${versionStr}" not found for bot "${botSlug}"`);
    }

    db.prepare(
      "UPDATE bot_versions SET smoke_status = 'passed', smoke_error_log = NULL WHERE id = ?"
    ).run(ver.id);

    const quarantinedRows = db.prepare(`
      SELECT ladder_id FROM ladder_entries
      WHERE version_id = ? AND role = 'quarantined'
    `).all(ver.id) as Array<{ladder_id: string}>;

    const ladderIds = quarantinedRows.length > 0
      ? quarantinedRows.map(r => r.ladder_id)
      : (JSON.parse(ver.ladders_json) as string[]);

    for (const ladderId of ladderIds) {
      const ladder = getLadder(db, ladderId);
      if (!ladder) continue;
      const otherActive = db.prepare(`
        SELECT le.version_id
        FROM ladder_entries le
        JOIN bot_versions bv ON bv.id = le.version_id
        WHERE le.ladder_id = ?
          AND bv.bot_id = ?
          AND le.version_id != ?
          AND le.role IN ('champion', 'challenger')
      `).all(ladderId, ver.bot_id, ver.id) as Array<{version_id: number}>;

      const nextRole: EntryRole = otherActive.length >= 2
        ? 'retired'
        : otherActive.length === 1
          ? 'challenger'
          : 'champion';
      const retiredAt = nextRole === 'retired' ? now : null;

      db.prepare(`
        INSERT INTO ladder_entries (ladder_id, version_id, role, retired_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(ladder_id, version_id) DO UPDATE SET
          role = excluded.role,
          retired_at = excluded.retired_at,
          crashes = 0,
          timeouts = 0,
          ooms = 0
      `).run(ladderId, ver.id, nextRole, retiredAt);

      ensureBotLadderStats(db, ladderId, ver.bot_id);

      if (nextRole !== 'retired' && ladder.status !== 'archived') {
        const dayUtc = new Date(now * 1000).toISOString().slice(0, 10);
        recomputeLadderRatings(db, ladderId, now, null, dayUtc);
      }
    }

    return getVersionById(db, ver.id)!;
  });
}

export function getVersionOwnerDiscordIds(
  db: DatabaseSync,
  botId: number,
  submittedByDevId: number | null = null
): string[] {
  const rows = db.prepare(`
    SELECT discord_id
    FROM developers
    WHERE bot_id = ? AND discord_id IS NOT NULL
    ORDER BY
      CASE WHEN id = ? THEN 0 ELSE 1 END ASC,
      github_login ASC
  `).all(botId, submittedByDevId ?? -1) as Array<{discord_id: string}>;

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!seen.has(row.discord_id)) {
      seen.add(row.discord_id);
      unique.push(row.discord_id);
    }
  }
  return unique;
}

export function getPendingVersionDms(db: DatabaseSync): PendingVersionDmRow[] {
  const rows = db.prepare(`
    SELECT bv.*, b.slug AS bot_slug, b.name AS bot_name
    FROM bot_versions bv
    JOIN bots b ON b.id = bv.bot_id
    WHERE bv.smoke_status IN ('failed_smoke_test', 'quarantined')
      AND bv.dm_sent = 0
    ORDER BY bv.created_at ASC, bv.id ASC
  `).all() as unknown as Array<BotVersionRow & {bot_slug: string; bot_name: string}>;

  return rows.map(row => ({
    version_id: row.id,
    bot_id: row.bot_id,
    bot_slug: row.bot_slug,
    bot_name: row.bot_name,
    version_str: row.version_str,
    smoke_status: row.smoke_status as 'failed_smoke_test' | 'quarantined',
    smoke_error_log: row.smoke_error_log,
    ladders_json: row.ladders_json,
    created_at: row.created_at,
    owner_discord_ids: getVersionOwnerDiscordIds(db, row.bot_id, row.submitted_by_dev_id),
  }));
}

export function markVersionDmSent(db: DatabaseSync, versionId: number) {
  db.prepare('UPDATE bot_versions SET dm_sent = 1 WHERE id = ?').run(versionId);
}
