require('source-map-support').install();

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import * as yaml from 'yaml';

const root = path.join(__dirname, '..', '..');

const DISCORD_API = 'https://discord.com/api/v10';
const HOOK_PATH = '/hooks/vgc';
const MAX_AGE_MS = 5 * 60_000;

interface Config {
  guild: string;
  // vgc.bot ladder id -> Discord role id.
  ladders: {[ladder: string]: string};
  // vgc.bot bot id or name -> Discord user id, only with the owner's agreement.
  bots?: {[bot: string]: string};
}

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

// vgc.bot signs HMAC-SHA256 over `<timestamp>.<raw body>`, timestamp in ms.
// Returns the delivery to apply, or why it is not applied.
export function verify(
  body: Buffer,
  headers: http.IncomingHttpHeaders,
  secret: string,
  lastAccepted: number,
  now = Date.now()
): {delivery: Delivery; sent: number} | string {
  const timestamp = headers['x-arena-timestamp'];
  const signature = headers['x-arena-signature'];
  if (typeof timestamp !== 'string' || typeof signature !== 'string') return 'unsigned';
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return 'bad signature';
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret)
    .update(`${timestamp}.`).update(body).digest('hex'));
  if (!crypto.timingSafeEqual(Buffer.from(signature), expected)) return 'bad signature';

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return 'bad timestamp';
  if (Math.abs(now - sent) > MAX_AGE_MS) return 'stale';
  if (sent <= lastAccepted) return 'already applied';

  let delivery: unknown;
  try {
    delivery = JSON.parse(body.toString('utf8'));
  } catch {
    return 'not JSON';
  }
  return isDelivery(delivery) ? {delivery, sent} : 'unknown version or shape';
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
      const owner = ownerId ? members.find(m => m.user.id === ownerId) : undefined;
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

export function serve(token: string, secret: string, port: number) {
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
        const verified = verify(Buffer.concat(chunks), req.headers, secret, lastAccepted);
        if (typeof verified === 'string') {
          console.log(`Did not apply a delivery: ${verified}`);
          res.writeHead(400).end();
          return;
        }
        lastAccepted = verified.sent;
        // vgc.bot does not wait for the roles: answer first, then apply.
        res.writeHead(204).end();
        applyLeaders(token, loadConfig(), verified.delivery).catch(err => {
          console.error('Could not apply the ladder leaders:', err);
        });
      } catch (err) {
        // Nothing on this unauthenticated path may take the process down.
        console.error('Could not handle a delivery:', err);
        if (!res.headersSent) res.writeHead(500).end();
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
  const secret = process.env.VGC_WEBHOOK_SECRET;
  if (!token || !secret) {
    console.error('Missing DISCORD_BOT_TOKEN or VGC_WEBHOOK_SECRET environment variable');
    process.exit(1);
  }
  serve(token, secret, Number(process.env.HOOK_PORT) || 1235);
}
