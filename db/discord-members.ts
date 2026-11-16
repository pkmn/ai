import {DatabaseSync} from 'node:sqlite';

import {TransactionRunner} from './index';

// Atomically replaces the cached Discord guild member roster used by `/auth/discord/validate`
// (Nginx `auth_request` for `/chat/logs/*`). Full-snapshot replacement ensures departed or kicked
// guild members lose `/chat/logs/*` access on the very next sync cycle even while their signed
// `pkmn_session` cookie remains unexpired.
export function syncDiscordMembers(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  members: Iterable<{id: string; username: string}>,
  now = Math.floor(Date.now() / 1000)
) {
  const incoming = new Map<string, string>();
  for (const m of members) {
    incoming.set(m.id, m.username);
  }

  const existingRows = db.prepare('SELECT id, username FROM discord_members')
    .all() as Array<{id: string; username: string}>;
  const existing = new Map(existingRows.map(r => [r.id, r.username]));

  const toDelete: string[] = [];
  for (const id of existing.keys()) {
    if (!incoming.has(id)) toDelete.push(id);
  }
  const toUpsert: Array<{id: string; username: string}> = [];
  for (const [id, username] of incoming) {
    if (existing.get(id) !== username) {
      toUpsert.push({id, username});
    }
  }

  if (toDelete.length === 0 && toUpsert.length === 0) return;

  const del = db.prepare('DELETE FROM discord_members WHERE id = ?');
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO discord_members (id, username, updated_at) VALUES (?, ?, ?)'
  );
  inTransaction(() => {
    for (const id of toDelete) del.run(id);
    for (const m of toUpsert) upsert.run(m.id, m.username, now);
  });
}

export function isDiscordMember(db: DatabaseSync, discordId: string | undefined): boolean {
  if (!discordId) return false;
  const row = db.prepare('SELECT 1 FROM discord_members WHERE id = ?').get(discordId);
  return row !== undefined;
}
