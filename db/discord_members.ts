import type {DatabaseSync} from 'node:sqlite';

import type {TransactionRunner} from './index';

export interface DiscordMemberRow {
  discord_id: string;
  username: string;
  updated_at: number;
}

export function syncDiscordMembers(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  members: Iterable<{id: string; username: string}>,
  now = Math.floor(Date.now() / 1000)
) {
  const clear = db.prepare('DELETE FROM discord_members');
  const insert = db.prepare(
    'INSERT OR REPLACE INTO discord_members (discord_id, username, updated_at) VALUES (?, ?, ?)'
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
  const row = db.prepare('SELECT 1 FROM discord_members WHERE discord_id = ?').get(discordId);
  return row !== undefined;
}
