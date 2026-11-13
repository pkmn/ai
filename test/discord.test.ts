import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import polka from 'polka';

import {Database} from '../db';
import * as discord from '../server/discord';

const CONFIG: discord.Config = {
  guild: 'guild',
  ladders: {a: 'role-a', b: 'role-b'},
  agents: {AgentX: 'sauce'},
  authors: {pelle: 'pll'},
};

function leader(
  ladder: string,
  agent?: discord.Leader['agent'],
  owner?: discord.Leader['owner']
): discord.Leader {
  return {ladder, agent, owner};
}

describe('ownerOf', () => {
  const other = {id: 'a1', name: 'Other'};
  test.each<[string, discord.Leader, ReturnType<typeof discord.ownerOf>]>([
    ['the config override by agent name',
      leader('a', {id: 'a2', name: 'AgentX'}, {name: 'x', discordId: '1'}), {name: 'sauce'}],
    ['the config override by agent family name for a version',
      leader('a', {id: 'a2', name: 'AgentX v2'}, undefined), {name: 'sauce'}],
    ['the shared Discord account', leader('a', other, {name: 'x', discordId: '1'}), {id: '1'}],
    ['the mapped author name', leader('a', other, {name: 'pelle'}), {name: 'pll'}],
    ['the author name', leader('a', other, {name: 'x'}), {name: 'x'}],
    ['nobody while the owner is private', leader('a', other, undefined), undefined],
  ])('is %s', (_, l, expected) => {
    expect(discord.ownerOf(l, CONFIG)).toEqual(expected);
  });
});

describe('findMember', () => {
  const members: discord.GuildMember[] = [
    {user: {id: '1', username: 'nessiedev'}, roles: []},
    {user: {id: '2', username: 'other', global_name: '9'}, nick: '9', roles: []},
  ];

  test('an id matches the member id and nothing else', () => {
    expect(discord.findMember(members, {id: '1'})?.user.username).toBe('nessiedev');
    expect(discord.findMember(members, {id: '9'})).toBeUndefined();
  });

  test('a name matches the id, username, global name or nickname', () => {
    expect(discord.findMember(members, {name: 'NESSIEDEV'})?.user.id).toBe('1');
    expect(discord.findMember(members, {name: '9'})?.user.id).toBe('2');
  });
});

interface Call {
  method: string;
  url: string;
  authorization?: string;
}

const realFetch = globalThis.fetch;

function stubFetch(
  leaders: discord.Leader[], members: object[], fail: (call: Call) => boolean = () => false
) {
  const calls: Call[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const call = {method: init?.method ?? 'GET', url: String(url),
      authorization: headers?.Authorization};
    calls.push(call);
    const status = fail(call) ? 500 : call.method === 'GET' ? 200 : 204;
    const body = call.url.includes('vgc.bot')
      ? {leaders: leaders.filter(l => l.ladder === 'a')}
      : call.url.includes('pkmn.bot')
        ? {leaders: leaders.filter(l => l.ladder !== 'a')}
        : members;
    return Promise.resolve({status, ok: status < 300, text: () => Promise.resolve(''),
      json: () => Promise.resolve(status === 200 ? body : 'boom')});
  }) as unknown as typeof fetch;
  return calls;
}

const MEMBERS: discord.GuildMember[] = [
  {user: {id: 'old', username: 'old'}, roles: ['role-a', 'role-b']},
  {user: {id: 'new', username: 'new'}, roles: []},
];
const LEADERS = [
  leader('a', {id: 'a1', name: 'Leader'}, {name: 'x', discordId: 'new'}),
  leader('b'),
];
const memberFetches = (calls: Call[]) => calls.filter(c => c.url.includes('/members?')).length;

describe('syncRoles', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('asks both sites with the token, then moves each role, fetching the members once',
    async () => {
      const calls = stubFetch(LEADERS, MEMBERS);
      await discord.syncRoles('token', 'vgc', CONFIG, new Map());
      expect(calls.slice(0, 2)).toEqual([
        {method: 'GET', url: expect.stringContaining('vgc.bot'), authorization: 'Bearer vgc'},
        {method: 'GET', url: expect.stringContaining('pkmn.bot'), authorization: 'Bearer vgc'},
      ]);
      expect(memberFetches(calls)).toBe(1);
      expect(
        calls.filter(c => c.method !== 'GET').map(({method, url}) => ({method, url}))
      ).toEqual([
        {method: 'DELETE', url: expect.stringContaining('/members/old/roles/role-a')},
        {method: 'PUT', url: expect.stringContaining('/members/new/roles/role-a')},
        {method: 'DELETE', url: expect.stringContaining('/members/old/roles/role-b')},
      ]);
    });

  test('leaves ladders alone whose owner did not change', async () => {
    const calls = stubFetch(LEADERS, MEMBERS);
    const state = new Map<string, string | undefined>();
    await discord.syncRoles('token', 'vgc', CONFIG, state);
    const before = calls.length;
    await discord.syncRoles('token', 'vgc', CONFIG, state);
    expect(calls.slice(before).map(c => c.url)).toEqual([
      expect.stringContaining('vgc.bot'),
      expect.stringContaining('pkmn.bot'),
    ]);
  });

  test('tries again next cycle while the owner is not in the server', async () => {
    const gone = leader('a', {id: 'a1', name: 'Leader'}, {name: 'x', discordId: 'gone'});
    const calls = stubFetch([gone], MEMBERS);
    const state = new Map<string, string | undefined>();
    await discord.syncRoles('token', 'vgc', CONFIG, state);
    await discord.syncRoles('token', 'vgc', CONFIG, state);
    expect(memberFetches(calls)).toBe(2);
    expect(calls.filter(c => c.method === 'PUT')).toEqual([]);
  });

  test('a failing site does not stop the next one', async () => {
    const calls = stubFetch([
      leader('a', undefined, {name: 'x', discordId: 'new'}),
      leader('b', undefined, {name: 'x', discordId: 'new'}),
    ], MEMBERS, call => call.url.includes('vgc.bot'));
    const error = console.error;
    console.error = () => undefined;
    await discord.syncRoles('token', 'vgc', CONFIG, new Map());
    console.error = error;
    expect(calls).toContainEqual(expect.objectContaining({method: 'PUT',
      url: expect.stringContaining('/members/new/roles/role-b')}));
  });

  test('a failing ladder does not stop the next one', async () => {
    const calls = stubFetch([
      leader('a', undefined, {name: 'x', discordId: 'new'}),
      leader('b', undefined, {name: 'x', discordId: 'new'}),
    ], MEMBERS, call => call.method === 'DELETE' && call.url.includes('role-a'));
    const error = console.error;
    console.error = () => undefined;
    await discord.syncRoles('token', 'vgc', CONFIG, new Map());
    console.error = error;
    expect(calls).toContainEqual(expect.objectContaining({method: 'PUT',
      url: expect.stringContaining('/members/new/roles/role-b')}));
  });
});

describe('formatMessage', () => {
  const base: discord.Message = {
    id: '10',
    type: 0,
    timestamp: '2026-11-02T14:18:30.000Z',
    content: 'should we use PUCT or plain UCB?',
    author: {id: 'u1', username: 'bob'},
  };

  test('formats a standard message in IRC style', () => {
    expect(discord.formatMessage(base)).toEqual({
      date: '2026-11-02',
      line: '[14:18:30] bob: should we use PUCT or plain UCB?',
    });
  });

  test('formats a same-day reply with @author[HH:MM:SS]', () => {
    const reply: discord.Message = {
      id: '11',
      type: 19,
      timestamp: '2026-11-02T14:22:05.000Z',
      content: 'PUCT works much better once you have a policy net',
      author: {id: 'u2', username: 'alice'},
      referenced_message: base,
    };
    expect(discord.formatMessage(reply)).toEqual({
      date: '2026-11-02',
      line: '[14:22:05] alice: @bob[14:18:30] PUCT works much better once you have a policy net',
    });
  });

  test('formats a cross-day reply with @author[YYYY-MM-DD HH:MM:SS]', () => {
    const reply: discord.Message = {
      id: '12',
      type: 19,
      timestamp: '2026-11-03T00:05:10.000Z',
      content: 'agreed with alice',
      author: {id: 'u3', username: 'charlie'},
      referenced_message: base,
    };
    expect(discord.formatMessage(reply)).toEqual({
      date: '2026-11-03',
      line: '[00:05:10] charlie: @bob[2026-11-02 14:18:30] agreed with alice',
    });
  });

  test('resolves user mentions and display names (nick > global_name > username)', () => {
    const msg: discord.Message = {
      ...base,
      author: {id: 'u1', username: 'scheibo', global_name: 'pre'},
      content: 'hey <@1> and <@!2> and <@3> and <@999>',
      mentions: [
        {id: '1', username: 'nessiedev', global_name: 'nessie'},
        {id: '3', username: 'bob_user', global_name: 'Bob Global'},
      ],
      referenced_message: {
        ...base,
        author: {id: '3', username: 'bob_user', global_name: 'Bob Global'},
      },
    };
    const members: discord.GuildMember[] = [
      {user: {id: '2', username: 'sauce_user', global_name: 'sauce'}, roles: []},
      {user: {id: '3', username: 'bob_user', global_name: 'Bob Global'}, nick: 'bobby', roles: []},
    ];
    expect(discord.formatMessage(msg, members)?.line).toBe(
      '[14:18:30] pre: @bobby[14:18:30] hey @nessie and @sauce and @bobby and <@999>'
    );
  });

  test('includes clean attachment URLs for messages with or without text', () => {
    const url =
      'https://cdn.discordapp.com/attachments/689316506265321535/775113930074882068/img.jpg' +
      '?ex=6aea5619&is=6ae90499&hm=0563e093';
    expect(discord.formatMessage({...base, content: 'look:', attachments: [{url}]})?.line).toBe(
      '[14:18:30] bob: look: https://cdn.discordapp.com/attachments/689316506265321535/775113930074882068/img.jpg'
    );
    expect(discord.formatMessage({...base, content: '', attachments: [{url}]})?.line).toBe(
      '[14:18:30] bob: https://cdn.discordapp.com/attachments/689316506265321535/775113930074882068/img.jpg'
    );
  });

  test('resolves channels, roles, custom emojis, and timestamps', () => {
    const msg: discord.Message = {
      ...base,
      content: 'in <#10> ping <@&20> <:pokeball:99> at <t:1762093110:F>',
    };
    const channels = [{id: '10', name: 'general'}];
    const roles = [{id: '20', name: 'Gen 9 OU'}];
    expect(discord.formatMessage(msg, undefined, channels, roles)?.line).toBe(
      '[14:18:30] bob: in #general ping @Gen 9 OU :pokeball: at 2025-11-02 14:18:30 UTC'
    );
  });

  test('formats polls, forwarded messages, embeds, stickers, and deleted replies', () => {
    const pollMsg: discord.Message = {
      ...base,
      content: '',
      poll: {
        question: {text: 'Best search?'},
        answers: [
          {answer_id: 1, poll_media: {text: 'PUCT', emoji: {name: '🌲'}}},
          {answer_id: 2, poll_media: {text: 'CFR'}},
        ],
        results: {answer_counts: [{id: 1, count: 5}, {id: 2, count: 3}]},
      },
    };
    expect(discord.formatMessage(pollMsg)?.line).toBe(
      '[14:18:30] bob: [Poll: Best search?] 1. 🌲 PUCT (5) | 2. CFR (3)'
    );

    const forwarded: discord.Message = {
      ...base,
      content: 'thoughts?',
      message_snapshots: [{
        message: {
          content: 'new result in <#10>',
          attachments: [{url: 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=1'}],
        },
      }],
    };
    expect(discord.formatMessage(forwarded, undefined, [{id: '10', name: 'papers'}])?.line).toBe(
      '[14:18:30] bob: thoughts? [Forwarded] new result in #papers https://cdn.discordapp.com/attachments/1/2/a.png'
    );

    const richEmbed: discord.Message = {
      ...base,
      content: '',
      embeds: [{
        type: 'rich',
        title: 'Tournament Result',
        description: '0-ERROR won',
        fields: [{name: 'Score', value: '3-1'}],
        url: 'https://pkmn.ai/leaderboard',
      }],
      sticker_items: [{name: 'pikachu'}],
    };
    expect(discord.formatMessage(richEmbed)?.line).toBe(
      '[14:18:30] bob: [Embed: Tournament Result — 0-ERROR won — Score: 3-1 — https://pkmn.ai/leaderboard] [Sticker: pikachu]'
    );

    // Link preview embeds on normal text messages should not be duplicated
    const linkPreview: discord.Message = {
      ...base,
      content: 'see https://pkmn.ai',
      embeds: [{type: 'link', title: 'pkmn.ai', url: 'https://pkmn.ai'}],
    };
    expect(discord.formatMessage(linkPreview)?.line).toBe('[14:18:30] bob: see https://pkmn.ai');

    const deletedReply: discord.Message = {
      ...base,
      type: 19,
      referenced_message: undefined,
      content: 'agree with that',
    };
    expect(discord.formatMessage(deletedReply)?.line).toBe(
      '[14:18:30] bob: @[deleted] agree with that'
    );
  });

  test('skips empty messages and system message types', () => {
    expect(discord.formatMessage({...base, content: '   '})).toBeUndefined();
    expect(discord.formatMessage({...base, type: 7, content: 'joined'})).toBeUndefined();
  });
});

describe('syncMessages', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-test-'));
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('writes daily logs, rewrites rolling tail on edits, and graduates at 100', async () => {
    const urls: string[] = [];
    const batch1: discord.Message[] = [
      {
        id: '102',
        timestamp: '2026-11-02T14:22:05.000Z',
        content: 'second message (typo)',
        author: {id: 'u2', username: 'alice'},
        referenced_message: {
          id: '101',
          timestamp: '2026-11-02T14:18:30.000Z',
          content: 'first message',
          author: {id: 'u1', username: 'bob'},
        },
      },
      {
        id: '101',
        timestamp: '2026-11-02T14:18:30.000Z',
        content: 'first message',
        author: {id: 'u1', username: 'bob'},
      },
    ];
    const batch2: discord.Message[] = [
      {
        id: '103',
        timestamp: '2026-11-03T01:02:03.000Z',
        content: 'next day message',
        author: {id: 'u1', username: 'bob'},
      },
      {
        ...batch1[0],
        content: 'second message (fixed)',
      },
      batch1[1],
    ];

    let call = 0;
    globalThis.fetch = ((url: string) => {
      urls.push(String(url));
      const body = call++ === 0 ? batch1 : batch2;
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve(body),
      });
    }) as unknown as typeof fetch;

    await discord.syncMessages('token', 'chan', tmpDir);
    expect(urls).toEqual([expect.stringContaining('/channels/chan/messages?limit=100&after=0')]);
    expect(fs.readFileSync(path.join(tmpDir, '2026-11-02.txt'), 'utf8')).toBe(
      '[14:18:30] bob: first message\n' +
      '[14:22:05] alice: @bob[14:18:30] second message (typo)\n'
    );
    expect(fs.readFileSync(path.join(tmpDir, '.cursor'), 'utf8')).toBe('0\n2026-11-02.txt 0\n');

    await discord.syncMessages('token', 'chan', tmpDir);
    expect(urls[1]).toContain('/channels/chan/messages?limit=100&after=0');
    expect(fs.readFileSync(path.join(tmpDir, '2026-11-02.txt'), 'utf8')).toBe(
      '[14:18:30] bob: first message\n' +
      '[14:22:05] alice: @bob[14:18:30] second message (fixed)\n'
    );
    expect(fs.readFileSync(path.join(tmpDir, '2026-11-03.txt'), 'utf8')).toBe(
      '[01:02:03] bob: next day message\n'
    );
    expect(fs.readFileSync(path.join(tmpDir, '.cursor'), 'utf8')).toBe(
      '0\n2026-11-02.txt 0\n2026-11-03.txt 0\n'
    );

    // When a page hits 100 messages at the head, the older 50 graduate and `after` advances
    const fullPage: discord.Message[] = Array.from({length: 100}, (_, i) => ({
      id: String(200 - i),
      timestamp: '2026-11-03T02:00:00.000Z',
      content: `msg ${200 - i}`,
      author: {id: 'u1', username: 'bob'},
    }));
    globalThis.fetch = ((url: string) => {
      urls.push(String(url));
      const body = String(url).endsWith('after=0') ? fullPage : [];
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve(body),
      });
    }) as unknown as typeof fetch;

    await discord.syncMessages('token', 'chan', tmpDir);
    // Older 50 are ids 101..150, so after advances to page[50].id === '150'
    const cursor = fs.readFileSync(path.join(tmpDir, '.cursor'), 'utf8');
    expect(cursor).toMatch(/^150\n2026-11-03\.txt \d+\n$/);
  });
});

describe('syncPins', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('replaces user pins with app pins in reverse order and deletes system messages',
    async () => {
      const actions: Array<{method: string; url: string; body?: string}> = [];
      let nextId = 100;
      const userPins: discord.Message[] = [
        {id: '1', timestamp: '2026-11-02T00:00:00Z', content: 'first',
          author: {id: 'u1', username: 'pre'}},
        {id: '2', timestamp: '2026-11-02T00:00:00Z', content: 'second',
          author: {id: 'u1', username: 'pre'}},
        {id: '3', timestamp: '2026-11-02T00:00:00Z', content: 'third',
          author: {id: 'u1', username: 'pre'}},
      ];

      globalThis.fetch = ((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const u = String(url);
        const body = typeof init?.body === 'string' ? init.body : undefined;
        actions.push({method, url: u, ...(body ? {body} : {})});

        if (method === 'GET' && u.endsWith('/messages/pins')) {
          return Promise.resolve({
            status: 200,
            ok: true,
            json: () => Promise.resolve({items: userPins.map(message => ({message}))}),
          });
        }
        if (method === 'POST' && u.endsWith('/messages')) {
          const {content} = JSON.parse(body!) as {content: string};
          const created: discord.Message = {
            id: String(++nextId),
            timestamp: '2026-11-07T00:00:00Z',
            content,
            author: {id: 'app', username: 'pkmn', bot: true},
          };
          return Promise.resolve({status: 200, ok: true, json: () => Promise.resolve(created)});
        }
        if (method === 'GET' && u.includes('/messages?limit=')) {
          const recent: discord.Message[] = [
            {id: '201', type: 6, timestamp: '2026-11-07T00:00:00Z', content: '',
              author: {id: 'app', username: 'pkmn', bot: true}},
            {id: '202', type: 6, timestamp: '2026-11-07T00:00:00Z', content: '',
              author: {id: 'u1', username: 'pre'}},
            {id: '103', type: 0, timestamp: '2026-11-07T00:00:00Z', content: 'first',
              author: {id: 'app', username: 'pkmn', bot: true}},
          ];
          return Promise.resolve({status: 200, ok: true, json: () => Promise.resolve(recent)});
        }
        return Promise.resolve({status: 204, ok: true});
      }) as unknown as typeof fetch;

      const state = new Map<string, string | undefined>();
      await discord.syncPins('token', 'chan', ['first', 'second', 'third'], state);

      expect(actions).toEqual([
        {method: 'GET', url: expect.stringContaining('/channels/chan/messages/pins')},
        {method: 'DELETE', url: expect.stringContaining('/channels/chan/messages/pins/1')},
        {method: 'DELETE', url: expect.stringContaining('/channels/chan/messages/pins/2')},
        {method: 'DELETE', url: expect.stringContaining('/channels/chan/messages/pins/3')},
        {method: 'POST', url: expect.stringContaining('/channels/chan/messages'),
          body: JSON.stringify({content: 'third'})},
        {method: 'POST', url: expect.stringContaining('/channels/chan/messages'),
          body: JSON.stringify({content: 'second'})},
        {method: 'POST', url: expect.stringContaining('/channels/chan/messages'),
          body: JSON.stringify({content: 'first'})},
        {method: 'PUT', url: expect.stringContaining('/channels/chan/messages/pins/101')},
        {method: 'PUT', url: expect.stringContaining('/channels/chan/messages/pins/102')},
        {method: 'PUT', url: expect.stringContaining('/channels/chan/messages/pins/103')},
        {method: 'GET', url: expect.stringContaining('/channels/chan/messages?limit=16')},
        {method: 'DELETE', url: expect.stringContaining('/channels/chan/messages/201')},
      ]);

      // Cached state skips subsequent cycles when config is unchanged
      actions.length = 0;
      await discord.syncPins('token', 'chan', ['first', 'second', 'third'], state);
      expect(actions).toEqual([]);
    });

  test('reuses unchanged app pins, replaces changed ones, and deletes stale app pins', async () => {
    const actions: Array<{method: string; url: string; body?: string}> = [];
    const existingPins: discord.Message[] = [
      {id: '103', timestamp: '2026-11-07T00:00:00Z', content: 'first',
        author: {id: 'app', username: 'pkmn', bot: true}},
      {id: '102', timestamp: '2026-11-07T00:00:00Z', content: 'second',
        author: {id: 'app', username: 'pkmn', bot: true}},
      {id: '101', timestamp: '2026-11-07T00:00:00Z', content: 'third',
        author: {id: 'app', username: 'pkmn', bot: true}},
    ];

    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const u = String(url);
      const body = typeof init?.body === 'string' ? init.body : undefined;
      actions.push({method, url: u, ...(body ? {body} : {})});

      if (method === 'GET' && u.endsWith('/messages/pins')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve({items: existingPins.map(message => ({message}))}),
        });
      }
      if (method === 'POST' && u.endsWith('/messages')) {
        const {content} = JSON.parse(body!) as {content: string};
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve({
            id: '104',
            timestamp: '2026-11-07T00:01:00Z',
            content,
            author: {id: 'app', username: 'pkmn', bot: true},
          }),
        });
      }
      if (method === 'GET' && u.includes('/messages?limit=')) {
        return Promise.resolve({status: 200, ok: true, json: () => Promise.resolve([])});
      }
      return Promise.resolve({status: 204, ok: true});
    }) as unknown as typeof fetch;

    // Already in sync -> no mutations
    await discord.syncPins('token', 'chan', ['first', 'second', 'third']);
    expect(actions).toEqual([
      {method: 'GET', url: expect.stringContaining('/channels/chan/messages/pins')},
    ]);

    // Update the 3rd pin -> unpins all, posts only 'third v2', deletes old msg 101, repins
    actions.length = 0;
    await discord.syncPins('token', 'chan', ['first', 'second', 'third v2']);
    expect(actions).toEqual([
      {method: 'GET', url: expect.stringContaining('/channels/chan/messages/pins')},
      {method: 'DELETE', url: expect.stringContaining('/channels/chan/messages/pins/103')},
      {method: 'DELETE', url: expect.stringContaining('/channels/chan/messages/pins/102')},
      {method: 'DELETE', url: expect.stringContaining('/channels/chan/messages/pins/101')},
      {method: 'POST', url: expect.stringContaining('/channels/chan/messages'),
        body: JSON.stringify({content: 'third v2'})},
      {method: 'DELETE', url: expect.stringContaining('/channels/chan/messages/101')},
      {method: 'PUT', url: expect.stringContaining('/channels/chan/messages/pins/104')},
      {method: 'PUT', url: expect.stringContaining('/channels/chan/messages/pins/102')},
      {method: 'PUT', url: expect.stringContaining('/channels/chan/messages/pins/103')},
      {method: 'GET', url: expect.stringContaining('/channels/chan/messages?limit=16')},
    ]);
  });
});

describe('syncGuildMembers', () => {
  test('syncs current Discord guild member IDs and usernames into Database', () => {
    const db = new Database(':memory:');
    try {
      discord.syncGuildMembers(db, [
        {user: {id: '513513270670262284', username: 'scheibo'}, roles: []},
        {user: {id: '283674461268344832', username: 'pmariglia'}, roles: []},
      ], 1_760_000_000);
      expect(db.isDiscordMember('513513270670262284')).toBe(true);
      expect(db.isDiscordMember('283674461268344832')).toBe(true);
      expect(db.isDiscordMember('999999999999999999')).toBe(false);

      // Re-sync after a member leaves removes stale membership
      discord.syncGuildMembers(db, [
        {user: {id: '513513270670262284', username: 'scheibo'}, roles: []},
      ], 1_760_000_060);
      expect(db.isDiscordMember('513513270670262284')).toBe(true);
      expect(db.isDiscordMember('283674461268344832')).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('glossary slash commands', () => {
  const glossary = discord.loadGlossary();
  const {publicKey, privateKey} = crypto.generateKeyPairSync('ed25519');
  const verifyKey = publicKey.export({type: 'spki', format: 'der'}).subarray(12).toString('hex');

  function signedInteraction(payload: object, timestamp = '1700000000') {
    const body = JSON.stringify(payload);
    const sig = crypto
      .sign(undefined, Buffer.from(`${timestamp}${body}`), privateKey)
      .toString('hex');
    return {
      body,
      headers: {
        'x-signature-ed25519': sig,
        'x-signature-timestamp': timestamp,
      },
    };
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('formats all static/glossary.yml entries cleanly within Discord limits', () => {
    for (const [term, raw] of Object.entries(glossary)) {
      const reply = discord.formatGlossaryReply(term, raw);
      expect(reply.startsWith(`**[${term}](https://pkmn.ai/glossary/#`)).toBe(true);
      expect(reply.length).toBeLessThanOrEqual(2000);
      expect(reply).not.toMatch(/\{[^}]+\}/);
      expect(reply).not.toMatch(/\$`/);
    }
  });

  test('looks up exact keys, slugs/IDs, and {.dfn} aliases', () => {
    expect(discord.lookupGlossary('NE', glossary)?.term).toBe('NE');
    expect(discord.lookupGlossary('ne', glossary)?.term).toBe('NE');
    expect(discord.lookupGlossary('nash', glossary)?.term).toBe('NE');
    expect(discord.lookupGlossary('Nash', glossary)?.term).toBe('NE');
    expect(discord.lookupGlossary('Nash equilibrium', glossary)?.term).toBe('NE');
    expect(discord.lookupGlossary('MNE', glossary)?.term).toBe('NE');
    expect(discord.lookupGlossary('alpha-beta', glossary)?.term).toBe('alpha-beta');
    expect(discord.lookupGlossary('alphabeta', glossary)?.term).toBe('alpha-beta');
    expect(discord.lookupGlossary('reinforcement learning', glossary)?.term).toBe('RL');
    expect(discord.lookupGlossary('nonexistentterm123', glossary)).toBeUndefined();
  });

  test('autocompletes matching terms and aliases up to 25 choices', () => {
    const empty = discord.autocompleteGlossary('', glossary);
    expect(empty).toHaveLength(25);

    const ne = discord.autocompleteGlossary('Nash', glossary);
    expect(ne[0]).toEqual({name: 'Nash equilibrium (NE)', value: 'NE'});

    const cfr = discord.autocompleteGlossary('CFR', glossary);
    expect(cfr[0]).toEqual({name: 'CFR', value: 'CFR'});
  });

  test('verifies Ed25519 signatures and handles PING, /define, and autocomplete', () => {
    const bad = discord.handleInteraction('{"type":1}', {}, verifyKey, glossary);
    expect(bad.status).toBe(401);

    const ping = signedInteraction({type: 1});
    const pingRes = discord.handleInteraction(ping.body, ping.headers, verifyKey, glossary);
    expect(pingRes.status).toBe(200);
    expect(JSON.parse(pingRes.body!)).toEqual({type: 1});

    const cmd = signedInteraction({
      type: 2,
      data: {name: 'define', options: [{name: 'term', value: 'NE'}]},
    });
    const res = discord.handleInteraction(cmd.body, cmd.headers, verifyKey, glossary);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body!) as {
      type: number;
      data: {content: string; flags: number};
    };
    expect(parsed.type).toBe(4);
    expect(parsed.data.flags).toBe(4);
    expect(parsed.data.content).toContain('**[NE](https://pkmn.ai/glossary/#NE)**:');
    expect(parsed.data.content).toContain('The **Nash equilibrium**');
    expect(parsed.data.content).toContain('[strategy](https://pkmn.ai/glossary/#strategy)');

    const unknown = signedInteraction({
      type: 2,
      data: {name: 'define', options: [{name: 'term', value: 'not-a-term'}]},
    });
    const unknownRes = discord.handleInteraction(
      unknown.body,
      unknown.headers,
      verifyKey,
      glossary
    );
    expect(unknownRes.status).toBe(200);
    expect(JSON.parse(unknownRes.body!)).toEqual({
      type: 4,
      data: {
        content: 'Unknown glossary term: `not-a-term`. See <https://pkmn.ai/glossary/>.',
        flags: 68,
      },
    });

    const auto = signedInteraction({
      type: 4,
      data: {name: 'define', options: [{name: 'term', value: 'NE', focused: true}]},
    });
    const autoRes = discord.handleInteraction(auto.body, auto.headers, verifyKey, glossary);
    expect(autoRes.status).toBe(200);
    const autoData = JSON.parse(autoRes.body!) as {
      type: number;
      data: {choices: Array<{name: string; value: string}>};
    };
    expect(autoData.type).toBe(8);
    expect(autoData.data.choices[0]).toEqual({name: 'NE', value: 'NE'});
  });

  test('syncCommands registers /define when missing and skips PUT when in sync', async () => {
    const calls: Array<{method: string; url: string; body?: string}> = [];
    let currentCmds: object[] = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({method, url: String(url), body: init?.body as string | undefined});
      if (String(url).endsWith('/oauth2/applications/@me')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve({id: 'app1', verify_key: verifyKey}),
        });
      }
      if (method === 'PUT') {
        currentCmds = JSON.parse(init?.body as string) as object[];
      }
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve(currentCmds),
      });
    }) as unknown as typeof fetch;

    const state = new Map<string, string | undefined>();
    const app = await discord.syncCommands('token', 'guild1', state);
    expect(app).toEqual({id: 'app1', verify_key: verifyKey});
    expect(calls.map(c => c.method)).toEqual(['GET', 'GET', 'PUT']);
    expect(JSON.parse(calls[2].body!)).toEqual(discord.COMMANDS);

    await discord.syncCommands('token', 'guild1', state);
    expect(calls).toHaveLength(3);

    const freshState = new Map<string, string | undefined>();
    await discord.syncCommands('token', 'guild1', freshState);
    expect(calls.map(c => c.method)).toEqual(['GET', 'GET', 'PUT', 'GET', 'GET']);
  });

  test('register mounts POST /discord/interactions on Polka sharing Database', async () => {
    const db = new Database(':memory:');
    const app = polka();
    const handle = discord.register(app, {db, token: '', vgcToken: '', verifyKey});
    const server = http.createServer((req, res) => app.handler(req as polka.Request, res));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as {port: number};
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const ping = signedInteraction({type: 1});
      const res = await realFetch(`${baseUrl}/discord/interactions`, {
        method: 'POST',
        headers: ping.headers,
        body: ping.body,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({type: 1});
    } finally {
      handle.stop();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close();
    }
  });
});

describe('Arena roles & submission/quarantine/watchdog DMs', () => {
  const ARENA_CONFIG: discord.Config = {
    guild: '689316505560809576',
    competitor: '1568629775122309210',
    staff: ['513513270670262284'],
    ladders: {},
  };

  const LADDERS_YAML = `
- name: RBY
  format: gen1ou
  id: gen1ou20261109
  discord: '1563716887131459685'
  team: harvested
  status: active
  min: 2

- name: SV
  format: gen9ou
  id: gen9ou20261109
  discord: '1563717708720377977'
  team: harvested
  status: upcoming
  min: 2
`;

  const PROJECTS_YAML = `
- name: Foul Play
  authors:
    - pmariglia
    - coauthor
  arena:
    qualified: true
    owners:
      pmariglia: pmariglia.10001
      coauthor: coauthor.10002

- name: Metamon
  authors:
    - jakegrigsby
  arena:
    qualified: true
    owners:
      jakegrigsby: jakegrigsby.10003

- name: Pending Project
  authors:
    - newcomer
  arena:
    qualified: false
    owners:
      newcomer: newcomer.10004
`;

  const SHA = 'a'.repeat(64);

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('syncArenaRoles assigns Competitor and multi-owner settled #1 ladder roles', async () => {
    const db = new Database(':memory:');
    try {
      db.syncLaddersFromYaml(LADDERS_YAML, 1_760_000_000);
      db.syncProjectsFromYaml(PROJECTS_YAML, undefined, 1_760_000_000);

      db.linkDeveloperDiscord('pmariglia', '1001', 'pmariglia', 1_760_000_010);
      db.linkDeveloperDiscord('coauthor', '1002', 'coauthor', 1_760_000_010);
      db.linkDeveloperDiscord('jakegrigsby', '1003', 'jake', 1_760_000_010);
      db.linkDeveloperDiscord('newcomer', '1004', 'newcomer', 1_760_000_010);

      const fpAgent = db.getAgentBySlug('foul-play')!;
      const mmAgent = db.getAgentBySlug('metamon')!;

      const v1 = db.createSubmission({
        agentId: fpAgent.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://example.com/fp.tar.zst',
        sha256: SHA,
        ladderIds: ['gen1ou20261109'],
        now: 1_760_000_100,
      });
      db.applySubmissionStatus({versionId: v1.id, smokeStatus: 'passed', now: 1_760_000_110});

      const v2 = db.createSubmission({
        agentId: mmAgent.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://example.com/mm.tar.zst',
        sha256: SHA,
        ladderIds: ['gen1ou20261109'],
        now: 1_760_000_120,
      });
      db.applySubmissionStatus({versionId: v2.id, smokeStatus: 'passed', now: 1_760_000_130});
      db.setLadderAnchor('gen1ou20261109', 'metamon', '1.0.0', 1_760_000_140);

      const playMatch = (idx: number, g1: 'W' | 'L', g2: 'W' | 'L' | 'T') => {
        const cat = `${g1}${g2}` as const;
        db.recordCompletedMatch({
          match: {
            id: `gen1ou-${String(idx).padStart(6, '0')}`,
            ladderId: 'gen1ou20261109',
            p1VersionId: v1.id,
            p2VersionId: v2.id,
            seed: `1,2,3,${idx}`,
            game1Outcome: g1,
            game2Outcome: g2,
            category: cat,
            game1Turns: 30,
            game2Turns: 28,
            game1EndReason: 'win',
            game2EndReason: 'win',
            p1PeakRam: 512,
            p2PeakRam: 512,
            p1Game1BankSeconds: 140,
            p1Game2BankSeconds: 140,
            p2Game1BankSeconds: 120,
            p2Game2BankSeconds: 120,
            p1MeanTurnMillis: 200,
            p2MeanTurnMillis: 200,
            completedAt: 1_760_001_000 + idx * 60,
          },
        });
      };

      // 20 competitive matches -> rank === 1 (provisional), settledAt === undefined (< 25)
      for (let i = 1; i <= 20; i++) {
        const g = i % 3 === 0 ? 'L' : 'W';
        playMatch(i, g, g);
      }
      const provisionalTop = db.getLeaderboardEntries('gen1ou20261109')[0];
      expect(provisionalTop.agentSlug).toBe('foul-play');
      expect(provisionalTop.rankCurrent).toBe(1);
      expect(provisionalTop.settledAt).toBeUndefined();

      const actions: Array<{method: string; url: string}> = [];
      globalThis.fetch = ((url: string, init?: RequestInit) => {
        actions.push({method: init?.method ?? 'GET', url: String(url)});
        return Promise.resolve({status: 204, ok: true, text: () => Promise.resolve('')});
      }) as unknown as typeof fetch;

      // Initially: stale holder 9999 has Competitor + RBY + SV; 1002 is not in the guild yet
      const members: discord.GuildMember[] = [
        {user: {id: '1001', username: 'pmariglia'}, roles: []},
        {user: {id: '1003', username: 'jake'}, roles: []},
        {user: {id: '1004', username: 'newcomer'}, roles: []},
        {
          user: {id: '9999', username: 'stale'},
          roles: ['1568629775122309210', '1563716887131459685', '1563717708720377977'],
        },
      ];
      const state = new Map<string, string | undefined>();

      await discord.syncArenaRoles(db, 'discord-token', ARENA_CONFIG, state, members);
      expect(actions).toEqual([
        // Competitor: remove from stale (9999), assign to 1001 & 1003 (NOT pending 1004!)
        {
          method: 'DELETE',
          url: expect.stringContaining('/members/9999/roles/1568629775122309210'),
        },
        {
          method: 'PUT',
          url: expect.stringContaining('/members/1001/roles/1568629775122309210'),
        },
        {
          method: 'PUT',
          url: expect.stringContaining('/members/1003/roles/1568629775122309210'),
        },
        // RBY (active, provisional #1): remove from stale (9999), assign to nobody yet
        {
          method: 'DELETE',
          url: expect.stringContaining('/members/9999/roles/1563716887131459685'),
        },
        // SV (upcoming): remove from stale (9999)
        {
          method: 'DELETE',
          url: expect.stringContaining('/members/9999/roles/1563717708720377977'),
        },
      ]);

      // Now coauthor '1002' joins the guild, and Foul Play naturally settles at #1
      members.push({user: {id: '1002', username: 'coauthor'}, roles: []});
      for (let i = 21; i <= 50; i++) {
        const g = i % 3 === 0 ? 'L' : 'W';
        playMatch(i, g, g);
      }
      const settledTop = db.getLeaderboardEntries('gen1ou20261109')[0];
      expect(settledTop.agentSlug).toBe('foul-play');
      expect(settledTop.rankCurrent).toBe(1);
      expect(settledTop.settledAt).toBeDefined();

      actions.length = 0;
      await discord.syncArenaRoles(db, 'discord-token', ARENA_CONFIG, state, members);
      expect(actions).toEqual([
        // Missing coauthor 1002 now receives Competitor
        {
          method: 'PUT',
          url: expect.stringContaining('/members/1002/roles/1568629775122309210'),
        },
        // Both Foul Play co-owners (1001 and 1002) receive settled RBY #1 role
        {
          method: 'PUT',
          url: expect.stringContaining('/members/1001/roles/1563716887131459685'),
        },
        {
          method: 'PUT',
          url: expect.stringContaining('/members/1002/roles/1563716887131459685'),
        },
      ]);

      // Steady-state cycle performs zero API mutations
      actions.length = 0;
      await discord.syncArenaRoles(db, 'discord-token', ARENA_CONFIG, state, members);
      expect(actions).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('formats submission, quarantine, and watchdog DMs safely within 2000 chars', () => {
    const hugeStderr = `Traceback:\n\`\`\`\n${'RuntimeError: boom\n'.repeat(300)}`;
    const failDm = discord.formatSubmissionDm({
      agentName: 'Foul Play',
      version: '1.2.0',
      smokeStatus: 'failed',
      ladderLabels: ['RBY', 'SV'],
      smokeError: hugeStderr,
    });
    expect(failDm.length).toBeLessThanOrEqual(2000);
    expect(failDm).toContain('failed its smoke test on `RBY, SV`');
    expect(failDm).toContain('… (truncated)\n```');
    // Inner triple-backticks must be sanitized so code fence never breaks
    expect(failDm.match(/```/g)).toHaveLength(2);

    const staffDm = discord.formatStaffQuarantineDm({
      agentName: 'Foul Play',
      agentSlug: 'foul-play',
      version: '1.2.0',
      ladderLabels: ['RBY'],
      ownersNotified: 2,
      ownersTotal: 2,
      smokeError: hugeStderr,
    });
    expect(staffDm.length).toBeLessThanOrEqual(2000);
    expect(staffDm).toContain("owners DM'd: 2/2");

    const watchdogDm = discord.formatWatchdogDm({
      lastSeenAt: 1_762_807_500,
      lastMatchId: 'gen1ou-0000000972',
    });
    expect(watchdogDm).toContain('gen1ou-0000000972');
    expect(watchdogDm.length).toBeLessThanOrEqual(2000);
  });

  test('delivers smoke & quarantine DMs (including 0-owner staff fallback) and marks notified',
    async () => {
      const db = new Database(':memory:');
      try {
        db.syncLaddersFromYaml(LADDERS_YAML, 1_760_000_000);
        db.syncProjectsFromYaml(PROJECTS_YAML, undefined, 1_760_000_000);
        db.linkDeveloperDiscord('pmariglia', '1001', 'pmariglia', 1_760_000_010);
        db.linkDeveloperDiscord('coauthor', '1002', 'coauthor', 1_760_000_010);

        const fpAgent = db.getAgentBySlug('foul-play')!;
        const coauthorDev = db.getDeveloperByGitHub('coauthor')!;

        const sentMessages: Array<{recipientOrChannel: string; content: string}> = [];
        const blockedUsers = new Set<string>();
        globalThis.fetch = ((url: string, init?: RequestInit) => {
          const u = String(url);
          const rawBody = typeof init?.body === 'string' ? init.body : '{}';
          const body = JSON.parse(rawBody) as {
            recipient_id?: string;
            content?: string;
          };
          if (u.endsWith('/users/@me/channels')) {
            const recipient = body.recipient_id!;
            return Promise.resolve({
              status: 200,
              ok: true,
              json: () => Promise.resolve({id: `dm-${recipient}`}),
            });
          }
          if (u.includes('/channels/dm-') && u.endsWith('/messages')) {
            const channelId = u.split('/channels/')[1].split('/')[0];
            const userId = channelId.slice(3);
            if (blockedUsers.has(userId)) {
              return Promise.resolve({
                status: 403,
                ok: false,
                text: () => Promise.resolve('{"code":50007}'),
              });
            }
            sentMessages.push({recipientOrChannel: channelId, content: body.content!});
            return Promise.resolve({
              status: 200,
              ok: true,
              json: () => Promise.resolve({id: 'msg-1'}),
            });
          }
          return Promise.resolve({status: 204, ok: true, text: () => Promise.resolve('')});
        }) as unknown as typeof fetch;

        const state = new Map<string, string | undefined>();

        // 1. Smoke-test failure: DMs both owners (submitting dev first), does NOT spam staff
        const vFail = db.createSubmission({
          agentId: fpAgent.id,
          developerId: coauthorDev.id,
          version: '1.0.0-bad',
          package: 'bundle',
          url: 'https://example.com/bad.tar.zst',
          sha256: SHA,
          ladderIds: ['gen1ou20261109'],
          now: 1_760_000_100,
        });
        const failRes = db.applySubmissionStatus({
          versionId: vFail.id,
          smokeStatus: 'failed',
          smokeError: 'SyntaxError: invalid choice output',
          now: 1_760_000_105,
        });

        const sentFail = await discord.notifySubmissionStatus(
          db, 'discord-token', ARENA_CONFIG, failRes, state
        );
        expect(sentFail).toBe(true);
        expect(db.getVersionById(vFail.id)?.notified).toBe(true);
        expect(sentMessages.map(m => m.recipientOrChannel)).toEqual(['dm-1002', 'dm-1001']);
        expect(sentMessages[0].content).toContain('SyntaxError: invalid choice output');

        // Idempotent across subsequent syncSubmissionDms cycles
        sentMessages.length = 0;
        expect(await discord.syncSubmissionDms(db, 'discord-token', ARENA_CONFIG, state)).toBe(0);
        expect(sentMessages).toEqual([]);

        // 2. CLI-style quarantine (`notified = false` in DB): syncSubmissionDms DMs owners + staff
        const vGood = db.createSubmission({
          agentId: fpAgent.id,
          developerId: coauthorDev.id,
          version: '1.0.1',
          package: 'bundle',
          url: 'https://example.com/good.tar.zst',
          sha256: SHA,
          ladderIds: ['gen1ou20261109'],
          now: 1_760_000_200,
        });
        db.applySubmissionStatus({versionId: vGood.id, smokeStatus: 'passed', now: 1_760_000_210});
        db.quarantineVersion('foul-play', '1.0.1', 'Timed out in 5 consecutive matches');
        expect(db.getVersionById(vGood.id)?.notified).toBe(false);

        expect(await discord.syncSubmissionDms(db, 'discord-token', ARENA_CONFIG, state)).toBe(1);
        expect(db.getVersionById(vGood.id)?.notified).toBe(true);
        expect(sentMessages.map(m => m.recipientOrChannel)).toEqual([
          'dm-1002',
          'dm-1001',
          'dm-513513270670262284',
        ]);
        expect(sentMessages[2].content).toContain("owners DM'd: 2/2");

        // 3. Quarantined version with 0 linked Discord owners still alerts staff once via sync!
        const mmAgent = db.getAgentBySlug('metamon')!;
        const vNoDiscord = db.createSubmission({
          agentId: mmAgent.id,
          version: '0.8.0',
          package: 'bundle',
          url: 'https://example.com/mm-080.tar.zst',
          sha256: SHA,
          ladderIds: ['gen1ou20261109'],
          now: 1_760_000_250,
        });
        db.applySubmissionStatus({
          versionId: vNoDiscord.id,
          smokeStatus: 'passed',
          now: 1_760_000_260,
        });
        db.quarantineVersion('metamon', '0.8.0', 'Segfault in search thread');
        sentMessages.length = 0;
        expect(await discord.syncSubmissionDms(db, 'discord-token', ARENA_CONFIG, state)).toBe(1);
        expect(sentMessages.map(m => m.recipientOrChannel)).toEqual(['dm-513513270670262284']);
        expect(sentMessages[0].content).toContain("owners DM'd: 0/0");
        // Leaves notified = false so if owner links Discord later, they still get their DM
        expect(db.getVersionById(vNoDiscord.id)?.notified).toBe(false);
        db.markVersionNotified(vNoDiscord.id);

        // 4. Blocked DMs (403 / 50007): leaves notified = false and caches block so sync won't spam
        db.linkDeveloperDiscord('jakegrigsby', '1003', 'jake', 1_760_000_010);
        blockedUsers.add('1003');
        const warnSpy = console.warn;
        console.warn = () => undefined;
        try {
          const vBlocked = db.createSubmission({
            agentId: mmAgent.id,
            version: '0.9.0',
            package: 'bundle',
            url: 'https://example.com/mm.tar.zst',
            sha256: SHA,
            ladderIds: ['gen1ou20261109'],
            now: 1_762_000_300,
          });
          const blockedRes = db.applySubmissionStatus({
            versionId: vBlocked.id,
            smokeStatus: 'quarantined',
            smokeError: 'OOM on turn 3',
            now: 1_762_000_310,
          });
          sentMessages.length = 0;
          const sentBlocked = await discord.notifySubmissionStatus(
            db, 'discord-token', ARENA_CONFIG, blockedRes, state
          );
          expect(sentBlocked).toBe(true);
          expect(db.getVersionById(vBlocked.id)?.notified).toBe(false);
          // Staff STILL gets alerted on quarantine even when owner has DMs closed!
          expect(sentMessages.map(m => m.recipientOrChannel)).toEqual(['dm-513513270670262284']);
          expect(sentMessages[0].content).toContain("owners DM'd: 0/1");

          // Subsequent syncSubmissionDms skips blocked recipient without hitting Discord again
          let fetchCount = 0;
          globalThis.fetch = (() => {
            fetchCount++;
            return Promise.resolve({status: 500, ok: false, text: () => Promise.resolve('')});
          }) as unknown as typeof fetch;
          expect(await discord.syncSubmissionDms(db, 'discord-token', ARENA_CONFIG, state)).toBe(0);
          expect(fetchCount).toBe(0);
        } finally {
          console.warn = warnSpy;
        }
      } finally {
        db.close();
      }
    });

  test('notifyWatchdogAlert sends stalled-worker DM to configured staff', async () => {
    const sent: Array<{url: string; body: string}> = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const u = String(url);
      const rawBody = typeof init?.body === 'string' ? init.body : '';
      sent.push({url: u, body: rawBody});
      if (u.endsWith('/users/@me/channels')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve({id: 'dm-staff'}),
        });
      }
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve({id: 'msg-watchdog'}),
      });
    }) as unknown as typeof fetch;

    const count = await discord.notifyWatchdogAlert('discord-token', ARENA_CONFIG, {
      lastSeenAt: 1_762_807_500,
      lastMatchId: 'gen1ou-0000000972',
    });
    expect(count).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[0].body).toContain('513513270670262284');
    expect(sent[1].body).toContain('gen1ou-0000000972');
  });

  test('disables background Discord sync outside production unless DISCORD_SYNC=1', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevSync = process.env.DISCORD_SYNC;
    const prevBotToken = process.env.DISCORD_BOT_TOKEN;
    const calls: string[] = [];
    globalThis.fetch = ((url: string) => {
      calls.push(String(url));
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve([]),
        text: () => Promise.resolve(''),
      });
    }) as unknown as typeof fetch;

    const db = new Database(':memory:');
    try {
      process.env.NODE_ENV = 'development';
      delete process.env.DISCORD_SYNC;
      process.env.DISCORD_BOT_TOKEN = 'env-prod-bot-token';

      const app1 = polka();
      const h1 = discord.register(app1, {db, verifyKey: '00'.repeat(32)});
      await new Promise(resolve => setTimeout(resolve, 25));
      h1.stop();
      expect(calls).toEqual([]);

      // Opting in via DISCORD_SYNC=1 activates background sync using DISCORD_BOT_TOKEN
      process.env.DISCORD_SYNC = '1';
      const app2 = polka();
      const h2 = discord.register(app2, {db, verifyKey: '00'.repeat(32)});
      await new Promise(resolve => setTimeout(resolve, 25));
      h2.stop();
      expect(calls.some(u => u.startsWith('https://discord.com/api/v10'))).toBe(true);
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevSync === undefined) delete process.env.DISCORD_SYNC;
      else process.env.DISCORD_SYNC = prevSync;
      if (prevBotToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
      else process.env.DISCORD_BOT_TOKEN = prevBotToken;
      db.close();
    }
  });
});
