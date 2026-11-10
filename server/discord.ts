require('source-map-support').install();

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import type polka from 'polka';
import * as yaml from 'yaml';

import {root, slugify, toID} from '../static/util';

import {ArenaDB} from './db';

const DISCORD_API = 'https://discord.com/api/v10';
const MAX_INTERACTION_BYTES = 64 * 1024;
const SITES = ['vgc.bot', 'pkmn.bot'];
const CYCLE_MS = 60_000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const COMMANDS = [
  {
    type: 1,
    name: 'define',
    description: 'Look up a competitive Pokémon AI glossary term',
    options: [
      {
        type: 3,
        name: 'term',
        description: 'Glossary term to define',
        required: true,
        autocomplete: true,
      },
    ],
  },
];

interface Config {
  guild: string;
  channel?: string;
  pins?: string[];
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
  bot?: boolean;
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
  edited_timestamp?: string | null;
  content: string;
  author: DiscordUser;
  referenced_message?: DiscordMessage | null;
  message_snapshots?: Array<{message: DiscordMessageBody}>;
}

export interface DiscordApplication {
  id: string;
  verify_key: string;
}

export interface DiscordCommandOption {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  autocomplete?: boolean;
}

export interface DiscordCommand {
  id?: string;
  type: number;
  name: string;
  description: string;
  options?: DiscordCommandOption[];
}

export interface DiscordInteraction {
  type: number;
  data?: {
    name?: string;
    options?: Array<{
      name: string;
      type?: number;
      value?: string;
      focused?: boolean;
    }>;
  };
}

function loadConfig(file = root('config', 'discord.yml')): Config {
  return yaml.parse(fs.readFileSync(file, 'utf8')) as Config;
}

export function loadGlossary(
  file = root('static', 'glossary.yml')
): Record<string, string> {
  return yaml.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
}

function botOverride(
  bot: NonNullable<Leader['bot']>,
  bots?: {[bot: string]: string}
): string | undefined {
  if (!bots) return undefined;
  if (bots[bot.id]) return bots[bot.id];
  const id = toID(bot.name);
  for (const [k, v] of Object.entries(bots)) {
    if (id.startsWith(toID(k))) return v;
  }
  return undefined;
}

export function ownerOf(leader: Leader, config: Config): Owner | undefined {
  const override = leader.bot && botOverride(leader.bot, config.bots);
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
  dir = root('chat', 'logs'),
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

export async function syncPins(
  token: string,
  channel: string,
  pins: string[],
  state?: Map<string, string | undefined>
) {
  const key = JSON.stringify(pins);
  if (state?.has(channel) && state.get(channel) === key) return;

  const data = await discordRequest(
    token,
    `/channels/${channel}/messages/pins`
  ) as {items: Array<{message: DiscordMessage}>};
  const current = data.items.map(i => i.message);

  if (
    current.length === pins.length &&
    current.every((m, i) => m.author.bot && !m.edited_timestamp && m.content === pins[i])
  ) {
    state?.set(channel, key);
    return;
  }

  for (const m of current) {
    await discordRequest(
      token,
      `/channels/${channel}/messages/pins/${m.id}`,
      {method: 'DELETE'}
    );
  }

  const used = new Set<string>();
  const toPin: DiscordMessage[] = [];
  for (let i = pins.length - 1; i >= 0; i--) {
    const content = pins[i];
    const existing = current.find(
      m => !used.has(m.id) && m.author.bot && !m.edited_timestamp && m.content === content
    );
    if (existing) {
      used.add(existing.id);
      toPin.push(existing);
    } else {
      const created = await discordRequest(
        token,
        `/channels/${channel}/messages`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({content}),
        }
      ) as DiscordMessage;
      toPin.push(created);
    }
  }

  for (const m of current) {
    if (m.author.bot && !used.has(m.id)) {
      await discordRequest(
        token,
        `/channels/${channel}/messages/${m.id}`,
        {method: 'DELETE'}
      );
    }
  }

  for (const m of toPin) {
    await discordRequest(
      token,
      `/channels/${channel}/messages/pins/${m.id}`,
      {method: 'PUT'}
    );
  }

  if (toPin.length > 0) {
    const recent = await discordRequest(
      token,
      `/channels/${channel}/messages?limit=${Math.min(100, toPin.length * 2 + 10)}`
    ) as DiscordMessage[];
    for (const m of recent) {
      if (m.type === 6 && m.author.bot) {
        await discordRequest(
          token,
          `/channels/${channel}/messages/${m.id}`,
          {method: 'DELETE'}
        );
      }
    }
  }

  state?.set(channel, key);
}

export function formatGlossary(raw: string): string {
  const blocks = raw.trim().split(/\n\s*\n/).map(block => {
    if (/^\s*(?:-\s+|\d+\.\s+)/.test(block)) {
      return block
        .trim()
        .split(/\n(?=\s*(?:-\s+|\d+\.\s+))/)
        .map(item => item.trim().replace(/^(-|\d+\.)\s+/, '$1 ').replace(/\s*\n\s*/g, ' '))
        .join('\n');
    }
    return block.trim().replace(/\s*\n\s*/g, ' ');
  });
  let text = blocks.join('\n\n');
  text = text.replace(/\$`([^`]+)`/g, (_, m: string) => {
    const clean = m
      .replace(/\\widetilde\{([^}]+)\}/g, '~$1')
      .replace(/\\mid\b/g, '|')
      .replace(/\\land\b/g, '∧')
      .replace(/\\alpha\b/g, 'α')
      .replace(/\\beta\b/g, 'β')
      .replace(/\\%/g, '%')
      .replace(/\s+/g, ' ')
      .trim();
    return `\`${clean}\``;
  });
  text = text.replace(/\[([^\][]+)\]\{\.(?:dfn|seed)\}/g, '**$1**');
  text = text.replace(
    /\[([^\][]+)\]\(([^)]+)\)(?:\{\.subtle\})?/g,
    (_, label: string, url: string) => {
      const full = url.startsWith('#')
        ? `https://pkmn.ai/glossary/${url}`
        : url.startsWith('/')
          ? `https://pkmn.ai${url}`
          : url;
      return `[${label}](${full})`;
    }
  );
  text = text.replace(/\[((?:[^\][]|\[[^\][]*\]\([^)]+\))+)\]\{\.(?:dfn|seed)\}/g, '**$1**');
  return text.replace(/---/g, '—').replace(/--/g, '–');
}

export function formatGlossaryReply(term: string, raw: string): string {
  const url = `https://pkmn.ai/glossary/#${slugify(term)}`;
  return `**[${term}](${url})**: ${formatGlossary(raw)}`;
}

function extractGlossaryAliases(
  glossary: Record<string, string>
): Array<{alias: string; term: string}> {
  const terms = Object.keys(glossary);
  const topIds = new Set(terms.map(toID));
  const bySlug = new Map(terms.map(t => [slugify(t).toLowerCase(), t]));
  const aliases: Array<{alias: string; term: string}> = [];

  for (const [term, raw] of Object.entries(glossary)) {
    const flat = raw.replace(/\s+/g, ' ');
    for (const m of flat.matchAll(/\[\[([^\][]+)\]\(#([^)]+)\)\]\{\.dfn\}/g)) {
      const alias = m[1].trim();
      const target = bySlug.get(m[2].toLowerCase()) ?? term;
      if (!topIds.has(toID(alias))) {
        aliases.push({alias, term: target});
      }
    }
    const stripped = flat.replace(/\[([^\][]+)\]\([^)]+\)(?:\{\.subtle\})?/g, '$1');
    for (const m of stripped.matchAll(/\[([^\][]+)\]\{\.dfn\}/g)) {
      const alias = m[1].trim();
      if (!topIds.has(toID(alias)) && !aliases.some(a => toID(a.alias) === toID(alias))) {
        aliases.push({alias, term});
      }
    }
  }
  return aliases;
}

export function lookupGlossary(
  query: string,
  glossary: Record<string, string>
): {term: string; definition: string} | undefined {
  const q = query.trim();
  if (!q) return undefined;
  if (Object.prototype.hasOwnProperty.call(glossary, q)) {
    return {term: q, definition: glossary[q]};
  }
  const terms = Object.keys(glossary);
  const lower = q.toLowerCase();
  const slug = slugify(q).toLowerCase();
  const id = toID(q);

  const match =
    terms.find(t => t.toLowerCase() === lower) ??
    (slug ? terms.find(t => slugify(t).toLowerCase() === slug) : undefined) ??
    (id ? terms.find(t => toID(t) === id) : undefined);
  if (match) return {term: match, definition: glossary[match]};

  const aliases = extractGlossaryAliases(glossary);
  const aliasMatch =
    aliases.find(a => a.alias.toLowerCase() === lower) ??
    (id ? aliases.find(a => toID(a.alias) === id) : undefined);
  if (aliasMatch) {
    return {term: aliasMatch.term, definition: glossary[aliasMatch.term]};
  }

  const prefixTerm = terms.find(
    t => t.toLowerCase().startsWith(lower) || Boolean(id && toID(t).startsWith(id))
  );
  if (prefixTerm) return {term: prefixTerm, definition: glossary[prefixTerm]};

  const prefixAlias = aliases.find(
    a => a.alias.toLowerCase().startsWith(lower) || Boolean(id && toID(a.alias).startsWith(id))
  );
  if (prefixAlias) {
    return {term: prefixAlias.term, definition: glossary[prefixAlias.term]};
  }
  return undefined;
}

export function autocompleteGlossary(
  query: string,
  glossary: Record<string, string>
): Array<{name: string; value: string}> {
  const terms = Object.keys(glossary).sort((a, b) =>
    a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase()));
  const q = query.trim();
  if (!q) {
    return terms.slice(0, 25).map(t => ({name: t, value: t}));
  }

  const lower = q.toLowerCase();
  const id = toID(q);
  const aliases = extractGlossaryAliases(glossary);
  const choices: Array<{name: string; value: string}> = [];
  const seen = new Set<string>();

  const add = (name: string, value: string) => {
    if (seen.has(value) || choices.length >= 25) return;
    seen.add(value);
    choices.push({name: name.slice(0, 100), value});
  };

  for (const t of terms) {
    if (t.toLowerCase().startsWith(lower) || (id && toID(t).startsWith(id))) {
      add(t, t);
    }
  }
  for (const a of aliases) {
    if (a.alias.toLowerCase().startsWith(lower) || (id && toID(a.alias).startsWith(id))) {
      add(`${a.alias} (${a.term})`, a.term);
    }
  }
  for (const t of terms) {
    if (t.toLowerCase().includes(lower) || (id && toID(t).includes(id))) {
      add(t, t);
    }
  }
  for (const a of aliases) {
    if (a.alias.toLowerCase().includes(lower) || (id && toID(a.alias).includes(id))) {
      add(`${a.alias} (${a.term})`, a.term);
    }
  }
  for (const t of terms) {
    if (glossary[t].toLowerCase().includes(lower)) {
      add(t, t);
    }
  }

  return choices;
}

export function verifySignature(
  body: string,
  signature: string | undefined,
  timestamp: string | undefined,
  verifyKey: string
): boolean {
  if (!signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  if (!/^[0-9a-f]{64}$/i.test(verifyKey)) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(verifyKey, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(
      null,
      Buffer.from(`${timestamp}${body}`),
      key,
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false;
  }
}

export function handleInteraction(
  body: string,
  reqHeaders: http.IncomingHttpHeaders,
  verifyKey: string | undefined,
  glossary: Record<string, string>
): {status: number; headers: Record<string, string>; body?: string} {
  const sig = reqHeaders['x-signature-ed25519'];
  const ts = reqHeaders['x-signature-timestamp'];
  if (
    !verifyKey ||
    typeof sig !== 'string' ||
    typeof ts !== 'string' ||
    !verifySignature(body, sig, ts, verifyKey)
  ) {
    return {status: 401, headers: {}};
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(body) as DiscordInteraction;
  } catch {
    return {status: 400, headers: {}};
  }

  const jsonHeaders = {'content-type': 'application/json; charset=utf-8'};
  if (interaction.type === 1) {
    return {status: 200, headers: jsonHeaders, body: JSON.stringify({type: 1})};
  }

  const cmd = interaction.data?.name;
  const termOpt = interaction.data?.options?.find(o => o.name === 'term')?.value ?? '';

  if (interaction.type === 4 && cmd === 'define') {
    const choices = autocompleteGlossary(termOpt, glossary);
    return {
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify({type: 8, data: {choices}}),
    };
  }

  if (interaction.type === 2 && cmd === 'define') {
    const found = lookupGlossary(termOpt, glossary);
    if (found) {
      return {
        status: 200,
        headers: jsonHeaders,
        body: JSON.stringify({
          type: 4,
          data: {
            content: formatGlossaryReply(found.term, found.definition),
            flags: 4,
          },
        }),
      };
    }
    return {
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        type: 4,
        data: {
          content: `Unknown glossary term: \`${termOpt}\`. See <https://pkmn.ai/glossary/>.`,
          flags: 68,
        },
      }),
    };
  }

  return {status: 400, headers: {}};
}

export async function syncCommands(
  token: string,
  guild: string,
  state?: Map<string, string | undefined>,
  commands: DiscordCommand[] = COMMANDS
): Promise<DiscordApplication> {
  const key = JSON.stringify(commands);
  const cachedApp = state?.get('app');
  const app = cachedApp
    ? JSON.parse(cachedApp) as DiscordApplication
    : await discordRequest(token, '/oauth2/applications/@me') as DiscordApplication;
  state?.set('app', JSON.stringify({id: app.id, verify_key: app.verify_key}));

  if (state?.get('commands') === key) return app;

  const current = await discordRequest(
    token,
    `/applications/${app.id}/guilds/${guild}/commands`
  ) as DiscordCommand[];

  const normalize = (cmds: DiscordCommand[]) =>
    cmds
      .map(c => ({
        type: c.type ?? 1,
        name: c.name,
        description: c.description,
        options: (c.options ?? []).map(o => ({
          type: o.type,
          name: o.name,
          description: o.description,
          required: Boolean(o.required),
          autocomplete: Boolean(o.autocomplete),
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

  if (JSON.stringify(normalize(current)) !== JSON.stringify(normalize(commands))) {
    await discordRequest(
      token,
      `/applications/${app.id}/guilds/${guild}/commands`,
      {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(commands),
      }
    );
  }

  state?.set('commands', key);
  return app;
}

export function syncGuildMembers(
  db: ArenaDB,
  members: GuildMember[],
  now = Math.floor(Date.now() / 1000)
) {
  db.syncDiscordMembers(
    members.map(m => ({id: m.user.id, username: m.user.username})),
    now
  );
}

export interface Options {
  db: ArenaDB;
  token?: string;
  vgcToken?: string;
  verifyKey?: string;
  cycleMs?: number;
}

export async function syncOnce(
  db: ArenaDB,
  token: string,
  vgcToken: string,
  state = new Map<string, string | undefined>(),
  onVerifyKey?: (key: string) => void
) {
  const config = loadConfig();

  try {
    const app = await syncCommands(token, config.guild, state);
    onVerifyKey?.(app.verify_key);
  } catch (err) {
    console.error('Error syncing commands:', err);
  }

  let members: GuildMember[] | undefined;
  try {
    members = await fetchGuildMembers(token, config.guild);
    syncGuildMembers(db, members);
  } catch (err) {
    console.error('Error fetching guild members:', err);
  }

  try {
    await syncRoles(token, vgcToken, config, state, members);
  } catch (err) {
    console.error('Error syncing roles:', err);
  }

  if (config.channel) {
    if (config.pins) {
      try {
        await syncPins(token, config.channel, config.pins, state);
      } catch (err) {
        console.error('Error syncing pins:', err);
      }
    }

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
}

export function register(app: polka.Polka, options: Options): {stop: () => void} {
  const token = options.token ?? process.env.DISCORD_BOT_TOKEN;
  const vgcToken = options.vgcToken ?? process.env.VGC_BOT_TOKEN;
  const cycleMs = options.cycleMs ?? CYCLE_MS;
  const state = new Map<string, string | undefined>();
  let verifyKey = options.verifyKey;
  let glossary = loadGlossary();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let ready = Promise.resolve();

  const scheduleNext = () => {
    if (stopped || !token || !vgcToken) return;
    timer = setTimeout(() => {
      if (stopped) return;
      glossary = loadGlossary();
      ready = syncOnce(options.db, token, vgcToken, state, k => {
        verifyKey = k;
      }).finally(scheduleNext);
    }, cycleMs);
    timer.unref();
  };

  if (token && vgcToken) {
    ready = syncOnce(options.db, token, vgcToken, state, k => {
      verifyKey = k;
    }).finally(scheduleNext);
  }

  app.post('/discord/interactions', (req, res) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_INTERACTION_BYTES) {
        req.destroy();
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      ready
        .then(() => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          const result = handleInteraction(rawBody, req.headers, verifyKey, glossary);
          res.writeHead(result.status, result.headers);
          res.end(result.body);
        })
        .catch(err => {
          console.error('Error handling interaction:', err);
          res.writeHead(500);
          res.end();
        });
    });
    req.on('error', err => {
      console.error('Error reading interaction request:', err);
      res.writeHead(500);
      res.end();
    });
  });

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

if (require.main === module) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const vgcToken = process.env.VGC_BOT_TOKEN;
  if (!token || !vgcToken) {
    console.error(`Missing ${token ? 'VGC_BOT_TOKEN' : 'DISCORD_BOT_TOKEN'} environment variable`);
    process.exit(1);
  }
  const db = new ArenaDB();
  syncOnce(db, token, vgcToken)
    .catch(err => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => {
      db.close();
    });
}
