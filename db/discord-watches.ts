import {DatabaseSync} from 'node:sqlite';

import {TransactionRunner} from './index';

export const MAX_WATCHES_PER_USER = 5;
export const WATCH_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface Row {
  id: number;
  discordId: string;
  agentId: number;
  opponentId?: number;
  ladderId?: string;
  tournamentId?: string;
  createdAt: number;
}

export interface View extends Row {
  agentSlug: string;
  agentName: string;
  opponentSlug?: string;
  opponentName?: string;
  ladderName?: string;
  tournamentName?: string;
}

export interface AddInput {
  discordId: string;
  agentId: number;
  opponentId?: number;
  ladderId?: string;
  tournamentId?: string;
  now?: number;
}

export interface AddResult {
  status: 'added' | 'exists' | 'limit';
  watch?: View;
  limit?: number;
}

export interface MatchTarget {
  p1AgentId: number;
  p2AgentId: number;
  ladderId?: string;
  tournamentId?: string;
}

export interface WatchableAgent {
  id: number;
  slug: string;
  name: string;
  active: boolean;
}

interface RawWatchViewRow {
  id: number;
  discord_id: string;
  agent_id: number;
  opponent_id: number | null;
  ladder_id: string | null;
  tournament_id: string | null;
  created_at: number;
  agent_slug: string;
  agent_name: string;
  opponent_slug: string | null;
  opponent_name: string | null;
  ladder_name: string | null;
  tournament_name: string | null;
}

const SELECT_WATCH_VIEW = `
  SELECT
    w.id,
    w.discord_id,
    w.agent_id,
    w.opponent_id,
    w.ladder_id,
    w.tournament_id,
    w.created_at,
    a.slug AS agent_slug,
    a.name AS agent_name,
    o.slug AS opponent_slug,
    o.name AS opponent_name,
    l.name AS ladder_name,
    t.name AS tournament_name
  FROM discord_watches w
  JOIN agents a ON a.id = w.agent_id
  LEFT JOIN agents o ON o.id = w.opponent_id
  LEFT JOIN ladders l ON l.id = w.ladder_id
  LEFT JOIN tournaments t ON t.id = w.tournament_id
`;

function mapWatchView(raw: RawWatchViewRow): View {
  return {
    id: raw.id,
    discordId: raw.discord_id,
    agentId: raw.agent_id,
    opponentId: raw.opponent_id ?? undefined,
    ladderId: raw.ladder_id ?? undefined,
    tournamentId: raw.tournament_id ?? undefined,
    createdAt: raw.created_at,
    agentSlug: raw.agent_slug,
    agentName: raw.agent_name,
    opponentSlug: raw.opponent_slug ?? undefined,
    opponentName: raw.opponent_name ?? undefined,
    ladderName: raw.ladder_name ?? undefined,
    tournamentName: raw.tournament_name ?? undefined,
  };
}

function canonicalizeAgents(
  agentId: number,
  opponentId?: number
): {agentId: number; opponentId?: number} {
  if (opponentId === undefined) return {agentId};
  if (opponentId === agentId) {
    throw new Error('Opponent must be a different agent');
  }
  return agentId < opponentId
    ? {agentId, opponentId}
    : {agentId: opponentId, opponentId: agentId};
}

function getWatchViewById(db: DatabaseSync, id: number): View | undefined {
  const raw = db.prepare(`${SELECT_WATCH_VIEW} WHERE w.id = ?`)
    .get(id) as unknown as RawWatchViewRow | undefined;
  return raw ? mapWatchView(raw) : undefined;
}

export function addWatch(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  input: AddInput
): AddResult {
  if (input.ladderId && input.tournamentId) {
    throw new Error('Watch cannot target both a ladder and a tournament');
  }
  const {agentId, opponentId} = canonicalizeAgents(input.agentId, input.opponentId);
  const ladderId = input.ladderId ?? null;
  const tournamentId = input.tournamentId ?? null;
  const now = input.now ?? Math.floor(Date.now() / 1000);

  return inTransaction(() => {
    const existing = db.prepare(`
      ${SELECT_WATCH_VIEW}
      WHERE w.discord_id = ?
        AND w.agent_id = ?
        AND COALESCE(w.opponent_id, 0) = ?
        AND COALESCE(w.ladder_id, '') = ?
        AND COALESCE(w.tournament_id, '') = ?
    `).get(
      input.discordId,
      agentId,
      opponentId ?? 0,
      ladderId ?? '',
      tournamentId ?? ''
    ) as unknown as RawWatchViewRow | undefined;
    if (existing) {
      return {status: 'exists', watch: mapWatchView(existing)};
    }

    const {count} = db.prepare(
      'SELECT COUNT(*) AS count FROM discord_watches WHERE discord_id = ?'
    ).get(input.discordId) as {count: number};
    if (count >= MAX_WATCHES_PER_USER) {
      return {status: 'limit', limit: MAX_WATCHES_PER_USER};
    }

    const res = db.prepare(`
      INSERT INTO discord_watches (
        discord_id, agent_id, opponent_id, ladder_id, tournament_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.discordId, agentId, opponentId ?? null, ladderId, tournamentId, now);
    const watch = getWatchViewById(db, Number(res.lastInsertRowid))!;
    return {status: 'added', watch};
  });
}

export function listWatchesForUser(db: DatabaseSync, discordId: string): View[] {
  const rows = db.prepare(`
    ${SELECT_WATCH_VIEW}
    WHERE w.discord_id = ?
    ORDER BY w.created_at ASC, w.id ASC
  `).all(discordId) as unknown as RawWatchViewRow[];
  return rows.map(mapWatchView);
}

export function deleteWatchForUser(
  db: DatabaseSync,
  discordId: string,
  watchId: number
): boolean {
  const res = db.prepare(
    'DELETE FROM discord_watches WHERE id = ? AND discord_id = ?'
  ).run(watchId, discordId);
  return Number(res.changes) > 0;
}

export function clearWatchesForUser(db: DatabaseSync, discordId: string): number {
  const res = db.prepare(
    'DELETE FROM discord_watches WHERE discord_id = ?'
  ).run(discordId);
  return Number(res.changes);
}

// Atomically selects and deletes all watches matching a live match or tournament game so repeated
// heartbeats or multi-game tournament batches never fire duplicate DMs.
export function consumeMatchingWatches(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  target: MatchTarget
): View[] {
  const low = Math.min(target.p1AgentId, target.p2AgentId);
  const high = Math.max(target.p1AgentId, target.p2AgentId);

  return inTransaction(() => {
    let rows: RawWatchViewRow[];
    if (target.ladderId) {
      rows = db.prepare(`
        ${SELECT_WATCH_VIEW}
        WHERE (
          (w.opponent_id IS NULL AND (w.agent_id = ? OR w.agent_id = ?))
          OR (w.opponent_id IS NOT NULL AND w.agent_id = ? AND w.opponent_id = ?)
        )
          AND w.tournament_id IS NULL
          AND (w.ladder_id IS NULL OR w.ladder_id = ?)
        ORDER BY w.created_at ASC, w.id ASC
      `).all(
        target.p1AgentId,
        target.p2AgentId,
        low,
        high,
        target.ladderId
      ) as unknown as RawWatchViewRow[];
    } else if (target.tournamentId) {
      rows = db.prepare(`
        ${SELECT_WATCH_VIEW}
        WHERE (
          (w.opponent_id IS NULL AND (w.agent_id = ? OR w.agent_id = ?))
          OR (w.opponent_id IS NOT NULL AND w.agent_id = ? AND w.opponent_id = ?)
        )
          AND w.ladder_id IS NULL
          AND (w.tournament_id IS NULL OR w.tournament_id = ?)
        ORDER BY w.created_at ASC, w.id ASC
      `).all(
        target.p1AgentId,
        target.p2AgentId,
        low,
        high,
        target.tournamentId
      ) as unknown as RawWatchViewRow[];
    } else {
      rows = db.prepare(`
        ${SELECT_WATCH_VIEW}
        WHERE (
          (w.opponent_id IS NULL AND (w.agent_id = ? OR w.agent_id = ?))
          OR (w.opponent_id IS NOT NULL AND w.agent_id = ? AND w.opponent_id = ?)
        )
          AND w.ladder_id IS NULL
          AND w.tournament_id IS NULL
        ORDER BY w.created_at ASC, w.id ASC
      `).all(target.p1AgentId, target.p2AgentId, low, high) as unknown as RawWatchViewRow[];
    }

    if (rows.length === 0) return [];
    const del = db.prepare('DELETE FROM discord_watches WHERE id = ?');
    for (const row of rows) {
      del.run(row.id);
    }
    return rows.map(mapWatchView);
  });
}

export function pruneExpiredWatches(
  db: DatabaseSync,
  now = Math.floor(Date.now() / 1000)
): number {
  const cutoff = now - WATCH_TTL_SECONDS;
  const res = db.prepare(`
    DELETE FROM discord_watches
    WHERE created_at < ?
      OR (
        ladder_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM ladders l
          WHERE l.id = discord_watches.ladder_id AND l.status = 'archived'
        )
      )
      OR (
        tournament_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM tournaments t
          WHERE t.id = discord_watches.tournament_id AND t.status = 'completed'
        )
      )
  `).run(cutoff);
  return Number(res.changes);
}

export function listWatchableAgents(db: DatabaseSync): WatchableAgent[] {
  const rows = db.prepare(`
    SELECT
      a.id,
      a.slug,
      a.name,
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM ladder_entries le
          JOIN agent_versions av ON av.id = le.version_id
          JOIN ladders l ON l.id = le.ladder_id
          WHERE av.agent_id = a.id
            AND le.role IN ('champion', 'challenger')
            AND l.status != 'archived'
        ) OR EXISTS (
          SELECT 1
          FROM tournament_entrants te
          JOIN tournaments t ON t.id = te.tournament_id
          WHERE te.agent_id = a.id
            AND t.status != 'completed'
        ) THEN 1
        ELSE 0
      END AS active
    FROM agents a
    WHERE a.status != 'disabled'
    ORDER BY active DESC, a.name COLLATE NOCASE ASC
  `).all() as Array<{id: number; slug: string; name: string; active: number}>;
  return rows.map(r => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    active: r.active === 1,
  }));
}
