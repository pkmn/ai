import {DatabaseSync} from 'node:sqlite';

import {TransactionRunner} from './index';

export interface DiscordMemberRow {
  id: string;
  username: string;
  updatedAt: number;
}

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
  const clear = db.prepare('DELETE FROM discord_members');
  const insert = db.prepare(
    'INSERT OR REPLACE INTO discord_members (id, username, updated_at) VALUES (?, ?, ?)'
  );
  inTransaction(() => {
    clear.run();
    for (const m of members) {
      insert.run(m.id, m.username, now);
    }
  });
}

export function isDiscordMember(db: DatabaseSync, discordId: string | undefined): boolean {
  if (!discordId) return false;
  const row = db.prepare('SELECT 1 FROM discord_members WHERE id = ?').get(discordId);
  return row !== undefined;
}
