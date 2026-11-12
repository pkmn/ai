import {DatabaseSync} from 'node:sqlite';

import {formatUtcDateTime, validateVersion} from '../static/util';

import {ensureAgentLadderStats} from './agent-ladder-stats';
import * as teams from './agent-ladder-teams';
import {AgentRow, getAgentById} from './agents';
import * as entries from './ladder-entries';
import {archiveLadderInPlace, canSettleLadder, getCurrentLadders, getLadder} from './ladders';
import {upsertTournamentEntrant} from './tournament-entrants';
import {
  getScheduledTournaments,
  getTournament,
  getTournamentClosesAt,
} from './tournaments';

import {TransactionRunner} from './index';

export type PackageFormat = 'bundle' | 'oci';
export type SmokeStatus = 'pending' | 'passed' | 'failed' | 'quarantined';
export type AccountStatusLabel = 'Pending' | 'Qualified' | 'Eligible' | 'Ineligible';

export const COOLDOWN_SECONDS = 14 * 24 * 60 * 60;
export const SETTLED_MAX_SE = 30;
export const SETTLED_MIN_MATCHES = 25;

export interface AgentVersionRow {
  id: number;
  agentId: number;
  developerId?: number;
  version: string;
  package: PackageFormat;
  url: string;
  sha256: string;
  authTokenEncoding?: string;
  laddersJson: string;
  tournamentsJson: string;
  unpackedBytes?: number;
  smokeStatus: SmokeStatus;
  smokeDurationMillis?: number;
  smokeTurnMillis?: number;
  smokePeakRam?: number;
  smokeError?: string;
  submittedAt: number;
  activatedAt?: number;
  notified: boolean;
}

export interface VersionHistoryView extends AgentVersionRow {
  activeLadderNames: string[];
  tournamentNames: string[];
}

export interface SubmissionStatus {
  label: AccountStatusLabel;
  canSubmit: boolean;
  reason?: string;
  nextEligibleAt?: number;
}

export interface TournamentSubmissionStatus {
  tournamentId: string;
  name: string;
  format: string;
  startsAt: number;
  closesAt: number;
  canSubmit: boolean;
  enteredVersion?: string;
  pendingVersion?: string;
  reason?: string;
}

export interface CreateSubmissionInput {
  agentId: number;
  developerId?: number;
  version: string;
  package: PackageFormat;
  url: string;
  sha256: string;
  authTokenEncoding?: string;
  ladderIds: string[];
  tournamentIds?: string[];
  teamsByLadder?: Record<string, string[]>;
  now?: number;
}

export interface PendingSubmissionRow {
  versionId: number;
  agentId: number;
  agentSlug: string;
  agentName: string;
  version: string;
  package: PackageFormat;
  url: string;
  sha256: string;
  authTokenEncoding?: string;
  ladders: string[];
  tournaments: string[];
  teamsByLadder: Record<string, string[]>;
}

export interface ApplySubmissionStatusInput {
  versionId: number;
  smokeStatus: Exclude<SmokeStatus, 'pending'>;
  unpackedBytes?: number;
  smokeDurationMillis?: number;
  smokeTurnMillis?: number;
  smokePeakRam?: number;
  smokeError?: string;
  retiredVersionIdsByLadder?: Record<string, number>;
  now?: number;
}

export interface ApplySubmissionStatusResult {
  version: AgentVersionRow;
  agent: AgentRow;
  retiredByLadder: Record<string, number>;
}

export interface PendingVersionDmRow {
  versionId: number;
  agentId: number;
  agentSlug: string;
  agentName: string;
  version: string;
  smokeStatus: 'failed' | 'quarantined';
  smokeError?: string;
  laddersJson: string;
  submittedAt: number;
  ownerDiscordIds: string[];
}

interface RawAgentVersionRow {
  id: number;
  agent_id: number;
  developer_id: number | null;
  version: string;
  package: PackageFormat;
  url: string;
  sha256: string;
  auth_token_encoding: string | null;
  ladders_json: string;
  tournaments_json: string;
  unpacked_bytes: number | null;
  smoke_status: SmokeStatus;
  smoke_duration_millis: number | null;
  smoke_turn_millis: number | null;
  smoke_peak_ram: number | null;
  smoke_error: string | null;
  submitted_at: number;
  activated_at: number | null;
  notified: number;
}

function mapVersionRow(raw: RawAgentVersionRow): AgentVersionRow {
  return {
    id: raw.id,
    agentId: raw.agent_id,
    developerId: raw.developer_id ?? undefined,
    version: raw.version,
    package: raw.package,
    url: raw.url,
    sha256: raw.sha256,
    authTokenEncoding: raw.auth_token_encoding ?? undefined,
    laddersJson: raw.ladders_json,
    tournamentsJson: raw.tournaments_json ?? '[]',
    unpackedBytes: raw.unpacked_bytes ?? undefined,
    smokeStatus: raw.smoke_status,
    smokeDurationMillis: raw.smoke_duration_millis ?? undefined,
    smokeTurnMillis: raw.smoke_turn_millis ?? undefined,
    smokePeakRam: raw.smoke_peak_ram ?? undefined,
    smokeError: raw.smoke_error ?? undefined,
    submittedAt: raw.submitted_at,
    activatedAt: raw.activated_at ?? undefined,
    notified: raw.notified === 1,
  };
}

export function getVersionById(
  db: DatabaseSync,
  versionId: number
): AgentVersionRow | undefined {
  const raw = db.prepare('SELECT * FROM agent_versions WHERE id = ?')
    .get(versionId) as unknown as RawAgentVersionRow | undefined;
  return raw ? mapVersionRow(raw) : undefined;
}

export function getVersionBySlugAndLabel(
  db: DatabaseSync,
  agentSlug: string,
  version: string
): (AgentVersionRow & {agentSlug: string; agentName: string}) | undefined {
  const raw = db.prepare(`
    SELECT av.*, a.slug AS agent_slug, a.name AS agent_name
    FROM agent_versions av
    JOIN agents a ON a.id = av.agent_id
    WHERE a.slug = ? AND av.version = ?
  `).get(agentSlug.trim().toLowerCase(), version.trim()) as unknown as (
    RawAgentVersionRow & {agent_slug: string; agent_name: string}
  ) | undefined;
  if (!raw) return undefined;
  return {
    ...mapVersionRow(raw),
    agentSlug: raw.agent_slug,
    agentName: raw.agent_name,
  };
}

export function getVersionsForAgent(db: DatabaseSync, agentId: number): VersionHistoryView[] {
  const rawVersions = db.prepare(
    'SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY submitted_at DESC, id DESC'
  ).all(agentId) as unknown as RawAgentVersionRow[];

  const activeRows = db.prepare(`
    SELECT le.version_id, l.name
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
    JOIN ladders l ON l.id = le.ladder_id
    WHERE av.agent_id = ?
      AND le.role IN ('champion', 'challenger')
      AND l.status IN ('upcoming', 'active', 'settling')
    ORDER BY
      CASE l.slot
        WHEN 'rby' THEN 0
        WHEN 'adv' THEN 1
        WHEN 'sv' THEN 2
        WHEN 'rand' THEN 3
        WHEN 'vgc' THEN 4
        ELSE 5
      END ASC
  `).all(agentId) as Array<{version_id: number; name: string}>;

  const activeByVersion = new Map<number, string[]>();
  for (const r of activeRows) {
    const list = activeByVersion.get(r.version_id) ?? [];
    list.push(r.name);
    activeByVersion.set(r.version_id, list);
  }

  const entrantRows = db.prepare(`
    SELECT te.version_id, t.name
    FROM tournament_entrants te
    JOIN tournaments t ON t.id = te.tournament_id
    WHERE te.agent_id = ?
    ORDER BY t.starts_at ASC, t.id ASC
  `).all(agentId) as Array<{version_id: number; name: string}>;

  const tourneysByVersion = new Map<number, string[]>();
  for (const r of entrantRows) {
    const list = tourneysByVersion.get(r.version_id) ?? [];
    list.push(r.name);
    tourneysByVersion.set(r.version_id, list);
  }

  return rawVersions.map(v => {
    const mapped = mapVersionRow(v);
    const enrolled = tourneysByVersion.get(v.id) ?? [];
    let tournamentNames = enrolled;
    if (!tournamentNames.length) {
      const requested = JSON.parse(mapped.tournamentsJson) as string[];
      tournamentNames = requested.map(tid => getTournament(db, tid)?.name ?? `Tournament #${tid}`);
    }
    return {
      ...mapped,
      activeLadderNames: activeByVersion.get(v.id) ?? [],
      tournamentNames,
    };
  });
}

// Evaluates per-tournament submission eligibility for `'scheduled'` events.
// Unlike continuous ladders, tournaments accept at most 1 successful (or currently pending) OCI
// entry per qualified project and are never blocked by 14-day ladder cooldowns or unsettled
// ladder Challengers.
export function computeAgentTournamentStatuses(
  db: DatabaseSync,
  agentId: number,
  now = Math.floor(Date.now() / 1000)
): TournamentSubmissionStatus[] {
  const scheduled = getScheduledTournaments(db);
  if (!scheduled.length) return [];

  const agent = getAgentById(db, agentId);
  if (!agent || agent.status === 'disabled') {
    return scheduled.map(t => ({
      tournamentId: t.id,
      name: t.name,
      format: t.format,
      startsAt: t.startsAt,
      closesAt: getTournamentClosesAt(t.startsAt),
      canSubmit: false,
      reason: 'Project is disabled.',
    }));
  }

  const entrantRows = db.prepare(`
    SELECT te.tournament_id, av.version
    FROM tournament_entrants te
    JOIN agent_versions av ON av.id = te.version_id
    WHERE te.agent_id = ?
  `).all(agentId) as Array<{tournament_id: string; version: string}>;
  const enteredByTourney = new Map(entrantRows.map(r => [r.tournament_id, r.version]));

  const versionRows = db.prepare(`
    SELECT version, smoke_status, tournaments_json
    FROM agent_versions
    WHERE agent_id = ?
      AND smoke_status IN ('pending', 'passed')
      AND tournaments_json != '[]'
    ORDER BY submitted_at DESC, id DESC
  `).all(agentId) as Array<{version: string; smoke_status: SmokeStatus; tournaments_json: string}>;

  const pendingByTourney = new Map<string, string>();
  for (const row of versionRows) {
    const tids = JSON.parse(row.tournaments_json) as string[];
    for (const tid of tids) {
      if (row.smoke_status === 'passed' && !enteredByTourney.has(tid)) {
        enteredByTourney.set(tid, row.version);
      } else if (row.smoke_status === 'pending' && !pendingByTourney.has(tid)) {
        pendingByTourney.set(tid, row.version);
      }
    }
  }

  return scheduled.map(t => {
    const closesAt = getTournamentClosesAt(t.startsAt);
    const enteredVersion = enteredByTourney.get(t.id);
    const pendingVersion = pendingByTourney.get(t.id);
    if (now >= closesAt) {
      return {
        tournamentId: t.id,
        name: t.name,
        format: t.format,
        startsAt: t.startsAt,
        closesAt,
        canSubmit: false,
        enteredVersion,
        pendingVersion: enteredVersion ? undefined : pendingVersion,
        reason: `Entries for "${t.name}" closed at ${formatUtcDateTime(closesAt)}.`,
      };
    }
    if (enteredVersion) {
      return {
        tournamentId: t.id,
        name: t.name,
        format: t.format,
        startsAt: t.startsAt,
        closesAt,
        canSubmit: false,
        enteredVersion,
        reason: `Already entered with version ${enteredVersion}.`,
      };
    }
    if (pendingVersion) {
      return {
        tournamentId: t.id,
        name: t.name,
        format: t.format,
        startsAt: t.startsAt,
        closesAt,
        canSubmit: false,
        pendingVersion,
        reason: `Version ${pendingVersion} is awaiting smoke testing for this tournament.`,
      };
    }
    return {
      tournamentId: t.id,
      name: t.name,
      format: t.format,
      startsAt: t.startsAt,
      closesAt,
      canSubmit: true,
    };
  });
}

// Evaluates project-wide ladder submission eligibility:
//   1. Project must be `'qualified'` and at least one ladder must be `'active'`.
//   2. No ladder version (`ladders_json != '[]'`) may currently be queued in `'pending'`.
//   3. At least 14 days (`COOLDOWN_SECONDS`) must have elapsed since the latest `'passed'` ladder
//      submission (unless staff waived it via `cooldown_refunded_at`). Tournament-only submissions
//      and failed smoke tests never trigger the ladder cooldown.
//   4. Every active ladder entry must have settled (`matches >= 25` and `se <= 30`) so projects
//      cannot churn unsettled Challengers before the rating graph absorbs them.
export function computeAgentSubmissionStatus(
  db: DatabaseSync,
  agentId: number,
  now = Math.floor(Date.now() / 1000)
): SubmissionStatus {
  const agent = getAgentById(db, agentId);
  if (!agent || agent.status === 'disabled') {
    return {
      label: 'Ineligible',
      canSubmit: false,
      reason: 'Project is disabled.',
    };
  }

  if (agent.status === 'pending') {
    return {
      label: 'Pending',
      canSubmit: false,
      reason: 'Project qualification is pending staff review.',
    };
  }

  const openLadders = getCurrentLadders(db);
  if (!openLadders.length) {
    return {
      label: 'Qualified',
      canSubmit: false,
      reason: 'Ladders are not open for submissions yet.',
    };
  }

  const pendingRow = db.prepare(
    `SELECT version FROM agent_versions
     WHERE agent_id = ? AND smoke_status = 'pending' AND ladders_json != '[]'
     LIMIT 1`
  ).get(agentId) as {version: string} | undefined;
  if (pendingRow) {
    return {
      label: 'Ineligible',
      canSubmit: false,
      reason: `Version ${pendingRow.version} is currently awaiting Arena smoke testing.`,
    };
  }

  const refundedAt = agent.cooldownRefundedAt ?? 0;
  const latestPassed = db.prepare(
    `SELECT submitted_at, version FROM agent_versions
     WHERE agent_id = ?
       AND smoke_status = 'passed'
       AND ladders_json != '[]'
       AND submitted_at > ?
     ORDER BY submitted_at DESC, id DESC
     LIMIT 1`
  ).get(agentId, refundedAt) as {submitted_at: number; version: string} | undefined;

  if (latestPassed) {
    const nextEligibleAt = latestPassed.submitted_at + COOLDOWN_SECONDS;
    if (now < nextEligibleAt) {
      const daysLeft = Math.ceil((nextEligibleAt - now) / 86400);
      return {
        label: 'Ineligible',
        canSubmit: false,
        reason:
          `14-day cooldown active (${daysLeft}d remaining after ${latestPassed.version}).`,
        nextEligibleAt,
      };
    }
  }

  const activeEntries = entries.getActiveEntriesForAgent(db, agentId);
  for (const entry of activeEntries) {
    if (entry.ladderStatus === 'upcoming') continue;
    const settled = entry.settledAt !== undefined || (
      entry.se <= SETTLED_MAX_SE && entry.matches >= SETTLED_MIN_MATCHES
    );
    if (!settled) {
      return {
        label: 'Ineligible',
        canSubmit: false,
        reason:
          `Active version ${entry.version} on ${entry.ladderName} has not settled ` +
          `(SE=${entry.se.toFixed(1)}, ` +
          `matches=${entry.matches}/${SETTLED_MIN_MATCHES}).`,
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
): AgentVersionRow {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tournamentIds = input.tournamentIds ?? [];
  let version: string;
  try {
    version = validateVersion(input.version);
  } catch (err: any) {
    throw Object.assign(new Error(err.message), {status: 400});
  }
  return inTransaction(() => {
    const agent = getAgentById(db, input.agentId);
    if (!agent || agent.status === 'disabled') {
      throw Object.assign(new Error('Project is disabled.'), {status: 403});
    }
    if (!input.ladderIds.length && !tournamentIds.length) {
      throw Object.assign(
        new Error('Select at least one active ladder or open tournament.'),
        {status: 400}
      );
    }

    const existing = db.prepare(
      'SELECT id FROM agent_versions WHERE agent_id = ? AND version = ?'
    ).get(input.agentId, version) as {id: number} | undefined;
    if (existing) {
      throw Object.assign(
        new Error(`Version "${version}" already exists for this project.`),
        {status: 409}
      );
    }

    if (input.ladderIds.length > 0) {
      const status = computeAgentSubmissionStatus(db, input.agentId, now);
      if (!status.canSubmit) {
        const code = status.label === 'Pending' || status.label === 'Qualified' ? 403 : 429;
        throw Object.assign(
          new Error(status.reason ?? 'Project is not currently eligible to submit to ladders.'),
          {status: code}
        );
      }
    }

    if (tournamentIds.length > 0) {
      if (input.package !== 'oci') {
        throw Object.assign(
          new Error('Tournament submissions only support OCI container images.'),
          {status: 400}
        );
      }
      const tourneyStatuses = new Map(
        computeAgentTournamentStatuses(db, input.agentId, now).map(s => [s.tournamentId, s])
      );
      for (const tid of tournamentIds) {
        const ts = tourneyStatuses.get(tid);
        if (!ts) {
          throw Object.assign(
            new Error(`Tournament "${tid}" is not open for submissions.`),
            {status: 400}
          );
        }
        if (!ts.canSubmit) {
          const code = now >= ts.closesAt ? 400 : 409;
          throw Object.assign(
            new Error(ts.reason ?? `Already entered in ${ts.name}.`),
            {status: code}
          );
        }
      }
    }

    const res = db.prepare(`
      INSERT INTO agent_versions (
        agent_id, developer_id, version, package, url,
        sha256, auth_token_encoding, ladders_json, tournaments_json, smoke_status, submitted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      input.agentId,
      input.developerId ?? null,
      version,
      input.package,
      input.url,
      input.sha256,
      input.authTokenEncoding ?? null,
      JSON.stringify(input.ladderIds),
      JSON.stringify(tournamentIds),
      now
    );
    const versionId = Number(res.lastInsertRowid);

    if (input.teamsByLadder) {
      teams.replacePendingTeams(db, input.agentId, input.teamsByLadder, now);
    }

    return getVersionById(db, versionId)!;
  });
}

export function getPendingSubmissions(db: DatabaseSync): PendingSubmissionRow[] {
  const rows = db.prepare(`
    SELECT av.*, a.slug AS agent_slug, a.name AS agent_name
    FROM agent_versions av
    JOIN agents a ON a.id = av.agent_id
    WHERE av.smoke_status = 'pending'
    ORDER BY av.submitted_at ASC, av.id ASC
  `).all() as unknown as Array<RawAgentVersionRow & {agent_slug: string; agent_name: string}>;

  return rows.map(row => {
    const ladders = JSON.parse(row.ladders_json) as string[];
    const tournaments = JSON.parse(row.tournaments_json ?? '[]') as string[];
    const teamsByLadder: Record<string, string[]> = {};
    for (const ladderId of ladders) {
      const pendingTeams = teams.getTeamsForAgentLadder(db, ladderId, row.agent_id, 'pending');
      if (pendingTeams.length > 0) {
        teamsByLadder[ladderId] = pendingTeams;
      }
    }
    return {
      versionId: row.id,
      agentId: row.agent_id,
      agentSlug: row.agent_slug,
      agentName: row.agent_name,
      version: row.version,
      package: row.package,
      url: row.url,
      sha256: row.sha256,
      authTokenEncoding: row.auth_token_encoding ?? undefined,
      ladders,
      tournaments,
      teamsByLadder,
    };
  });
}

// Applies smoke-test or quarantine outcomes from the Arena runner:
//   - Always scrubs `auth_token_encoding = NULL` so private pull tokens never persist at rest.
//   - On `'passed'`: promotes any staged `'pending'` team rosters to `'active'` and enforces the
//     2-version Champion + Challenger cap per ladder by retiring `argmin(lcb)` when a 3rd active
//     version enters (preserving its historical edges in the Davidson graph).
//   - On `'failed'` / `'quarantined'`: discards staged `'pending'` teams and resets `notified = 0`
//     so `server/discord.ts` delivers diagnostic DMs to linked owners.
export function applySubmissionStatus(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  input: ApplySubmissionStatusInput
): ApplySubmissionStatusResult {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  return inTransaction(() => {
    const prev = getVersionById(db, input.versionId);
    if (!prev) {
      throw Object.assign(new Error(`Unknown versionId ${input.versionId}`), {status: 404});
    }
    const agent = getAgentById(db, prev.agentId)!;
    const shouldResetNotify = (
      (input.smokeStatus === 'failed' || input.smokeStatus === 'quarantined') &&
      prev.smokeStatus !== input.smokeStatus
    );
    const activatedAt = input.smokeStatus === 'passed'
      ? (prev.activatedAt ?? now)
      : (prev.activatedAt ?? null);

    db.prepare(`
      UPDATE agent_versions
      SET auth_token_encoding = NULL,
          smoke_status = ?,
          unpacked_bytes = COALESCE(?, unpacked_bytes),
          smoke_duration_millis = COALESCE(?, smoke_duration_millis),
          smoke_turn_millis = COALESCE(?, smoke_turn_millis),
          smoke_peak_ram = COALESCE(?, smoke_peak_ram),
          smoke_error = ?,
          activated_at = ?,
          notified = CASE WHEN ? = 1 THEN 0 ELSE notified END
      WHERE id = ?
    `).run(
      input.smokeStatus,
      input.unpackedBytes ?? null,
      input.smokeDurationMillis ?? null,
      input.smokeTurnMillis ?? null,
      input.smokePeakRam ?? null,
      input.smokeError !== undefined ? input.smokeError : (prev.smokeError ?? null),
      activatedAt,
      shouldResetNotify ? 1 : 0,
      input.versionId
    );

    const ladderIds = JSON.parse(prev.laddersJson) as string[];
    const tournamentIds = JSON.parse(prev.tournamentsJson) as string[];
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
        SELECT le.version_id, le.lcb, le.elo
        FROM ladder_entries le
        JOIN agent_versions av ON av.id = le.version_id
        WHERE le.ladder_id = ?
          AND av.agent_id = ?
          AND le.version_id != ?
          AND le.role IN ('champion', 'challenger')
        ORDER BY le.lcb ASC, le.elo ASC, le.version_id ASC
      `);
      const upsertEntry = db.prepare(`
        INSERT INTO ladder_entries (
          ladder_id, version_id, role, mean_turn_millis, peak_ram, started_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(ladder_id, version_id) DO UPDATE SET
          role = excluded.role,
          retired_at = NULL,
          mean_turn_millis = CASE
            WHEN ladder_entries.matches = 0 THEN excluded.mean_turn_millis
            ELSE ladder_entries.mean_turn_millis
          END,
          peak_ram = MAX(ladder_entries.peak_ram, excluded.peak_ram)
      `);

      if (input.retiredVersionIdsByLadder) {
        for (const [ladderId, retiredId] of Object.entries(input.retiredVersionIdsByLadder)) {
          if (!Number.isInteger(retiredId) || retiredId === prev.id) continue;
          const target = getVersionById(db, retiredId);
          if (target?.agentId !== prev.agentId) continue;
          const info = retireEntry.run(now, ladderId, retiredId);
          if (info.changes > 0) retiredByLadder[ladderId] = retiredId;
        }
      }

      for (const ladderId of ladderIds) {
        const ladder = getLadder(db, ladderId);
        if (!ladder) continue;
        teams.promotePendingTeams(db, ladderId, prev.agentId);

        const otherActive = selectOtherActive.all(
          ladderId,
          prev.agentId,
          prev.id
        ) as Array<{version_id: number; lcb: number; elo: number}>;

        while (otherActive.length >= 2) {
          const weakest = otherActive.shift()!;
          retireEntry.run(now, ladderId, weakest.version_id);
          retiredByLadder[ladderId] = weakest.version_id;
        }

        const role: entries.EntryRole = otherActive.length === 0 ? 'champion' : 'challenger';
        if (otherActive.length === 1) {
          db.prepare(
            "UPDATE ladder_entries SET role = 'champion' WHERE ladder_id = ? AND version_id = ?"
          ).run(ladderId, otherActive[0].version_id);
        }
        upsertEntry.run(
          ladderId,
          prev.id,
          role,
          input.smokeTurnMillis ?? 0,
          input.smokePeakRam ?? 0,
          now
        );
        ensureAgentLadderStats(db, ladderId, prev.agentId);
      }

      for (const tournamentId of tournamentIds) {
        const tournament = getTournament(db, tournamentId);
        if (tournament?.status !== 'scheduled') continue;
        const alreadyEntered = db.prepare(
          'SELECT 1 FROM tournament_entrants WHERE tournament_id = ? AND agent_id = ?'
        ).get(tournamentId, prev.agentId);
        if (alreadyEntered) continue;
        const maxRow = db.prepare(
          `SELECT COALESCE(MAX(seed), 0) AS max_seed
           FROM tournament_entrants WHERE tournament_id = ?`
        ).get(tournamentId) as {max_seed: number};
        upsertTournamentEntrant(db, {
          tournamentId,
          agentId: prev.agentId,
          versionId: prev.id,
          seed: maxRow.max_seed + 1,
        });
      }
    } else if (input.smokeStatus === 'failed') {
      teams.deletePendingTeams(db, ladderIds, prev.agentId);
    } else if (input.smokeStatus === 'quarantined') {
      teams.deletePendingTeams(db, ladderIds, prev.agentId);
      if (tournamentIds.length > 0) {
        db.prepare(`
          DELETE FROM tournament_entrants
          WHERE version_id = ?
            AND tournament_id IN (SELECT id FROM tournaments WHERE status = 'scheduled')
        `).run(prev.id);
      }
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
        entries.promoteRemainingActiveToChampion(db, row.ladder_id, prev.agentId);
        const l = getLadder(db, row.ladder_id);
        if (l?.status === 'settling' && !canSettleLadder(db, l)) {
          archiveLadderInPlace(db, l.id, now);
        }
      }
    }

    return {version: getVersionById(db, input.versionId)!, agent, retiredByLadder};
  });
}

export function quarantineVersion(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  agentSlug: string,
  version: string,
  reason?: string,
  now = Math.floor(Date.now() / 1000)
): ApplySubmissionStatusResult {
  const ver = getVersionBySlugAndLabel(db, agentSlug, version);
  if (!ver) {
    throw new Error(`Version "${version}" not found for agent "${agentSlug}"`);
  }
  return applySubmissionStatus(db, inTransaction, {
    versionId: ver.id,
    smokeStatus: 'quarantined',
    smokeError: reason ?? ver.smokeError,
    now,
  });
}

export function unquarantineVersion(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  agentSlug: string,
  version: string,
  now = Math.floor(Date.now() / 1000)
): AgentVersionRow {
  return inTransaction(() => {
    const ver = getVersionBySlugAndLabel(db, agentSlug, version);
    if (!ver) {
      throw new Error(`Version "${version}" not found for agent "${agentSlug}"`);
    }

    db.prepare(
      `UPDATE agent_versions
       SET smoke_status = 'passed',
           smoke_error = NULL,
           activated_at = COALESCE(activated_at, ?)
       WHERE id = ?`
    ).run(now, ver.id);

    const quarantinedRows = db.prepare(`
      SELECT ladder_id FROM ladder_entries
      WHERE version_id = ? AND role = 'quarantined'
    `).all(ver.id) as Array<{ladder_id: string}>;

    const ladderIds = quarantinedRows.length > 0
      ? quarantinedRows.map(r => r.ladder_id)
      : (JSON.parse(ver.laddersJson) as string[]);

    for (const ladderId of ladderIds) {
      const ladder = getLadder(db, ladderId);
      if (!ladder) continue;
      const otherActive = db.prepare(`
        SELECT le.version_id
        FROM ladder_entries le
        JOIN agent_versions av ON av.id = le.version_id
        WHERE le.ladder_id = ?
          AND av.agent_id = ?
          AND le.version_id != ?
          AND le.role IN ('champion', 'challenger')
      `).all(ladderId, ver.agentId, ver.id) as Array<{version_id: number}>;

      const nextRole: entries.EntryRole = otherActive.length >= 2
        ? 'retired'
        : otherActive.length === 1
          ? 'challenger'
          : 'champion';
      const retiredAt = nextRole === 'retired' ? now : null;

      db.prepare(`
        INSERT INTO ladder_entries (ladder_id, version_id, role, started_at, retired_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(ladder_id, version_id) DO UPDATE SET
          role = excluded.role,
          retired_at = excluded.retired_at,
          crashes = 0,
          timeouts = 0,
          ooms = 0
      `).run(ladderId, ver.id, nextRole, now, retiredAt);

      ensureAgentLadderStats(db, ladderId, ver.agentId);

      if (nextRole !== 'retired' && ladder.status !== 'archived') {
        const dayUtc = new Date(now * 1000).toISOString().slice(0, 10);
        entries.recomputeLadderRatings(db, ladderId, now, undefined, dayUtc);
      }
    }

    return getVersionById(db, ver.id)!;
  });
}

export function getVersionOwnerDiscordIds(
  db: DatabaseSync,
  agentId: number,
  developerId?: number
): string[] {
  const rows = db.prepare(`
    SELECT discord_id
    FROM developers
    WHERE agent_id = ? AND discord_id IS NOT NULL
    ORDER BY
      CASE WHEN id = ? THEN 0 ELSE 1 END ASC,
      github_login ASC
  `).all(agentId, developerId ?? -1) as Array<{discord_id: string}>;

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
    SELECT av.*, a.slug AS agent_slug, a.name AS agent_name
    FROM agent_versions av
    JOIN agents a ON a.id = av.agent_id
    WHERE av.smoke_status IN ('failed', 'quarantined')
      AND av.notified = 0
    ORDER BY av.submitted_at ASC, av.id ASC
  `).all() as unknown as Array<RawAgentVersionRow & {agent_slug: string; agent_name: string}>;

  return rows.map(row => ({
    versionId: row.id,
    agentId: row.agent_id,
    agentSlug: row.agent_slug,
    agentName: row.agent_name,
    version: row.version,
    smokeStatus: row.smoke_status as 'failed' | 'quarantined',
    smokeError: row.smoke_error ?? undefined,
    laddersJson: row.ladders_json,
    submittedAt: row.submitted_at,
    ownerDiscordIds: getVersionOwnerDiscordIds(
      db,
      row.agent_id,
      row.developer_id ?? undefined
    ),
  }));
}

export function markVersionNotified(db: DatabaseSync, versionId: number) {
  db.prepare('UPDATE agent_versions SET notified = 1 WHERE id = ?').run(versionId);
}
