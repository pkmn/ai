require('source-map-support').install();

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import {Webhook} from 'standardwebhooks';
import * as yaml from 'yaml';

const root = path.join(__dirname, '..', '..');

const DISCORD_API = 'https://discord.com/api/v10';
const HOOK_PATH = '/hooks/vgc';

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

export function verify(
  body: Buffer, headers: http.IncomingHttpHeaders, webhook: Webhook, lastAccepted: number
): {delivery: Delivery; sent: number} | string {
  let delivery: unknown;
  try {
    delivery = webhook.verify(body, headers as Record<string, string>);
  } catch (err) {
    return (err as Error).message;
  }
  const sent = Number(headers['webhook-timestamp']);
  if (sent <= lastAccepted) return 'already applied';
  return isDelivery(delivery) ? {delivery, sent} : 'unknown version or shape';
}

function isDelivery(value: unknown): value is Delivery {
  const delivery = value as Delivery | null;
  if (typeof value !== 'object' || delivery?.version !== 1) return false;
  if (!Array.isArray(delivery.leaders)) return false;
  return delivery.leaders.every(leader => typeof leader?.ladder === 'string' &&
    (leader.bot === null ||
      (typeof leader.bot?.id === 'string' && typeof leader.bot?.name === 'string')) &&
    (leader.owner === null || typeof leader.owner?.discordId === 'string'));
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
      console.error(`[${leader.ladder}] Could not apply the leader:`, err);
    }
  }
}

export function serve(token: string, secret: string, port: number) {
  const webhook = new Webhook(secret);
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
        const verified = verify(Buffer.concat(chunks), req.headers, webhook, lastAccepted);
        if (typeof verified === 'string') {
          console.log(`Did not apply a delivery: ${verified}`);
          res.writeHead(400).end();
          return;
        }
        lastAccepted = verified.sent;
        res.writeHead(204).end();
        applyLeaders(token, loadConfig(), verified.delivery).catch(err => {
          console.error('Could not apply the ladder leaders:', err);
        });
      } catch (err) {
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
  const secret = process.env.VGC_BOT_WEBHOOK_SECRET;
  if (!token || !secret) {
    console.error('Missing DISCORD_BOT_TOKEN or VGC_BOT_WEBHOOK_SECRET environment variable');
    process.exit(1);
  }
  serve(token, secret, Number(process.env.HOOK_PORT) || 1235);
}
