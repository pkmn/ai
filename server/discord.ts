require('source-map-support').install();

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import * as yaml from 'yaml';

const root = path.join(__dirname, '..', '..');

const DISCORD_API = 'https://discord.com/api/v10';
const VOUCH_VALIDATE = 'http://127.0.0.1:9090/vouch/validate';
const AUTH_PORT = 9091;
const SITES = ['vgc.bot', 'pkmn.bot'];
const CYCLE_MS = 60_000;

interface Config {
  guild: string;
  channel?: string;
  ladders: {[ladder: string]: string};
  bots?: {[bot: string]: string};
  authors?: {[author: string]: string};
}

export interface Leader {
  ladder: string;
  bot: {id: string; name: string} | null;
  owner: {name: string; discordId: string | null} | null;
}

// A member id, or a name to look a member up by.
export type Owner = {id: string} | {name: string};

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string;
}

export interface GuildMember {
  user: DiscordUser;
  nick?: string;
  roles: string[];
}

export interface GuildChannel {
  id: string;
  name: string;
}

export interface GuildRole {
  id: string;
  name: string;
}

export interface DiscordEmbed {
  type?: string;
  title?: string;
  description?: string;
  url?: string;
  fields?: Array<{name: string; value: string}>;
}

export interface DiscordPoll {
  question: {text?: string};
  answers: Array<{
    answer_id: number;
    poll_media: {text?: string; emoji?: {name?: string}};
  }>;
  results?: {
    answer_counts: Array<{id: number; count: number}>;
  };
}

export interface DiscordMessageBody {
  content?: string;
  mentions?: DiscordUser[];
  attachments?: Array<{url: string}>;
  embeds?: DiscordEmbed[];
  sticker_items?: Array<{name: string}>;
  poll?: DiscordPoll;
}

export interface DiscordMessage extends DiscordMessageBody {
  id: string;
  type?: number;
  timestamp: string;
  content: string;
  author: DiscordUser;
  referenced_message?: DiscordMessage | null;
  message_snapshots?: Array<{message: DiscordMessageBody}>;
}

function loadConfig(file = path.join(root, 'config', 'discord.yml')): Config {
  return yaml.parse(fs.readFileSync(file, 'utf8')) as Config;
}

export function ownerOf(leader: Leader, config: Config): Owner | undefined {
  const override = leader.bot && (config.bots?.[leader.bot.id] ?? config.bots?.[leader.bot.name]);
  if (override) return {name: override};
  if (!leader.owner) return undefined;
  if (leader.owner.discordId) return {id: leader.owner.discordId};
  return {name: config.authors?.[leader.owner.name] ?? leader.owner.name};
}

export function findMember(members: GuildMember[], owner: Owner): GuildMember | undefined {
  if ('id' in owner) return members.find(m => m.user.id === owner.id);
  const lower = owner.name.toLowerCase();
  return (
    members.find(m => m.user.id === owner.name) ??
    members.find(m => m.user.username.toLowerCase() === lower) ??
    members.find(m => m.user.global_name?.toLowerCase() === lower) ??
    members.find(m => m.nick?.toLowerCase() === lower)
  );
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

export async function fetchGuildMembers(token: string, guild: string): Promise<GuildMember[]> {
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

export async function fetchGuildChannels(token: string, guild: string): Promise<GuildChannel[]> {
  return await discordRequest(token, `/guilds/${guild}/channels`) as GuildChannel[];
}

export async function fetchGuildRoles(token: string, guild: string): Promise<GuildRole[]> {
  return await discordRequest(token, `/guilds/${guild}/roles`) as GuildRole[];
}

export async function fetchLeaders(site: string, vgcToken: string): Promise<Leader[]> {
  const res = await fetch(`https://${site}/api/partner/leaders`, {
    headers: {Authorization: `Bearer ${vgcToken}`},
  });
  if (!res.ok) {
    throw new Error(`${site} API failed (${res.status})`);
  }
  const data = await res.json() as {leaders: Leader[]};
  return data.leaders;
}

// Fetches the members only when some ladder's owner changed since the last cycle.
export async function syncRoles(
  token: string,
  vgcToken: string,
  config: Config,
  state: Map<string, string | undefined>,
  members?: GuildMember[]
) {
  const leaders: Leader[] = [];
  for (const site of SITES) {
    try {
      leaders.push(...await fetchLeaders(site, vgcToken));
    } catch (err) {
      console.error(`Error fetching leaders from ${site}:`, err);
    }
  }
  for (const leader of leaders) {
    const roleId = config.ladders[leader.ladder];
    if (!roleId) continue;
    const owner = ownerOf(leader, config);
    const key = owner && JSON.stringify(owner);
    if (state.has(leader.ladder) && state.get(leader.ladder) === key) continue;

    try {
      members ??= await fetchGuildMembers(token, config.guild);
      const target = owner && findMember(members, owner);

      for (const member of members) {
        if (member.roles.includes(roleId) && member.user.id !== target?.user.id) {
          await discordRequest(
            token,
            `/guilds/${config.guild}/members/${member.user.id}/roles/${roleId}`,
            {method: 'DELETE'}
          );
          console.log(`[${leader.ladder}] Removed role ${roleId} from ${member.user.username}`);
        }
      }

      if (target && !target.roles.includes(roleId)) {
        await discordRequest(
          token,
          `/guilds/${config.guild}/members/${target.user.id}/roles/${roleId}`,
          {method: 'PUT'}
        );
        const who = `${target.user.username} (${leader.bot?.name})`;
        console.log(`[${leader.ladder}] Assigned role ${roleId} to ${who}`);
      } else if (owner && !target) {
        const who = 'id' in owner ? owner.id : owner.name;
        console.log(`[${leader.ladder}] ${who} is not in the server`);
      }

      if (!owner || target) {
        state.set(leader.ladder, key);
      } else {
        state.delete(leader.ladder);
      }
    } catch (err) {
      console.error(`[${leader.ladder}] Error syncing role:`, err);
    }
  }
}

function displayName(user: DiscordUser, members?: GuildMember[]): string {
  const member = members?.find(m => m.user.id === user.id);
  return member?.nick ?? member?.user.global_name ?? user.global_name ?? user.username;
}

function resolveText(
  raw: string,
  mentions?: DiscordUser[],
  members?: GuildMember[],
  channels?: GuildChannel[],
  roles?: GuildRole[]
): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/<@!?(\d+)>/g, (match, id: string) => {
      const user =
        mentions?.find(u => u.id === id) ??
        members?.find(m => m.user.id === id)?.user;
      return user ? `@${displayName(user, members)}` : match;
    })
    .replace(/<#(\d+)>/g, (match, id: string) => {
      const name = channels?.find(c => c.id === id)?.name;
      return name ? `#${name}` : match;
    })
    .replace(/<@&(\d+)>/g, (match, id: string) => {
      const name = roles?.find(r => r.id === id)?.name;
      return name ? `@${name}` : match;
    })
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_, sec: string) => {
      const d = new Date(Number(sec) * 1000);
      return isNaN(d.getTime()) ? _ : `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
    })
    .trim();
}

function formatPoll(poll: DiscordPoll): string {
  const q = poll.question.text?.trim() ?? 'Poll';
  const counts = new Map(poll.results?.answer_counts.map(c => [c.id, c.count]));
  const answers = poll.answers.map((a, i) => {
    const emoji = a.poll_media.emoji?.name ? `${a.poll_media.emoji.name} ` : '';
    const label = `${emoji}${a.poll_media.text ?? ''}`.trim();
    const count = counts.get(a.answer_id);
    return `${i + 1}. ${label}${count !== undefined ? ` (${count})` : ''}`;
  });
  return `[Poll: ${q}]${answers.length ? ` ${answers.join(' | ')}` : ''}`;
}

function formatBody(
  body: DiscordMessageBody,
  members?: GuildMember[],
  channels?: GuildChannel[],
  roles?: GuildRole[]
): string {
  const text = resolveText(body.content ?? '', body.mentions, members, channels, roles);
  const poll = body.poll ? formatPoll(body.poll) : '';
  const attachments = body.attachments?.map(a => a.url.split('?')[0]) ?? [];
  const embeds: string[] = [];
  for (const embed of body.embeds ?? []) {
    if (text && embed.type !== 'rich') continue;
    const parts: string[] = [];
    if (embed.title) parts.push(resolveText(embed.title, body.mentions, members, channels, roles));
    if (embed.description) {
      parts.push(resolveText(embed.description, body.mentions, members, channels, roles));
    }
    for (const f of embed.fields ?? []) {
      const name = resolveText(f.name, body.mentions, members, channels, roles);
      const val = resolveText(f.value, body.mentions, members, channels, roles);
      parts.push(`${name}: ${val}`);
    }
    if (embed.url && !text.includes(embed.url)) parts.push(embed.url);
    if (parts.length) embeds.push(`[Embed: ${parts.join(' — ')}]`);
  }
  const stickers = body.sticker_items?.map(s => `[Sticker: ${s.name}]`) ?? [];
  return [text, poll, ...attachments, ...embeds, ...stickers].filter(Boolean).join(' ');
}

export function formatMessage(
  message: DiscordMessage,
  members?: GuildMember[],
  channels?: GuildChannel[],
  roles?: GuildRole[]
): {date: string; line: string} | undefined {
  // 0 = DEFAULT, 19 = REPLY, 20 = CHAT_INPUT_COMMAND, 21 = THREAD_STARTER_MESSAGE
  if (
    message.type !== undefined &&
    message.type !== 0 &&
    message.type !== 19 &&
    message.type !== 20 &&
    message.type !== 21
  ) {
    return undefined;
  }

  const main = formatBody(message, members, channels, roles);
  const snapshots = (message.message_snapshots ?? [])
    .map(s => formatBody(s.message, members, channels, roles))
    .filter(Boolean)
    .map(s => `[Forwarded] ${s}`);
  const content = [main, ...snapshots].filter(Boolean).join(' ');
  if (!content) return undefined;

  const iso = new Date(message.timestamp).toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 19);

  let prefix = '';
  const ref = message.referenced_message;
  if (ref) {
    const refIso = new Date(ref.timestamp).toISOString();
    const refDate = refIso.slice(0, 10);
    const refTime = refIso.slice(11, 19);
    const stamp = refDate === date ? refTime : `${refDate} ${refTime}`;
    prefix = `@${displayName(ref.author, members)}[${stamp}] `;
  } else if (message.type === 19) {
    prefix = '@[deleted] ';
  }

  return {date, line: `[${time}] ${displayName(message.author, members)}: ${prefix}${content}`};
}

export async function syncMessages(
  token: string,
  channel: string,
  dir = path.join(root, 'logs'),
  members?: GuildMember[],
  channels?: GuildChannel[],
  roles?: GuildRole[]
) {
  fs.mkdirSync(dir, {recursive: true});
  const cursorFile = path.join(dir, '.cursor');
  let after = '0';
  const tailOffsets = new Map<string, number>();
  if (fs.existsSync(cursorFile)) {
    const lines = fs.readFileSync(cursorFile, 'utf8').trim().split('\n');
    after = lines[0]?.trim() || '0';
    for (let i = 1; i < lines.length; i++) {
      const [file, sizeStr] = lines[i].trim().split(' ');
      const size = Number(sizeStr);
      if (file && !isNaN(size)) tailOffsets.set(file, size);
    }
  }

  function restoreTail() {
    for (const [file, size] of tailOffsets) {
      const full = path.join(dir, file);
      if (size === 0) {
        fs.rmSync(full, {force: true});
      } else if (fs.existsSync(full)) {
        fs.truncateSync(full, size);
      }
    }
    tailOffsets.clear();
  }

  function writeSlice(slice: DiscordMessage[], recordOffsets: boolean) {
    const byDate = new Map<string, string[]>();
    for (let i = slice.length - 1; i >= 0; i--) {
      const formatted = formatMessage(slice[i], members, channels, roles);
      if (!formatted) continue;
      let lines = byDate.get(formatted.date);
      if (!lines) {
        lines = [];
        byDate.set(formatted.date, lines);
      }
      lines.push(formatted.line);
    }

    for (const [date, lines] of byDate) {
      const file = `${date}.txt`;
      const full = path.join(dir, file);
      if (recordOffsets && !tailOffsets.has(file)) {
        tailOffsets.set(file, fs.existsSync(full) ? fs.statSync(full).size : 0);
      }
      fs.appendFileSync(full, `${lines.join('\n')}\n`);
    }
  }

  function saveCursor() {
    const offsetLines = Array.from(tailOffsets.entries()).map(([f, s]) => `${f} ${s}`);
    fs.writeFileSync(cursorFile, `${[after, ...offsetLines].join('\n')}\n`);
  }

  let page = await discordRequest(
    token,
    `/channels/${channel}/messages?limit=100&after=${after}`
  ) as DiscordMessage[];
  restoreTail();

  while (page.length === 100) {
    const next = await discordRequest(
      token,
      `/channels/${channel}/messages?limit=100&after=${page[0].id}`
    ) as DiscordMessage[];
    if (next.length > 0) {
      writeSlice(page, false);
      after = page[0].id;
      saveCursor();
      page = next;
    } else {
      writeSlice(page.slice(50), false);
      after = page[50].id;
      page = page.slice(0, 50);
      break;
    }
  }

  if (page.length > 0) {
    writeSlice(page, true);
  }
  saveCursor();
}

export async function validateAuth(
  url: string | undefined,
  reqHeaders: http.IncomingHttpHeaders,
  members: Set<string>
): Promise<{status: number; headers: Record<string, string>}> {
  if (url !== '/vouch/validate') {
    return {status: 404, headers: {}};
  }

  const forwarded: Record<string, string> = {};
  for (const key of ['cookie', 'authorization', 'x-vouch-token', 'host']) {
    const val = reqHeaders[key];
    if (typeof val === 'string') forwarded[key] = val;
  }

  const res = await fetch(VOUCH_VALIDATE, {headers: forwarded});
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith('x-vouch-')) {
      headers[key] = value;
    }
  });

  if (res.status !== 200) {
    return {status: res.status, headers};
  }

  const user = res.headers.get('x-vouch-user');
  return {status: user && members.has(user) ? 200 : 403, headers};
}

export async function run(token: string, vgcToken: string, once = false) {
  const state = new Map<string, string | undefined>();
  let memberIds = new Set<string>();

  const server = once
    ? undefined
    : http.createServer((req, res) => {
      validateAuth(req.url, req.headers, memberIds)
        .then(({status, headers}) => {
          res.writeHead(status, headers);
          res.end();
        })
        .catch(err => {
          console.error('Error validating auth:', err);
          res.writeHead(500);
          res.end();
        });
    }).listen(AUTH_PORT, '127.0.0.1');

  try {
    while (true) {
      const config = loadConfig();

      let members: GuildMember[] | undefined;
      try {
        members = await fetchGuildMembers(token, config.guild);
        memberIds = new Set(members.map(m => m.user.id));
      } catch (err) {
        console.error('Error fetching guild members:', err);
      }

      try {
        await syncRoles(token, vgcToken, config, state, members);
      } catch (err) {
        console.error('Error syncing roles:', err);
      }

      if (config.channel) {
        let channels: GuildChannel[] | undefined;
        let roles: GuildRole[] | undefined;
        try {
          [channels, roles] = await Promise.all([
            fetchGuildChannels(token, config.guild),
            fetchGuildRoles(token, config.guild),
          ]);
        } catch (err) {
          console.error('Error fetching guild channels/roles:', err);
        }

        try {
          await syncMessages(token, config.channel, undefined, members, channels, roles);
        } catch (err) {
          console.error('Error syncing messages:', err);
        }
      }

      if (once) break;
      await new Promise(resolve => setTimeout(resolve, CYCLE_MS));
    }
  } finally {
    server?.close();
  }
}

if (require.main === module) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const vgcToken = process.env.VGC_BOT_TOKEN;
  if (!token || !vgcToken) {
    console.error(`Missing ${token ? 'VGC_BOT_TOKEN' : 'DISCORD_BOT_TOKEN'} environment variable`);
    process.exit(1);
  }
  run(token, vgcToken, process.argv.includes('--once')).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
