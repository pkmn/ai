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

interface Config {
  guild: string;
  // vgc.bot ladder id -> Discord role id.
  ladders: {[ladder: string]: string};
  // vgc.bot bot id or name -> owner's Discord id or username, for a bot someone
  // else registered, with the owner's agreement.
  bots?: {[bot: string]: string};
  // No longer read: vgc.bot sends owners itself.
  authors?: {[author: string]: string};
}

// What vgc.bot posts when a ladder's leader changes, and hourly. Applies idempotently.
interface Delivery {
  version: 1;
  leaders: {
    ladder: string;
    bot: {id: string; name: string} | null;
    // Null unless the owner shared their Discord account.
    owner: {discordId: string} | null;
  }[];
}

interface GuildMember {
  user: {
    id: string;
    username: string;
    global_name?: string | null;
  };
  nick?: string | null;
  roles: string[];
}

function loadConfig(file = path.join(root, 'config', 'discord.yml')): Config {
  return yaml.parse(fs.readFileSync(file, 'utf8')) as Config;
}

// Checks a delivery as vgc.bot signs it: HMAC-SHA256 over `<timestamp>.<raw body>`,
// the timestamp in milliseconds. Returns the delivery, or why it was turned away.
export function verify(
  body: Buffer,
  headers: http.IncomingHttpHeaders,
  secret: string,
  lastAccepted: number,
  now = Date.now()
): Delivery | string {
  const timestamp = headers['x-arena-timestamp'];
  const signature = headers['x-arena-signature'];
  if (typeof timestamp !== 'string' || typeof signature !== 'string') return 'unsigned';

  const expected = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(`${timestamp}.`).update(body).digest('hex');
  if (signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return 'bad signature';
  }

  const sent = Number(timestamp);
  if (!Number.isFinite(sent) || Math.abs(now - sent) > MAX_AGE_MS) return 'stale';
  // A replay, or one that arrived after a later delivery.
  if (sent <= lastAccepted) return 'out of order';

  let delivery: unknown;
  try {
    delivery = JSON.parse(body.toString('utf8'));
  } catch {
    return 'not JSON';
  }
  return isDelivery(delivery) ? delivery : 'unknown version or shape';
}

function isDelivery(value: unknown): value is Delivery {
  const delivery = value as Delivery | null;
  if (typeof value !== 'object' || delivery?.version !== 1) return false;
  if (!Array.isArray(delivery.leaders)) return false;
  return delivery.leaders.every(leader => typeof leader?.ladder === 'string' &&
    (leader.bot === null || typeof leader.bot?.id === 'string') &&
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

// An override may name a member by Discord id or username.
export function findMember(members: GuildMember[], owner?: string): GuildMember | undefined {
  if (!owner) return undefined;
  const lower = owner.toLowerCase();
  return (
    members.find(m => m.user.id === owner) ??
    members.find(m => m.user.username.toLowerCase() === lower) ??
    members.find(m => m.user.global_name?.toLowerCase() === lower) ??
    members.find(m => m.nick?.toLowerCase() === lower)
  );
}

// Makes each configured ladder's role held by its leader's owner and nobody else.
// Ladders the delivery leaves out keep their role as it is.
export async function applyLeaders(token: string, config: Config, delivery: Delivery) {
  const members = await fetchGuildMembers(token, config.guild);
  for (const leader of delivery.leaders) {
    const roleId = config.ladders[leader.ladder];
    if (!roleId) {
      console.log(`[${leader.ladder}] Not a configured ladder, ignored`);
      continue;
    }
    const override = leader.bot &&
      (config.bots?.[leader.bot.id] ?? config.bots?.[leader.bot.name]);
    const owner = override ?? leader.owner?.discordId;
    const target = findMember(members, owner);
    if (owner && !target) console.log(`[${leader.ladder}] ${owner} is not in the server`);

    for (const member of members) {
      if (member.roles.includes(roleId) && member.user.id !== target?.user.id) {
        await discordRequest(
          token,
          `/guilds/${config.guild}/members/${member.user.id}/roles/${roleId}`,
          {method: 'DELETE'}
        );
        console.log(`[${leader.ladder}] Removed role from ${member.user.username}`);
      }
    }
    if (target && !target.roles.includes(roleId)) {
      await discordRequest(
        token,
        `/guilds/${config.guild}/members/${target.user.id}/roles/${roleId}`,
        {method: 'PUT'}
      );
      console.log(`[${leader.ladder}] Gave role to ${target.user.username} (${leader.bot?.name})`);
    }
  }
}

export function serve(token: string, secret: string, port: number) {
  let lastAccepted = 0;
  // Deliveries are applied one at a time; while one is, only the latest waits.
  let waiting: Delivery | undefined;
  let applying = false;
  const drain = async () => {
    applying = true;
    while (waiting) {
      const delivery = waiting;
      waiting = undefined;
      try {
        await applyLeaders(token, loadConfig(), delivery);
      } catch (err) {
        console.error('Could not apply the ladder leaders:', err);
      }
    }
    applying = false;
  };

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== HOOK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const result = verify(Buffer.concat(chunks), req.headers, secret, lastAccepted);
      if (typeof result === 'string') {
        console.log(`Turned away a delivery: ${result}`);
        res.writeHead(result === 'bad signature' || result === 'unsigned' ? 401 : 400).end();
        return;
      }
      lastAccepted = Number(req.headers['x-arena-timestamp']);
      // vgc.bot does not wait for the roles: answer first, then apply.
      res.writeHead(204).end();
      waiting = result;
      if (!applying) drain().catch(err => console.error(err));
    });
  });
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
  serve(token, secret, Number(process.env.DISCORD_PORT) || 1235);
}
