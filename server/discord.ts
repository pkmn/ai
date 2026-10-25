require('source-map-support').install();

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import * as yaml from 'yaml';

const root = path.join(__dirname, '..', '..');

const DISCORD_API = 'https://discord.com/api/v10';
const HOOK_PATH = '/hooks/vgc';
const MAX_AGE_S = 5 * 60;

interface Config {
  guild: string;
  ladders: {[ladder: string]: string};
  bots?: {[bot: string]: string};
}

export interface Delivery {
  version: 1;
  leaders: {
    ladder: string;
    bot: {id: string; name: string} | null;
    owner: {discordId: string} | null;
  }[];
}

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

// Standard Webhooks: HMAC-SHA256 over `<id>.<timestamp>.<body>`, timestamp in seconds.
export function verify(
  body: Buffer,
  headers: http.IncomingHttpHeaders,
  secret: Buffer,
  lastAccepted: number,
  now = Date.now()
) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signature = headers['webhook-signature'];
  if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') {
    throw new Error('unsigned');
  }
  const expected = Buffer.from('v1,' + crypto.createHmac('sha256', secret)
    .update(`${id}.${timestamp}.`).update(body).digest('base64'));
  if (!signature.split(' ').some(s => safeEqual(Buffer.from(s), expected))) {
    throw new Error('bad signature');
  }

  const sent = Number(timestamp);
  if (!Number.isInteger(sent)) throw new Error('bad timestamp');
  if (Math.abs(now / 1000 - sent) > MAX_AGE_S) throw new Error('stale');
  if (sent <= lastAccepted) throw new Error('already applied');

  const delivery: unknown = JSON.parse(body.toString('utf8'));
  if (!isDelivery(delivery)) throw new Error('unknown version or shape');
  return {delivery, sent};
}

function safeEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isDelivery(value: unknown): value is Delivery {
  const delivery = value as Delivery | null;
  return delivery?.version === 1 &&
    Array.isArray(delivery.leaders) &&
    delivery.leaders.every(isLeader);
}

function isLeader(value: unknown): value is Delivery['leaders'][number] {
  const leader = value as Delivery['leaders'][number] | null;
  if (typeof leader?.ladder !== 'string') return false;
  if (leader.bot !== null && typeof leader.bot?.id !== 'string') return false;
  if (leader.bot !== null && typeof leader.bot.name !== 'string') return false;
  return leader.owner === null || typeof leader.owner?.discordId === 'string';
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

function findMember(members: GuildMember[], idOrUsername: string) {
  const lower = idOrUsername.toLowerCase();
  return members.find(m => m.user.id === idOrUsername || m.user.username.toLowerCase() === lower);
}

export async function applyLeaders(token: string, config: Config, delivery: Delivery) {
  const members = await fetchGuildMembers(token, config.guild);
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
      const owner = override
        ? findMember(members, override)
        : members.find(m => m.user.id === leader.owner?.discordId);
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
      console.error(`[${leader.ladder}] Could not apply the leader:`, err);
    }
  }
}

export function serve(token: string, secret: Buffer, port: number) {
  let lastAccepted = 0;

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== HOOK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const {delivery, sent} = verify(Buffer.concat(chunks), req.headers, secret, lastAccepted);
        lastAccepted = sent;
        res.writeHead(204).end();
        applyLeaders(token, loadConfig(), delivery).catch(err => {
          console.error('Could not apply the ladder leaders:', err);
        });
      } catch (err) {
        console.log(`Did not apply a delivery: ${(err as Error).message}`);
        if (!res.headersSent) res.writeHead(400).end();
      }
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Listening for vgc.bot's ladder leaders on 127.0.0.1:${port}${HOOK_PATH}`);
  });
  return server;
}

if (require.main === module) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const secret = process.env.VGC_BOT_WEBHOOK_SECRET;
  if (!token || !secret) {
    const name = token ? 'VGC_BOT_WEBHOOK_SECRET' : 'DISCORD_BOT_TOKEN';
    console.error(`Missing ${name} environment variable`);
    process.exit(1);
  }
  serve(token, Buffer.from(secret, 'base64'), Number(process.env.HOOK_PORT) || 1235);
}
