import {DatabaseSync} from 'node:sqlite';

import {formatUtcDate, formatUtcDateTime, validateVersion} from '../static/util';

import {ensureAgentLadderStats} from './agent-ladder-stats';
import * as teams from './agent-ladder-teams';
import {getAgentLadders} from './agent-ladders';
import {AgentRow, getAgentById} from './agents';
import * as entries from './ladder-entries';
import {archiveLadderInPlace, canSettleLadder, getCurrentLadders, getLadder} from './ladders';
import * as smokeDiagnostics from './smoke-diagnostics';
import {upsertTournamentEntrant} from './tournament-entrants';
import {getScheduledTournaments, getTournament, getTournamentClosesAt} from './tournaments';

import {TransactionRunner} from './index';

export type PackageFormat = 'bundle' | 'oci';
export type SmokeStatus =
  'pending' | 'staged' | 'passed' | 'failed' | 'discarded' | 'quarantined';
export type AccountStatusLabel = 'Pending' | 'Qualified' | 'Eligible' | 'Ineligible';

export const COOLDOWN_SECONDS = 14 * 24 * 60 * 60;
export const FAILED_SMOKE_WINDOW_SECONDS = 24 * 60 * 60;
export const MAX_FAILED_SMOKE_TESTS = 3;
export const MAX_RETAINED_FAILED_VERSIONS = 5;
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
  ladders: string[];
  tournaments: string[];
  unpackedBytes?: number;
  smokeStatus: SmokeStatus;
  smokeDurationMillis?: number;
  smokeInitMillis?: number;
  smokeTeamPreviewMillis?: number;
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
  queueAhead?: number;
  diagnostics?: smokeDiagnostics.Summary[];
  smokeInfoStatus?: smokeDiagnostics.InfoStatus;
}

export interface SubmissionStatus {
  label: AccountStatusLabel;
  canSubmit: boolean;
  reason?: string;
  nextEligibleAt?: number;
  queueAhead?: number;
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
  stagedVersion?: string;
  reason?: string;
  nextEligibleAt?: number;
  queueAhead?: number;
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
  smokeInitMillis?: number;
  smokeTeamPreviewMillis?: number;
  smokeTurnMillis?: number;
  smokePeakRam?: number;
  smokeError?: string;
  diagnostics?: smokeDiagnostics.Input[];
  now?: number;
}

export interface ActivateStagedVersionInput {
  versionId: number;
  agentId: number;
  now?: number;
}

export interface DiscardStagedVersionInput {
  versionId: number;
  agentId: number;
}

export interface WipeVersionResult {
  version: AgentVersionRow;
  agent: AgentRow;
}

export interface ApplySubmissionStatusResult {
  version: AgentVersionRow;
  agent: AgentRow;
  retiredByLadder: Record<string, number>;
}

export type NotifiableSmokeStatus = 'staged' | 'passed' | 'failed' | 'quarantined';

export interface PendingVersionDmRow {
  versionId: number;
  agentId: number;
  agentSlug: string;
  agentName: string;
  version: string;
  smokeStatus: NotifiableSmokeStatus;
  smokeError?: string;
  smokeDurationMillis?: number;
  smokeInitMillis?: number;
  smokeTeamPreviewMillis?: number;
  smokeTurnMillis?: number;
  smokePeakRam?: number;
  smokeInfoStatus?: smokeDiagnostics.InfoStatus;
  ladders: string[];
  tournaments: string[];
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
  smoke_init_millis: number | null;
  smoke_team_preview_millis: number | null;
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
    ladders: JSON.parse(raw.ladders_json) as string[],
    tournaments: JSON.parse(raw.tournaments_json ?? '[]') as string[],
    unpackedBytes: raw.unpacked_bytes ?? undefined,
    smokeStatus: raw.smoke_status,
    smokeDurationMillis: raw.smoke_duration_millis ?? undefined,
    smokeInitMillis: raw.smoke_init_millis ?? undefined,
    smokeTeamPreviewMillis: raw.smoke_team_preview_millis ?? undefined,
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

export function isVersionClaimed(
  db: DatabaseSync,
  agentId: number,
  version: string
): boolean {
  const row = db.prepare(`
    SELECT 1 FROM agent_versions
    WHERE agent_id = ? AND version = ?
      AND smoke_status NOT IN ('failed', 'discarded')
    LIMIT 1
  `).get(agentId, version.trim());
  return row !== undefined;
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
    ORDER BY
      CASE
        WHEN av.smoke_status IN ('passed', 'quarantined') THEN 0
        WHEN av.smoke_status IN ('staged', 'pending') THEN 1
        ELSE 2
      END ASC,
      av.id DESC
    LIMIT 1
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

  const diagnosticsByVersion = smokeDiagnostics.getSummariesForAgent(db, agentId);

  return rawVersions.map(v => {
    const mapped = mapVersionRow(v);
    const enrolled = tourneysByVersion.get(v.id) ?? [];
    let tournamentNames = enrolled;
    if (!tournamentNames.length) {
      tournamentNames = mapped.tournaments.map(
        tid => getTournament(db, tid)?.name ?? `Tournament #${tid}`
      );
    }
    const queueAhead = mapped.smokeStatus === 'pending'
      ? countPendingAhead(
        db,
        mapped.ladders.length > 0 ? 'ladder' : 'tournament',
        mapped.submittedAt,
        mapped.id,
        mapped.ladders.length > 0 ? undefined : mapped.tournaments
      )
      : undefined;
    const diagnostics = diagnosticsByVersion.get(v.id);
    const smokeInfoStatus = diagnostics?.length
      ? smokeDiagnostics.combineInfoStatus(diagnostics.map(d => d.infoStatus))
      : undefined;
    return {
      ...mapped,
      activeLadderNames: activeByVersion.get(v.id) ?? [],
      tournamentNames,
      ...(queueAhead !== undefined ? {queueAhead} : {}),
      ...(diagnostics?.length ? {diagnostics} : {}),
      ...(smokeInfoStatus !== undefined ? {smokeInfoStatus} : {}),
    };
  });
}

function countPendingAhead(
  db: DatabaseSync,
  scope: 'ladder' | 'tournament',
  submittedAt: number,
  versionId: number,
  tournamentIds?: readonly string[]
): number {
  if (scope === 'ladder') {
    const row = db.prepare(
      `SELECT COUNT(*) AS count FROM agent_versions
       WHERE smoke_status = 'pending'
         AND ladders_json != '[]'
         AND (submitted_at < ? OR (submitted_at = ? AND id < ?))`
    ).get(submittedAt, submittedAt, versionId) as {count: number};
    return row.count;
  }
  const rows = db.prepare(
    `SELECT tournaments_json FROM agent_versions
     WHERE smoke_status = 'pending'
       AND tournaments_json != '[]'
       AND (submitted_at < ? OR (submitted_at = ? AND id < ?))`
  ).all(submittedAt, submittedAt, versionId) as Array<{tournaments_json: string}>;
  if (!tournamentIds?.length) return rows.length;
  const targets = new Set(tournamentIds);
  let count = 0;
  for (const row of rows) {
    const tids = JSON.parse(row.tournaments_json) as string[];
    if (tids.some(tid => targets.has(tid))) count++;
  }
  return count;
}

function formatQueueAhead(ahead: number): string {
  return ahead === 0 ? 'next in queue' : `${ahead} ahead in queue`;
}

// Counts both failed and developer-discarded diagnostic runs against the rolling 24h retry budget
// so a project cannot farm unbounded self-play compute by repeatedly passing and discarding builds.
function checkFailedSmokeBudget(
  db: DatabaseSync,
  agentId: number,
  scope: 'ladder' | 'tournament',
  refundedAt: number,
  now: number
): {nextEligibleAt: number; reason: string} | undefined {
  const cutoff = Math.max(now - FAILED_SMOKE_WINDOW_SECONDS, refundedAt);
  const scopeClause = scope === 'ladder' ? "ladders_json != '[]'" : "tournaments_json != '[]'";
  const rows = db.prepare(
    `SELECT submitted_at FROM agent_versions
     WHERE agent_id = ?
       AND smoke_status IN ('failed', 'discarded')
       AND ${scopeClause}
       AND submitted_at > ?
     ORDER BY submitted_at ASC, id ASC`
  ).all(agentId, cutoff) as Array<{submitted_at: number}>;
  if (rows.length < MAX_FAILED_SMOKE_TESTS) return undefined;
  const oldestBlocking = rows[rows.length - MAX_FAILED_SMOKE_TESTS].submitted_at;
  const nextEligibleAt = oldestBlocking + FAILED_SMOKE_WINDOW_SECONDS;
  return {
    nextEligibleAt,
    reason:
      `Failed smoke test limit reached (${MAX_FAILED_SMOKE_TESTS} failed or discarded in 24h); ` +
      `retry after ${formatUtcDateTime(nextEligibleAt)}.`,
  };
}

// Evaluates per-tournament submission eligibility for `'scheduled'` events.
// Unlike continuous ladders, tournaments intentionally accept entries from both `'pending'` and
// `'qualified'` projects (only `'disabled'` projects are blocked), accept at most 1 successful
// (or currently pending) OCI entry per project, and are never blocked by 14-day ladder cooldowns
// or unsettled ladder Challengers. Failed tournament smoke tests are still bounded by the rolling
// 24-hour per-project budget (`MAX_FAILED_SMOKE_TESTS`, clearable via `refundCooldown` or bypassed
// when staff set `unlimited_smoke_tests = 1`).
export function computeAgentTournamentStatuses(
  db: DatabaseSync,
  agentId: number,
  now = Math.floor(Date.now() / 1000)
): TournamentSubmissionStatus[] {
  const scheduled = getScheduledTournaments(db);
  if (!scheduled.length) return [];

  const agent = getAgentById(db, agentId);
  const badSmogon = db.prepare(
    "SELECT 1 FROM developers WHERE agent_id = ? AND smogon_standing = 'bad' LIMIT 1"
  ).get(agentId);
  if (!agent || agent.status === 'disabled' || badSmogon) {
    return scheduled.map(t => ({
      tournamentId: t.id,
      name: t.name,
      format: t.format,
      startsAt: t.startsAt,
      closesAt: getTournamentClosesAt(t.startsAt),
      canSubmit: false,
      reason: badSmogon
        ? 'Smogon account for this project is not in good standing.'
        : 'Project is disabled.',
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
    SELECT id, version, smoke_status, tournaments_json, submitted_at
    FROM agent_versions
    WHERE agent_id = ?
      AND smoke_status IN ('pending', 'staged', 'passed')
      AND tournaments_json != '[]'
    ORDER BY submitted_at DESC, id DESC
  `).all(agentId) as Array<{
    id: number;
    version: string;
    smoke_status: SmokeStatus;
    tournaments_json: string;
    submitted_at: number;
  }>;

  const pendingByTourney = new Map<string, {id: number; version: string; submittedAt: number}>();
  const stagedByTourney = new Map<string, string>();
  for (const row of versionRows) {
    const tids = JSON.parse(row.tournaments_json) as string[];
    for (const tid of tids) {
      if (row.smoke_status === 'passed' && !enteredByTourney.has(tid)) {
        enteredByTourney.set(tid, row.version);
      } else if (row.smoke_status === 'pending' && !pendingByTourney.has(tid)) {
        pendingByTourney.set(tid, {
          id: row.id,
          version: row.version,
          submittedAt: row.submitted_at,
        });
      } else if (row.smoke_status === 'staged' && !stagedByTourney.has(tid)) {
        stagedByTourney.set(tid, row.version);
      }
    }
  }

  const refundedAt = agent.cooldownRefundedAt ?? 0;
  const failedSmokeBlock = agent.unlimitedSmokeTests
    ? undefined
    : checkFailedSmokeBudget(db, agentId, 'tournament', refundedAt, now);

  return scheduled.map(t => {
    const closesAt = getTournamentClosesAt(t.startsAt);
    const enteredVersion = enteredByTourney.get(t.id);
    const pending = pendingByTourney.get(t.id);
    const pendingVersion = pending?.version;
    const stagedVersion = stagedByTourney.get(t.id);
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
        stagedVersion: enteredVersion ? undefined : stagedVersion,
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
    if (pending) {
      const queueAhead = countPendingAhead(
        db, 'tournament', pending.submittedAt, pending.id, [t.id]
      );
      return {
        tournamentId: t.id,
        name: t.name,
        format: t.format,
        startsAt: t.startsAt,
        closesAt,
        canSubmit: false,
        pendingVersion: pending.version,
        queueAhead,
        reason:
          `Version ${pending.version} is awaiting smoke testing for this tournament ` +
          `(${formatQueueAhead(queueAhead)}).`,
      };
    }
    if (stagedVersion) {
      return {
        tournamentId: t.id,
        name: t.name,
        format: t.format,
        startsAt: t.startsAt,
        closesAt,
        canSubmit: false,
        stagedVersion,
        reason:
          `Version ${stagedVersion} passed diagnostic testing for this tournament; ` +
          'activate or discard it before submitting another.',
      };
    }
    if (failedSmokeBlock) {
      return {
        tournamentId: t.id,
        name: t.name,
        format: t.format,
        startsAt: t.startsAt,
        closesAt,
        canSubmit: false,
        reason: failedSmokeBlock.reason,
        nextEligibleAt: failedSmokeBlock.nextEligibleAt,
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
//   1. Project must be qualified for at least one open (`'upcoming'` or `'active'`) ladder slot.
//   2. No ladder version (`ladders_json != '[]'`) may currently be queued in `'pending'`.
//   3. At least 14 days (`COOLDOWN_SECONDS`) must have elapsed since the latest `'passed'` ladder
//      submission (unless staff waived it via `cooldown_refunded_at`). Tournament-only submissions
//      and failed smoke tests never trigger the 14-day ladder cooldown.
//   4. Every active ladder entry must have settled (`matches >= 25` and `se <= 30`) so projects
//      cannot churn unsettled Challengers before the rating graph absorbs them.
//   5. Fewer than `MAX_FAILED_SMOKE_TESTS` (3) ladder smoke tests may have failed in the rolling
//      24-hour window (`FAILED_SMOKE_WINDOW_SECONDS`), unless cleared via `cooldown_refunded_at`
//      or bypassed via `unlimited_smoke_tests`.
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

  const badSmogon = db.prepare(
    "SELECT 1 FROM developers WHERE agent_id = ? AND smogon_standing = 'bad' LIMIT 1"
  ).get(agentId);
  if (badSmogon) {
    return {
      label: 'Ineligible',
      canSubmit: false,
      reason: 'Smogon account for this project is not in good standing.',
    };
  }

  const qualifiedSlots = new Set(getAgentLadders(db, agentId));
  if (agent.status === 'pending' || qualifiedSlots.size === 0) {
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
  if (!openLadders.some(l => qualifiedSlots.has(l.slot))) {
    return {
      label: 'Qualified',
      canSubmit: false,
      reason: 'None of your qualified ladders are open for submissions yet.',
    };
  }

  const pendingRow = db.prepare(
    `SELECT id, version, submitted_at FROM agent_versions
     WHERE agent_id = ? AND smoke_status = 'pending' AND ladders_json != '[]'
     ORDER BY submitted_at ASC, id ASC
     LIMIT 1`
  ).get(agentId) as {id: number; version: string; submitted_at: number} | undefined;
  if (pendingRow) {
    const queueAhead = countPendingAhead(db, 'ladder', pendingRow.submitted_at, pendingRow.id);
    return {
      label: 'Ineligible',
      canSubmit: false,
      reason:
        `Version ${pendingRow.version} is currently awaiting Arena smoke testing ` +
        `(${formatQueueAhead(queueAhead)}).`,
      queueAhead,
    };
  }

  const stagedRow = db.prepare(
    `SELECT version FROM agent_versions
     WHERE agent_id = ? AND smoke_status = 'staged' AND ladders_json != '[]'
     ORDER BY submitted_at DESC, id DESC
     LIMIT 1`
  ).get(agentId) as {version: string} | undefined;
  if (stagedRow) {
    return {
      label: 'Ineligible',
      canSubmit: false,
      reason:
        `Version ${stagedRow.version} passed diagnostic testing; ` +
        'activate or discard it before submitting another.',
    };
  }

  const refundedAt = agent.cooldownRefundedAt ?? 0;
  // Include `'quarantined'` versions that previously activated (`activated_at IS NOT NULL`) so a
  // competitor cannot intentionally crash/auto-quarantine an unsettled version to evade the 14-day
  // submission cooldown (staff can still explicitly waive infra glitches via `refundCooldown`).
  // The cooldown starts when the version is activated (`COALESCE(activated_at, submitted_at)`).
  const latestPassed = db.prepare(
    `SELECT COALESCE(activated_at, submitted_at) AS cooldown_start, version FROM agent_versions
     WHERE agent_id = ?
       AND (smoke_status = 'passed' OR (smoke_status = 'quarantined' AND activated_at IS NOT NULL))
       AND ladders_json != '[]'
       AND COALESCE(activated_at, submitted_at) > ?
     ORDER BY COALESCE(activated_at, submitted_at) DESC, id DESC
     LIMIT 1`
  ).get(agentId, refundedAt) as {cooldown_start: number; version: string} | undefined;

  if (latestPassed) {
    const nextEligibleAt = latestPassed.cooldown_start + COOLDOWN_SECONDS;
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

  const failedSmokeBlock = agent.unlimitedSmokeTests
    ? undefined
    : checkFailedSmokeBudget(db, agentId, 'ladder', refundedAt, now);
  if (failedSmokeBlock) {
    return {
      label: 'Ineligible',
      canSubmit: false,
      reason: failedSmokeBlock.reason,
      nextEligibleAt: failedSmokeBlock.nextEligibleAt,
    };
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
    // Only 'disabled' projects are blocked at the top level; 'pending' projects are intentionally
    // permitted to submit tournament-only OCI entries while gated from ladders below.
    const agent = getAgentById(db, input.agentId);
    if (!agent || agent.status === 'disabled') {
      throw Object.assign(new Error('Project is disabled.'), {status: 403});
    }
    const badSmogon = db.prepare(
      "SELECT 1 FROM developers WHERE agent_id = ? AND smogon_standing = 'bad' LIMIT 1"
    ).get(input.agentId);
    if (badSmogon) {
      throw Object.assign(
        new Error('Smogon account for this project is not in good standing.'),
        {status: 403}
      );
    }
    if (!input.ladderIds.length && !tournamentIds.length) {
      throw Object.assign(
        new Error('Select at least one active ladder or open tournament.'),
        {status: 400}
      );
    }

    if (isVersionClaimed(db, input.agentId, version)) {
      throw Object.assign(
        new Error(`Version "${version}" already exists for this project.`),
        {status: 409}
      );
    }

    if (input.ladderIds.length > 0 && tournamentIds.length > 0) {
      throw Object.assign(
        new Error(
          'Ladder (arm64) and tournament (linux/amd64) submissions validate on separate ' +
          'hosts; submit them as separate versions.'
        ),
        {status: 400}
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
      const qualifiedSlots = new Set(getAgentLadders(db, input.agentId));
      for (const ladderId of input.ladderIds) {
        const ladder = getLadder(db, ladderId);
        if (!ladder) {
          throw Object.assign(new Error(`Unknown ladder "${ladderId}".`), {status: 400});
        }
        if (ladder.status !== 'upcoming' && ladder.status !== 'active') {
          throw Object.assign(
            new Error(`Ladder "${ladderId}" is ${ladder.status} and closed to submissions.`),
            {status: 400}
          );
        }
        if (!qualifiedSlots.has(ladder.slot)) {
          throw Object.assign(
            new Error(`${agent.name} is not qualified for the ${ladder.name} ladder.`),
            {status: 403}
          );
        }
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
          const code = now >= ts.closesAt ? 400 : ts.nextEligibleAt !== undefined ? 429 : 409;
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

export function countStagedVersions(db: DatabaseSync): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM agent_versions WHERE smoke_status = 'staged'"
  ).get() as {count: number};
  return row.count;
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
      const ladderTeams = pendingTeams.length > 0
        ? pendingTeams
        : teams.getTeamsForAgentLadder(db, ladderId, row.agent_id, 'active');
      if (ladderTeams.length > 0) {
        teamsByLadder[ladderId] = ladderTeams;
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

function enrollActivatedVersion(
  db: DatabaseSync,
  version: AgentVersionRow,
  ladderIds: readonly string[],
  tournamentIds: readonly string[],
  telemetry: {initMillis: number; turnMillis: number; peakRam: number},
  now: number
): Record<string, number> {
  const retiredByLadder: Record<string, number> = {};
  const retireEntry = db.prepare(`
    UPDATE ladder_entries
    SET role = 'retired',
        retired_at = ?,
        rank_current = NULL,
        rank_min = NULL,
        rank_max = NULL
    WHERE ladder_id = ? AND version_id = ? AND is_anchor = 0
  `);
  const selectOtherNonAnchorActive = db.prepare(`
    SELECT le.version_id, le.lcb, le.elo
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
    WHERE le.ladder_id = ?
      AND av.agent_id = ?
      AND le.version_id != ?
      AND le.role IN ('champion', 'challenger')
      AND le.is_anchor = 0
    ORDER BY le.lcb ASC, le.elo ASC, le.version_id ASC
  `);
  const upsertEntry = db.prepare(`
    INSERT INTO ladder_entries (
      ladder_id, version_id, role,
      mean_init_millis, mean_turn_millis, mean_ram, peak_ram,
      started_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ladder_id, version_id) DO UPDATE SET
      role = excluded.role,
      retired_at = NULL,
      mean_init_millis = CASE
        WHEN ladder_entries.matches = 0 THEN excluded.mean_init_millis
        ELSE ladder_entries.mean_init_millis
      END,
      mean_turn_millis = CASE
        WHEN ladder_entries.matches = 0 THEN excluded.mean_turn_millis
        ELSE ladder_entries.mean_turn_millis
      END,
      mean_ram = CASE
        WHEN ladder_entries.matches = 0 THEN excluded.mean_ram
        ELSE ladder_entries.mean_ram
      END,
      peak_ram = MAX(ladder_entries.peak_ram, excluded.peak_ram)
  `);

  for (const ladderId of ladderIds) {
    const ladder = getLadder(db, ladderId);
    if (!ladder) continue;
    teams.promotePendingTeams(db, ladderId, version.agentId);

    const otherNonAnchorActive = selectOtherNonAnchorActive.all(
      ladderId,
      version.agentId,
      version.id
    ) as Array<{version_id: number; lcb: number; elo: number}>;

    while (otherNonAnchorActive.length >= 2) {
      const weakest = otherNonAnchorActive.shift()!;
      retireEntry.run(now, ladderId, weakest.version_id);
      retiredByLadder[ladderId] = weakest.version_id;
    }

    upsertEntry.run(
      ladderId,
      version.id,
      'challenger',
      telemetry.initMillis,
      telemetry.turnMillis,
      telemetry.peakRam,
      telemetry.peakRam,
      now
    );
    entries.promoteRemainingActiveToChampion(db, ladderId, version.agentId);
    ensureAgentLadderStats(db, ladderId, version.agentId);
  }

  for (const tournamentId of tournamentIds) {
    const tournament = getTournament(db, tournamentId);
    if (tournament?.status !== 'scheduled') continue;
    const alreadyEntered = db.prepare(
      'SELECT 1 FROM tournament_entrants WHERE tournament_id = ? AND agent_id = ?'
    ).get(tournamentId, version.agentId);
    if (alreadyEntered) continue;
    const maxRow = db.prepare(
      `SELECT COALESCE(MAX(seed), 0) AS max_seed
       FROM tournament_entrants WHERE tournament_id = ?`
    ).get(tournamentId) as {max_seed: number};
    upsertTournamentEntrant(db, {
      tournamentId,
      agentId: version.agentId,
      versionId: version.id,
      seed: maxRow.max_seed + 1,
    });
  }

  return retiredByLadder;
}

const VALID_TRANSITIONS: Record<SmokeStatus, ReadonlySet<Exclude<SmokeStatus, 'pending'>>> = {
  pending: new Set(['staged', 'passed', 'failed', 'discarded', 'quarantined']),
  staged: new Set(['passed', 'discarded', 'quarantined']),
  passed: new Set(['quarantined']),
  failed: new Set(),
  discarded: new Set(),
  quarantined: new Set(),
};

// Retains only the newest `MAX_RETAINED_FAILED_VERSIONS` failed/discarded attempts per project
// and scope (ladder vs tournament) so repeated diagnostic testing bounds `agent_versions` and
// cascading `smoke_diagnostics` storage without perturbing the rolling 3/24h budget. Always pins
// `keepVersionId` first so discarding an older staged tournament version never deletes itself.
function pruneFailedDiagnosticVersions(
  db: DatabaseSync,
  agentId: number,
  ladderIds: readonly string[],
  tournamentIds: readonly string[],
  keepVersionId: number
) {
  const scopes: Array<'ladder' | 'tournament'> = [];
  if (ladderIds.length > 0) scopes.push('ladder');
  if (tournamentIds.length > 0) scopes.push('tournament');
  for (const scope of scopes) {
    const scopeClause = scope === 'ladder' ? "ladders_json != '[]'" : "tournaments_json != '[]'";
    db.prepare(`
      DELETE FROM agent_versions
      WHERE id IN (
        SELECT id
        FROM agent_versions
        WHERE agent_id = ?
          AND smoke_status IN ('failed', 'discarded')
          AND activated_at IS NULL
          AND ${scopeClause}
        ORDER BY
          CASE WHEN id = ? THEN 0 ELSE 1 END ASC,
          submitted_at DESC,
          id DESC
        LIMIT -1 OFFSET ?
      )
    `).run(agentId, keepVersionId, MAX_RETAINED_FAILED_VERSIONS);
  }
}

// Applies smoke-test or quarantine outcomes from the Arena runner:
//   - Scrubs `auth_token_encoding = NULL` on every terminal/failed/quarantined/discarded status
//     and on tournament-only `'staged'` builds; ladder `'staged'` builds retain the encrypted token
//     only until `POST /api/arena/artifacts/:id/archived` (or retirement/disablement/archival).
//   - Persists any attached private diagnostic replays/stderr into `smoke_diagnostics`.
//   - On `'staged'`: records diagnostic results and resets `notified = 0` so `server/discord.ts`
//     notifies the developer to review and explicitly activate or discard the build on `/account/`.
//   - On `'passed'`: promotes any staged `'pending'` team rosters to `'active'`, resets
//     `notified = 0` so `server/discord.ts` delivers pass DMs, and enforces the 2-version
//     Champion + Challenger cap per ladder across non-anchor versions by retiring `argmin(lcb)`
//     when a 3rd non-anchor active version enters (anchors always stay active, and retired entries
//     keep their historical edges in the Davidson graph).
//   - On `'failed'` / `'quarantined'`: discards staged `'pending'` teams and resets `notified = 0`
//     so `server/discord.ts` delivers diagnostic DMs to linked owners.
//   - On `'discarded'`: reverts staged `'pending'` teams back to `'saved'` so VGC rosters are
//     preserved for the developer's next attempt.
export function applySubmissionStatus(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  input: ApplySubmissionStatusInput
): ApplySubmissionStatusResult {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  return inTransaction(() => {
    const prev = getVersionById(db, input.versionId);
    if (!prev) {
      // Return 409 (not 404) so the runner's FIFO outbox drops stale status reports for wiped
      // versions instead of wedging behind transient proxy-404 retries.
      throw Object.assign(new Error(`Unknown versionId ${input.versionId}`), {status: 409});
    }
    const agent = getAgentById(db, prev.agentId)!;
    // Ladder submissions stay locally staged on the Mac mini after diagnostic fetch, so their
    // one-time auth header is always scrubbed immediately. Tournament-only OCI submissions are
    // pulled again when baking ephemeral GCP tournament workers, so they retain credentials while
    // staged/passed until archived or tournament completion.
    const isTournamentOnly = prev.ladders.length === 0 && prev.tournaments.length > 0;
    const retainTournamentAuth =
      isTournamentOnly && (input.smokeStatus === 'staged' || input.smokeStatus === 'passed');
    const scrubAuth = !retainTournamentAuth;
    if (prev.smokeStatus === input.smokeStatus) {
      db.prepare(`
        UPDATE agent_versions
        SET auth_token_encoding = CASE WHEN ? = 1 THEN NULL ELSE auth_token_encoding END,
            unpacked_bytes = COALESCE(?, unpacked_bytes),
            smoke_duration_millis = COALESCE(?, smoke_duration_millis),
            smoke_init_millis = COALESCE(?, smoke_init_millis),
            smoke_team_preview_millis = COALESCE(?, smoke_team_preview_millis),
            smoke_turn_millis = COALESCE(?, smoke_turn_millis),
            smoke_peak_ram = COALESCE(?, smoke_peak_ram),
            smoke_error = ?
        WHERE id = ?
      `).run(
        scrubAuth ? 1 : 0,
        input.unpackedBytes ?? null,
        input.smokeDurationMillis ?? null,
        input.smokeInitMillis ?? null,
        input.smokeTeamPreviewMillis ?? null,
        input.smokeTurnMillis ?? null,
        input.smokePeakRam ?? null,
        input.smokeError !== undefined ? input.smokeError : (prev.smokeError ?? null),
        input.versionId
      );
      if (input.diagnostics !== undefined) {
        smokeDiagnostics.replaceForVersion(db, input.versionId, input.diagnostics, now);
      }
      return {
        version: getVersionById(db, input.versionId)!,
        agent,
        retiredByLadder: {},
      };
    }
    if (!VALID_TRANSITIONS[prev.smokeStatus].has(input.smokeStatus)) {
      throw Object.assign(
        new Error(
          `Invalid submission status transition from "${prev.smokeStatus}" ` +
          `to "${input.smokeStatus}"`
        ),
        {status: 409}
      );
    }
    const activatedAt = input.smokeStatus === 'passed'
      ? (prev.activatedAt ?? now)
      : (prev.activatedAt ?? null);
    const notified = input.smokeStatus === 'discarded' ? 1 : 0;

    db.prepare(`
      UPDATE agent_versions
      SET auth_token_encoding = CASE WHEN ? = 1 THEN NULL ELSE auth_token_encoding END,
          smoke_status = ?,
          unpacked_bytes = COALESCE(?, unpacked_bytes),
          smoke_duration_millis = COALESCE(?, smoke_duration_millis),
          smoke_init_millis = COALESCE(?, smoke_init_millis),
          smoke_team_preview_millis = COALESCE(?, smoke_team_preview_millis),
          smoke_turn_millis = COALESCE(?, smoke_turn_millis),
          smoke_peak_ram = COALESCE(?, smoke_peak_ram),
          smoke_error = ?,
          activated_at = ?,
          notified = ?
      WHERE id = ?
    `).run(
      scrubAuth ? 1 : 0,
      input.smokeStatus,
      input.unpackedBytes ?? null,
      input.smokeDurationMillis ?? null,
      input.smokeInitMillis ?? null,
      input.smokeTeamPreviewMillis ?? null,
      input.smokeTurnMillis ?? null,
      input.smokePeakRam ?? null,
      input.smokeError !== undefined ? input.smokeError : (prev.smokeError ?? null),
      activatedAt,
      notified,
      input.versionId
    );

    if (input.diagnostics !== undefined) {
      smokeDiagnostics.replaceForVersion(db, input.versionId, input.diagnostics, now);
    }

    const ladderIds = prev.ladders;
    const tournamentIds = prev.tournaments;
    let retiredByLadder: Record<string, number> = {};

    if (input.smokeStatus === 'passed') {
      retiredByLadder = enrollActivatedVersion(
        db,
        prev,
        ladderIds,
        tournamentIds,
        {
          initMillis: input.smokeInitMillis ?? prev.smokeInitMillis ?? 0,
          turnMillis: input.smokeTurnMillis ?? prev.smokeTurnMillis ?? 0,
          peakRam: input.smokePeakRam ?? prev.smokePeakRam ?? 0,
        },
        now
      );
    } else if (input.smokeStatus === 'failed') {
      teams.deletePendingTeams(db, ladderIds, prev.agentId);
      pruneFailedDiagnosticVersions(db, prev.agentId, ladderIds, tournamentIds, prev.id);
    } else if (input.smokeStatus === 'discarded') {
      teams.revertPendingTeamsToSaved(db, ladderIds, prev.agentId);
      pruneFailedDiagnosticVersions(db, prev.agentId, ladderIds, tournamentIds, prev.id);
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
      const dayUtc = formatUtcDate(now);
      for (const row of affected) {
        entries.promoteRemainingActiveToChampion(db, row.ladder_id, prev.agentId);
        const l = getLadder(db, row.ladder_id);
        if (l && l.status !== 'archived') {
          entries.recomputeLadderRatings(db, row.ladder_id, now, undefined, dayUtc);
        }
        if (l?.status === 'settling' && !canSettleLadder(db, l)) {
          archiveLadderInPlace(db, l.id, now);
        }
      }
    }

    return {version: getVersionById(db, input.versionId)!, agent, retiredByLadder};
  });
}

// Explicit developer activation (`'staged' -> 'passed'`) from `/account/`.
// Verifies ownership, standing, open ladder/tournament windows (tournaments strictly require
// `now < closesAt`), sets `activated_at = now` (starting the 14-day ladder cooldown), promotes
// staged VGC rosters, and enrolls the version into active ladders or scheduled tournaments.
export function activateStagedVersion(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  input: ActivateStagedVersionInput
): ApplySubmissionStatusResult {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  return inTransaction(() => {
    const prev = getVersionById(db, input.versionId);
    if (!prev) {
      throw Object.assign(new Error(`Unknown versionId ${input.versionId}`), {status: 404});
    }
    if (prev.agentId !== input.agentId) {
      throw Object.assign(new Error('Forbidden.'), {status: 403});
    }
    if (prev.smokeStatus !== 'staged') {
      throw Object.assign(
        new Error(
          `Version "${prev.version}" is "${prev.smokeStatus}" and cannot be activated.`
        ),
        {status: 409}
      );
    }
    const agent = getAgentById(db, prev.agentId);
    if (!agent || agent.status === 'disabled') {
      throw Object.assign(new Error('Project is disabled.'), {status: 403});
    }
    const badSmogon = db.prepare(
      "SELECT 1 FROM developers WHERE agent_id = ? AND smogon_standing = 'bad' LIMIT 1"
    ).get(prev.agentId);
    if (badSmogon) {
      throw Object.assign(
        new Error('Smogon account for this project is not in good standing.'),
        {status: 403}
      );
    }

    const openLadderIds: string[] = [];
    const droppedLadderIds: string[] = [];
    if (prev.ladders.length > 0) {
      if (agent.status !== 'qualified') {
        throw Object.assign(
          new Error('Project qualification is pending staff review.'),
          {status: 403}
        );
      }
      const qualifiedSlots = new Set(getAgentLadders(db, prev.agentId));
      let hadQualifiedTarget = false;
      for (const ladderId of prev.ladders) {
        const ladder = getLadder(db, ladderId);
        const isQualified = Boolean(ladder && qualifiedSlots.has(ladder.slot));
        if (isQualified) hadQualifiedTarget = true;
        if (isQualified && (ladder!.status === 'upcoming' || ladder!.status === 'active')) {
          openLadderIds.push(ladderId);
        } else {
          droppedLadderIds.push(ladderId);
        }
      }
      if (!openLadderIds.length) {
        throw Object.assign(
          new Error(
            hadQualifiedTarget
              ? 'All target ladders for this version have closed to new entries.'
              : `${agent.name} is no longer qualified for any target ladders of this version.`
          ),
          {status: hadQualifiedTarget ? 400 : 403}
        );
      }
    }

    const openTournamentIds: string[] = [];
    if (prev.tournaments.length > 0) {
      for (const tournamentId of prev.tournaments) {
        const tournament = getTournament(db, tournamentId);
        if (tournament?.status !== 'scheduled') {
          throw Object.assign(
            new Error(`Tournament "${tournamentId}" is no longer open for entries.`),
            {status: 400}
          );
        }
        const closesAt = getTournamentClosesAt(tournament.startsAt);
        if (now >= closesAt) {
          throw Object.assign(
            new Error(
              `Entries for "${tournament.name}" closed at ${formatUtcDateTime(closesAt)}.`
            ),
            {status: 400}
          );
        }
        const existingEntrant = db.prepare(
          'SELECT 1 FROM tournament_entrants WHERE tournament_id = ? AND agent_id = ? LIMIT 1'
        ).get(tournamentId, prev.agentId);
        if (existingEntrant) {
          throw Object.assign(
            new Error(`Already entered in "${tournament.name}".`),
            {status: 409}
          );
        }
        openTournamentIds.push(tournamentId);
      }
    }

    if (droppedLadderIds.length > 0) {
      teams.revertPendingTeamsToSaved(db, droppedLadderIds, prev.agentId);
    }

    const keepTournamentAuth = openLadderIds.length === 0 && openTournamentIds.length > 0;
    db.prepare(`
      UPDATE agent_versions
      SET smoke_status = 'passed',
          ladders_json = ?,
          auth_token_encoding = CASE WHEN ? = 1 THEN NULL ELSE auth_token_encoding END,
          activated_at = ?,
          notified = 1
      WHERE id = ?
    `).run(
      JSON.stringify(openLadderIds),
      keepTournamentAuth ? 0 : 1,
      now,
      prev.id
    );

    const retiredByLadder = enrollActivatedVersion(
      db,
      prev,
      openLadderIds,
      openTournamentIds,
      {
        initMillis: prev.smokeInitMillis ?? 0,
        turnMillis: prev.smokeTurnMillis ?? 0,
        peakRam: prev.smokePeakRam ?? 0,
      },
      now
    );

    return {version: getVersionById(db, prev.id)!, agent, retiredByLadder};
  });
}

// Explicit developer rejection (`'staged' -> 'discarded'`) from `/account/`.
// Leaves live ladders untouched, restores any staged `'pending'` VGC team pastes back to `'saved'`,
// and counts toward the rolling 24h retry budget (`MAX_FAILED_SMOKE_TESTS`).
export function discardStagedVersion(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  input: DiscardStagedVersionInput
): AgentVersionRow {
  return inTransaction(() => {
    const prev = getVersionById(db, input.versionId);
    if (!prev) {
      throw Object.assign(new Error(`Unknown versionId ${input.versionId}`), {status: 404});
    }
    if (prev.agentId !== input.agentId) {
      throw Object.assign(new Error('Forbidden.'), {status: 403});
    }
    if (prev.smokeStatus !== 'staged') {
      throw Object.assign(
        new Error(
          `Version "${prev.version}" is "${prev.smokeStatus}" and cannot be discarded.`
        ),
        {status: 409}
      );
    }

    db.prepare(`
      UPDATE agent_versions
      SET smoke_status = 'discarded',
          auth_token_encoding = NULL,
          notified = 1
      WHERE id = ?
    `).run(prev.id);

    teams.revertPendingTeamsToSaved(db, prev.ladders, prev.agentId);
    pruneFailedDiagnosticVersions(db, prev.agentId, prev.ladders, prev.tournaments, prev.id);
    return getVersionById(db, prev.id)!;
  });
}

export function clearVersionAuthToken(db: DatabaseSync, versionId: number) {
  db.prepare('UPDATE agent_versions SET auth_token_encoding = NULL WHERE id = ?').run(versionId);
}

export function getActivatedLadderVersionIds(db: DatabaseSync): number[] {
  const rows = db.prepare(`
    SELECT DISTINCT le.version_id AS id
    FROM ladder_entries le
    JOIN ladders l ON l.id = le.ladder_id
    JOIN agent_versions av ON av.id = le.version_id
    WHERE l.status IN ('upcoming', 'active', 'settling')
      AND le.role IN ('champion', 'challenger')
      AND av.smoke_status = 'passed'
    ORDER BY le.version_id ASC
  `).all() as Array<{id: number}>;
  return rows.map(r => r.id);
}

export function getStagedLadderVersionIds(db: DatabaseSync): number[] {
  const rows = db.prepare(`
    SELECT id
    FROM agent_versions
    WHERE smoke_status = 'staged'
      AND ladders_json != '[]'
    ORDER BY id ASC
  `).all() as Array<{id: number}>;
  return rows.map(r => r.id);
}

export function getAllVersionIds(db: DatabaseSync): number[] {
  const rows = db.prepare(
    'SELECT id FROM agent_versions ORDER BY id ASC'
  ).all() as Array<{id: number}>;
  return rows.map(r => r.id);
}

export function getWipeableVersionIds(db: DatabaseSync): number[] {
  const rows = db.prepare(`
    SELECT av.id
    FROM agent_versions av
    WHERE av.smoke_status != 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM matches m
        WHERE m.p1_version_id = av.id OR m.p2_version_id = av.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM pair_aggregates pa
        WHERE pa.low_version_id = av.id OR pa.high_version_id = av.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM ladder_entries le
        JOIN ladders l ON l.id = le.ladder_id
        WHERE le.version_id = av.id
          AND (le.matches > 0 OR le.is_anchor = 1 OR l.status != 'upcoming')
      )
      AND NOT EXISTS (
        SELECT 1 FROM tournament_matches tm
        WHERE tm.p1_version_id = av.id OR tm.p2_version_id = av.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM tournament_entrants te
        JOIN tournaments t ON t.id = te.tournament_id
        WHERE te.version_id = av.id
          AND t.status IN ('running', 'completed')
      )
      AND NOT EXISTS (
        SELECT 1 FROM agent_ladder_stats als
        WHERE als.max_elo_version_id = av.id
      )
    ORDER BY av.id ASC
  `).all() as Array<{id: number}>;
  return rows.map(r => r.id);
}

// Permanently deletes an unplayed `agent_versions` row and its dependent zero-match rows so staff
// can reclaim a version label, refund its cooldown/smoke budget, and trigger automatic runner
// cleanup of its hot/cold bundles without disturbing `sqlite_sequence` or played match history.
export function wipeVersion(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  versionId: number,
  now = Math.floor(Date.now() / 1000)
): WipeVersionResult {
  return inTransaction(() => {
    const ver = getVersionById(db, versionId);
    if (!ver) {
      throw Object.assign(new Error(`Unknown versionId ${versionId}`), {status: 404});
    }
    const agent = getAgentById(db, ver.agentId);
    if (!agent) {
      throw Object.assign(new Error(`Unknown agentId ${ver.agentId}`), {status: 404});
    }
    if (ver.smokeStatus === 'pending') {
      throw Object.assign(
        new Error(`Version "${ver.version}" is pending smoke testing and cannot be wiped.`),
        {status: 409}
      );
    }

    const hasMatch = db.prepare(`
      SELECT 1 FROM matches WHERE p1_version_id = ? OR p2_version_id = ? LIMIT 1
    `).get(versionId, versionId);
    const hasPair = db.prepare(`
      SELECT 1 FROM pair_aggregates WHERE low_version_id = ? OR high_version_id = ? LIMIT 1
    `).get(versionId, versionId);
    const entryRows = db.prepare(`
      SELECT le.ladder_id, le.matches, le.is_anchor, l.status AS ladder_status, l.team
      FROM ladder_entries le
      JOIN ladders l ON l.id = le.ladder_id
      WHERE le.version_id = ?
    `).all(versionId) as Array<{
      ladder_id: string;
      matches: number;
      is_anchor: number;
      ladder_status: string;
      team: string;
    }>;
    if (hasMatch || hasPair || entryRows.some(r => r.matches > 0)) {
      throw Object.assign(
        new Error(`Version "${ver.version}" has played ladder matches and cannot be wiped.`),
        {status: 409}
      );
    }
    if (entryRows.some(r => r.is_anchor === 1)) {
      throw Object.assign(
        new Error(`Version "${ver.version}" is pinned as a ladder anchor and cannot be wiped.`),
        {status: 409}
      );
    }
    if (entryRows.some(r => r.ladder_status !== 'upcoming')) {
      throw Object.assign(
        new Error(
          `Version "${ver.version}" is enrolled on a live or archived ladder and cannot be wiped.`
        ),
        {status: 409}
      );
    }

    const hasTourneyMatch = db.prepare(`
      SELECT 1 FROM tournament_matches WHERE p1_version_id = ? OR p2_version_id = ? LIMIT 1
    `).get(versionId, versionId);
    if (hasTourneyMatch) {
      throw Object.assign(
        new Error(`Version "${ver.version}" has played tournament matches and cannot be wiped.`),
        {status: 409}
      );
    }
    const lockedTourney = db.prepare(`
      SELECT 1 FROM tournament_entrants te
      JOIN tournaments t ON t.id = te.tournament_id
      WHERE te.version_id = ? AND t.status IN ('running', 'completed')
      LIMIT 1
    `).get(versionId);
    if (lockedTourney) {
      throw Object.assign(
        new Error(
          `Version "${ver.version}" is entered in a running or completed tournament and ` +
          'cannot be wiped.'
        ),
        {status: 409}
      );
    }
    const peakRef = db.prepare(
      'SELECT 1 FROM agent_ladder_stats WHERE max_elo_version_id = ? LIMIT 1'
    ).get(versionId);
    if (peakRef) {
      throw Object.assign(
        new Error(
          `Version "${ver.version}" is referenced by ladder peak stats and cannot be wiped.`
        ),
        {status: 409}
      );
    }

    const touchedLadderIds = new Set<string>([
      ...ver.ladders,
      ...entryRows.map(r => r.ladder_id),
    ]);

    db.prepare('DELETE FROM rating_snapshots WHERE version_id = ?').run(versionId);
    db.prepare('DELETE FROM ladder_entries WHERE version_id = ?').run(versionId);
    db.prepare('DELETE FROM tournament_entrants WHERE version_id = ?').run(versionId);
    db.prepare('DELETE FROM smoke_diagnostics WHERE version_id = ?').run(versionId);
    db.prepare('DELETE FROM agent_versions WHERE id = ?').run(versionId);

    if (ver.smokeStatus === 'staged') {
      teams.revertPendingTeamsToSaved(db, ver.ladders, ver.agentId);
    }

    const inFlightLadders = new Set<string>();
    const inFlightRows = db.prepare(`
      SELECT ladders_json FROM agent_versions
      WHERE agent_id = ? AND smoke_status IN ('pending', 'staged')
    `).all(ver.agentId) as Array<{ladders_json: string}>;
    for (const r of inFlightRows) {
      for (const lid of JSON.parse(r.ladders_json) as string[]) {
        inFlightLadders.add(lid);
      }
    }

    for (const ladderId of touchedLadderIds) {
      const ladder = getLadder(db, ladderId);
      if (ladder?.team !== 'pools' || ladder.status !== 'upcoming') continue;
      const hasEntry = db.prepare(`
        SELECT 1 FROM ladder_entries le
        JOIN agent_versions av ON av.id = le.version_id
        WHERE le.ladder_id = ? AND av.agent_id = ?
        LIMIT 1
      `).get(ladderId, ver.agentId);
      if (hasEntry) continue;
      if (inFlightLadders.has(ladderId)) {
        teams.demoteActiveTeamsToPending(db, ladderId, ver.agentId);
      } else {
        teams.revertActiveTeamsToSaved(db, ladderId, ver.agentId);
      }
    }

    const dayUtc = formatUtcDate(now);
    for (const row of entryRows) {
      entries.promoteRemainingActiveToChampion(db, row.ladder_id, ver.agentId);
      entries.recomputeLadderRatings(db, row.ladder_id, now, undefined, dayUtc);
      const remainingEntries = db.prepare(`
        SELECT 1 FROM ladder_entries le
        JOIN agent_versions av ON av.id = le.version_id
        WHERE le.ladder_id = ? AND av.agent_id = ?
        LIMIT 1
      `).get(row.ladder_id, ver.agentId);
      if (!remainingEntries) {
        db.prepare(`
          DELETE FROM agent_ladder_stats
          WHERE agent_id = ? AND ladder_id = ?
            AND best_rank IS NULL
            AND max_lcb IS NULL
            AND max_elo IS NULL
            AND max_gxe IS NULL
            AND max_win_streak = 0
            AND max_loss_streak = 0
            AND top1_total_seconds = 0
            AND top10_total_seconds = 0
            AND top100_total_seconds = 0
        `).run(ver.agentId, row.ladder_id);
      }
    }

    return {version: ver, agent};
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
    if (ver.smokeStatus !== 'quarantined') {
      throw new Error(
        `Version "${version}" for agent "${agentSlug}" is not quarantined ` +
        `(current status: ${ver.smokeStatus})`
      );
    }
    if (ver.activatedAt === undefined) {
      throw new Error(
        `Version "${version}" for agent "${agentSlug}" never passed smoke testing ` +
        'and cannot be unquarantined'
      );
    }

    db.prepare(
      `UPDATE agent_versions
       SET smoke_status = 'passed',
           smoke_error = NULL,
           activated_at = COALESCE(activated_at, ?),
           notified = 1
       WHERE id = ?`
    ).run(now, ver.id);

    const quarantinedRows = db.prepare(`
      SELECT ladder_id FROM ladder_entries
      WHERE version_id = ? AND role = 'quarantined'
    `).all(ver.id) as Array<{ladder_id: string}>;

    const ladderIds = quarantinedRows.length > 0
      ? quarantinedRows.map(r => r.ladder_id)
      : ver.ladders;

    const dayUtc = formatUtcDate(now);
    for (const ladderId of ladderIds) {
      const ladder = getLadder(db, ladderId);
      if (!ladder) continue;
      if (ladder.status === 'archived') {
        db.prepare(`
          UPDATE ladder_entries
          SET role = 'retired',
              retired_at = COALESCE(retired_at, ?),
              crashes = 0,
              timeouts = 0,
              ooms = 0,
              invalid_choices = 0
          WHERE ladder_id = ? AND version_id = ? AND role = 'quarantined'
        `).run(now, ladderId, ver.id);
        continue;
      }

      const selfEntry = db.prepare(
        'SELECT is_anchor FROM ladder_entries WHERE ladder_id = ? AND version_id = ?'
      ).get(ladderId, ver.id) as {is_anchor: number} | undefined;
      const isSelfAnchor = selfEntry?.is_anchor === 1;

      const otherNonAnchorActive = db.prepare(`
        SELECT le.version_id
        FROM ladder_entries le
        JOIN agent_versions av ON av.id = le.version_id
        WHERE le.ladder_id = ?
          AND av.agent_id = ?
          AND le.version_id != ?
          AND le.role IN ('champion', 'challenger')
          AND le.is_anchor = 0
      `).all(ladderId, ver.agentId, ver.id) as Array<{version_id: number}>;

      const nextRole: entries.EntryRole = !isSelfAnchor && otherNonAnchorActive.length >= 2
        ? 'retired'
        : otherNonAnchorActive.length === 0
          ? 'champion'
          : 'challenger';
      const retiredAt = nextRole === 'retired' ? now : null;

      db.prepare(`
        INSERT INTO ladder_entries (ladder_id, version_id, role, started_at, retired_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(ladder_id, version_id) DO UPDATE SET
          role = excluded.role,
          retired_at = excluded.retired_at,
          crashes = 0,
          timeouts = 0,
          ooms = 0,
          invalid_choices = 0
      `).run(ladderId, ver.id, nextRole, now, retiredAt);

      ensureAgentLadderStats(db, ladderId, ver.agentId);

      if (nextRole !== 'retired') {
        entries.recomputeLadderRatings(db, ladderId, now, undefined, dayUtc);
      }
    }

    for (const tournamentId of ver.tournaments) {
      const tournament = getTournament(db, tournamentId);
      if (tournament?.status !== 'scheduled') continue;
      if (now >= getTournamentClosesAt(tournament.startsAt)) continue;
      const alreadyEntered = db.prepare(
        'SELECT 1 FROM tournament_entrants WHERE tournament_id = ? AND agent_id = ?'
      ).get(tournamentId, ver.agentId);
      if (alreadyEntered) continue;
      const maxRow = db.prepare(
        `SELECT COALESCE(MAX(seed), 0) AS max_seed
         FROM tournament_entrants WHERE tournament_id = ?`
      ).get(tournamentId) as {max_seed: number};
      upsertTournamentEntrant(db, {
        tournamentId,
        agentId: ver.agentId,
        versionId: ver.id,
        seed: maxRow.max_seed + 1,
      });
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
    SELECT
      av.*,
      a.slug AS agent_slug,
      a.name AS agent_name,
      (
        SELECT ${smokeDiagnostics.MIN_INFO_STATUS_SQL}
        FROM smoke_diagnostics sd
        WHERE sd.version_id = av.id
      ) AS min_info_status
    FROM agent_versions av
    JOIN agents a ON a.id = av.agent_id
    WHERE av.smoke_status IN ('staged', 'passed', 'failed', 'quarantined')
      AND av.notified = 0
    ORDER BY av.submitted_at ASC, av.id ASC
  `).all() as unknown as Array<
    RawAgentVersionRow & {
      agent_slug: string;
      agent_name: string;
      min_info_status: smokeDiagnostics.InfoStatus | null;
    }
  >;

  return rows.map(row => ({
    versionId: row.id,
    agentId: row.agent_id,
    agentSlug: row.agent_slug,
    agentName: row.agent_name,
    version: row.version,
    smokeStatus: row.smoke_status as NotifiableSmokeStatus,
    smokeError: row.smoke_error ?? undefined,
    smokeDurationMillis: row.smoke_duration_millis ?? undefined,
    smokeInitMillis: row.smoke_init_millis ?? undefined,
    smokeTeamPreviewMillis: row.smoke_team_preview_millis ?? undefined,
    smokeTurnMillis: row.smoke_turn_millis ?? undefined,
    smokePeakRam: row.smoke_peak_ram ?? undefined,
    ...(row.min_info_status !== null ? {smokeInfoStatus: row.min_info_status} : {}),
    ladders: JSON.parse(row.ladders_json) as string[],
    tournaments: JSON.parse(row.tournaments_json) as string[],
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
