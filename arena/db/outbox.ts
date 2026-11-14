import {DatabaseSync} from 'node:sqlite';

import * as serverArena from '../../server/arena';

export type OutboxEndpoint = 'match-complete' | 'submission-status' | 'quarantine';
export type OutboxPayload =
  serverArena.MatchCompletePayload |
  serverArena.SubmissionStatusPayload;

export interface OutboxRow {
  id: number;
  endpoint: OutboxEndpoint;
  payloadJson: string;
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt?: number;
}

interface RawOutboxRow {
  id: number;
  endpoint: OutboxEndpoint;
  payload_json: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number | null;
}

function mapOutboxRow(raw: RawOutboxRow): OutboxRow {
  return {
    id: raw.id,
    endpoint: raw.endpoint,
    payloadJson: raw.payload_json,
    attempts: raw.attempts,
    lastError: raw.last_error ?? undefined,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at ?? undefined,
  };
}

export function enqueueOutbox(
  db: DatabaseSync,
  endpoint: OutboxEndpoint,
  payload: OutboxPayload,
  now = Math.floor(Date.now() / 1000)
): number {
  const res = db.prepare(`
    INSERT INTO outbox (endpoint, payload_json, attempts, created_at)
    VALUES (?, ?, 0, ?)
  `).run(endpoint, JSON.stringify(payload), now);
  return Number(res.lastInsertRowid);
}

export function listOutbox(db: DatabaseSync, limit = 100): OutboxRow[] {
  const rows = db.prepare(`
    SELECT * FROM outbox
    ORDER BY id ASC
    LIMIT ?
  `).all(limit) as unknown as RawOutboxRow[];
  return rows.map(mapOutboxRow);
}

export function deleteOutbox(db: DatabaseSync, id: number) {
  db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
}

export function recordOutboxFailure(
  db: DatabaseSync,
  id: number,
  errorMessage: string,
  now = Math.floor(Date.now() / 1000)
) {
  db.prepare(`
    UPDATE outbox
    SET attempts = attempts + 1,
        last_error = ?,
        updated_at = ?
    WHERE id = ?
  `).run(errorMessage.slice(0, 2000), now, id);
}
