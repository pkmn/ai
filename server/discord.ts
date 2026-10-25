require('source-map-support').install();

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import * as yaml from 'yaml';

const root = path.join(__dirname, '..', '..');

const DISCORD_API = 'https://discord.com/api/v10';
// Where vgc.bot posts the ladder leaders.
const HOOK_PATH = '/hooks/vgc';
// Deliveries signed longer ago than this are turned away as replays.
const MAX_AGE_MS = 5 * 60_000;
const MAX_BODY_BYTES = 16 * 1024;
// A delivery that failed to apply is tried again this often until it succeeds or a
// newer one replaces it.
const RECONCILE_MS = 60_000;

interface Config {
  guild: string;
  // vgc.bot ladder id -> Discord role id.
  ladders: {[ladder: string]: string};
  // vgc.bot bot id or name -> owner's Discord id or username, for a bot someone
  // else registered, with the owner's agreement.
  bots?: {[bot: string]: string};
}

// What vgc.bot posts when a ladder's leader changes, and hourly. Applies idempotently.
// Mirrors LeadersDelivery in vgc.bot's shared/api.ts (lucaspellegrinelli/pkmn-arena).
export interface Delivery {
  version: 1;
  leaders: {
    ladder: string;
    bot: {id: string; name: string} | null;
    // Null unless the owner shared their Discord account.
    owner: {discordId: string} | null;
  }[];
}

// A delivery to apply, one to ignore, or a rejection with the status to answer.
export type Verified =
  {kind: 'apply'; delivery: Delivery; sent: number} |
  {kind: 'ignore'; reason: string} |
  {kind: 'reject'; status: 400 | 401; reason: string};

interface GuildMember {
  user: {
    id: string;
    username: string;
  };
  roles: string[];
}

function loadConfig(file = path.join(root, 'config', 'discord.yml')): Config {
  return yaml.parse(fs.readFileSync(file, 'utf8')) as Config;
}

// Checks a delivery as vgc.bot signs it: HMAC-SHA256 over `<timestamp>.<raw body>`,
// the timestamp in milliseconds.
export function verify(
  body: Buffer,
  headers: http.IncomingHttpHeaders,
  secret: string,
  lastAccepted: number,
  now = Date.now()
): Verified {
  const timestamp = headers['x-arena-timestamp'];
  const signature = headers['x-arena-signature'];
  if (typeof timestamp !== 'string' || typeof signature !== 'string') {
    return {kind: 'reject', status: 401, reason: 'unsigned'};
  }

  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret)
    .update(`${timestamp}.`).update(body).digest('hex'));
  // Compare bytes, not characters: Node decodes header bytes as latin1, so a
  // same-length signature can still be longer, which makes timingSafeEqual throw.
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return {kind: 'reject', status: 401, reason: 'bad signature'};
  }

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return {kind: 'reject', status: 400, reason: 'bad timestamp'};
  if (Math.abs(now - sent) > MAX_AGE_MS) {
    return {kind: 'reject', status: 400, reason: 'stale'};
  }
  // Already applied: idempotent, so acknowledge it without applying it again.
  if (sent <= lastAccepted) return {kind: 'ignore', reason: 'already applied'};

  let delivery: unknown;
  try {
    delivery = JSON.parse(body.toString('utf8'));
  } catch {
    return {kind: 'reject', status: 400, reason: 'not JSON'};
  }
  if (!isDelivery(delivery)) {
    return {kind: 'reject', status: 400, reason: 'unknown version or shape'};
  }
  return {kind: 'apply', delivery, sent};
}

function isDelivery(value: unknown): value is Delivery {
  const delivery = value as Delivery | null;
  if (typeof value !== 'object' || delivery?.version !== 1) return false;
  if (!Array.isArray(delivery.leaders)) return false;
  return delivery.leaders.every(leader => typeof leader?.ladder === 'string' &&
    (leader.bot === null ||
      (typeof leader.bot?.id === 'string' && typeof leader.bot?.name === 'string')) &&
    (leader.owner === null || /^\d+$/.test(leader.owner?.discordId ?? '')));
}

async function discordRequest(token: string, endpoint: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${DISCORD_API}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      ...init?.headers,
    },
  });
  if (res.status === 429) {
    const body = await res.json().catch(() => ({})) as {retry_after?: number};
    const waitMs = Math.ceil((body.retry_after ?? 1) * 1000);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    return discordRequest(token, endpoint, init);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const method = init?.method ?? 'GET';
    throw new Error(`Discord API ${method} ${endpoint} failed (${res.status}): ${text}`);
  }
  if (res.status === 204) return undefined;
  return res.json();
}

// Needs the Server Members privileged intent.
async function fetchGuildMembers(token: string, guild: string): Promise<GuildMember[]> {
  const all: GuildMember[] = [];
  let after = '0';
  while (true) {
    const page = await discordRequest(
      token,
      `/guilds/${guild}/members?limit=1000&after=${after}`
    ) as GuildMember[];
    all.push(...page);
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
  return all;
}

// An override names its owner by Discord id or username.
export function findMember(members: GuildMember[], owner?: string): GuildMember | undefined {
  if (!owner) return undefined;
  const lower = owner.toLowerCase();
  return members.find(m => m.user.id === owner) ??
    members.find(m => m.user.username.toLowerCase() === lower);
}

// Makes each configured ladder's role held by its leader's owner and nobody else.
// Ladders the delivery leaves out keep their role as it is. Returns false if any
// ladder failed, so the caller can retry.
export async function applyLeaders(
  token: string, config: Config, delivery: Delivery
): Promise<boolean> {
  const members = await fetchGuildMembers(token, config.guild);
  let failed = false;
  for (const leader of delivery.leaders) {
    const roleId = config.ladders[leader.ladder];
    if (!roleId) {
      console.log(`[${leader.ladder}] Not a configured ladder, ignored`);
      continue;
    }
    try {
      const override = leader.bot &&
        (config.bots?.[leader.bot.id] ?? config.bots?.[leader.bot.name]);
      const ownerId = override ?? leader.owner?.discordId;
      let owner: GuildMember | undefined;
      if (override) {
        owner = findMember(members, override);
      } else if (leader.owner) {
        // vgc.bot's id must match the member's id: a nickname or username is
        // neither unique nor controlled by the owner.
        const discordId = leader.owner.discordId;
        owner = members.find(m => m.user.id === discordId);
      }
      if (ownerId && !owner) console.log(`[${leader.ladder}] ${ownerId} is not in the server`);

      for (const member of members) {
        if (member.roles.includes(roleId) && member.user.id !== owner?.user.id) {
          await discordRequest(
            token,
            `/guilds/${config.guild}/members/${member.user.id}/roles/${roleId}`,
            {method: 'DELETE'}
          );
          console.log(`[${leader.ladder}] Removed role from ${member.user.username}`);
        }
      }
      if (owner && !owner.roles.includes(roleId)) {
        await discordRequest(
          token,
          `/guilds/${config.guild}/members/${owner.user.id}/roles/${roleId}`,
          {method: 'PUT'}
        );
        console.log(`[${leader.ladder}] Gave role to ${owner.user.username} (${leader.bot?.name})`);
      }
    } catch (err) {
      failed = true;
      console.error(`[${leader.ladder}] Could not apply the leader:`, err);
    }
  }
  return !failed;
}

// Applies the newest delivery it is offered, trying a failed one again on every tick.
export function reconciler(
  apply: (delivery: Delivery) => Promise<boolean>, everyMs: number
) {
  let pending: Delivery | undefined;
  let applying = false;
  const tick = async () => {
    if (applying || !pending) return;
    const delivery = pending;
    applying = true;
    let ok: boolean;
    try {
      ok = await apply(delivery);
    } catch (err) {
      console.error('Could not apply the ladder leaders:', err);
      ok = false;
    }
    applying = false;
    if (ok && pending === delivery) pending = undefined;
    // A newer delivery that arrived while applying goes right away.
    if (pending !== delivery) await tick();
  };
  const interval = setInterval(() => {
    tick().catch(err => console.error(err));
  }, everyMs);
  interval.unref();
  return {
    offer(delivery: Delivery) {
      pending = delivery;
      tick().catch(err => console.error(err));
    },
    stop() {
      clearInterval(interval);
    },
  };
}

export function serve(token: string, secret: string, port: number) {
  let lastAccepted = 0;
  const queue = reconciler(
    delivery => applyLeaders(token, loadConfig(), delivery),
    RECONCILE_MS
  );

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== HOOK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on('data', (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering, but do not destroy the socket: that can drop the 413.
        oversized = true;
        res.writeHead(413, {Connection: 'close'}).end();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        if (oversized || res.writableEnded) return;
        const verified = verify(Buffer.concat(chunks), req.headers, secret, lastAccepted);
        switch (verified.kind) {
          case 'ignore':
            console.log(`Ignored a delivery: ${verified.reason}`);
            res.writeHead(204).end();
            return;
          case 'reject':
            console.log(`Turned away a delivery: ${verified.reason}`);
            res.writeHead(verified.status).end();
            return;
          case 'apply':
            lastAccepted = verified.sent;
            // vgc.bot does not wait for the roles: answer first, then apply.
            res.writeHead(204).end();
            queue.offer(verified.delivery);
            return;
        }
      } catch (err) {
        // Nothing on this unauthenticated path may take the process down.
        console.error('Could not handle a delivery:', err);
        if (!res.headersSent) res.writeHead(500).end();
      }
    });
  });
  server.on('close', () => queue.stop());
  server.listen(port, '127.0.0.1', () => {
    console.log(`Listening for vgc.bot's ladder leaders on 127.0.0.1:${port}${HOOK_PATH}`);
  });
  return server;
}

if (require.main === module) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const secret = process.env.VGC_WEBHOOK_SECRET;
  if (!token || !secret) {
    console.error('Missing DISCORD_BOT_TOKEN or VGC_WEBHOOK_SECRET environment variable');
    process.exit(1);
  }
  serve(token, secret, Number(process.env.HOOK_PORT) || 1235);
}
