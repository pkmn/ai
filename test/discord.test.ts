import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  COMMANDS,
  type DiscordMessage,
  type Leader,
  autocompleteGlossary,
  findMember,
  formatGlossaryReply,
  formatMessage,
  handleInteraction,
  loadGlossary,
  lookupGlossary,
  ownerOf,
  syncCommands,
  syncMessages,
  syncPins,
  syncRoles,
  validateAuth,
} from '../server/discord';

const CONFIG = {
  guild: 'guild',
  ladders: {a: 'role-a', b: 'role-b'},
  bots: {Bot: 'sauce'},
  authors: {pelle: 'pll'},
};

function leader(ladder: string, bot: Leader['bot'], owner: Leader['owner']): Leader {
  return {ladder, bot, owner};
}

describe('ownerOf', () => {
  const bot = {id: 'b1', name: 'Other'};
  test.each<[string, Leader, ReturnType<typeof ownerOf>]>([
    ['the config override by bot name',
      leader('a', {id: 'b2', name: 'Bot'}, {name: 'x', discordId: '1'}), {name: 'sauce'}],
    ['the config override by bot family name for a version',
      leader('a', {id: 'b2', name: 'Bot v2'}, null), {name: 'sauce'}],
    ['the shared Discord account', leader('a', bot, {name: 'x', discordId: '1'}), {id: '1'}],
    ['the mapped author name', leader('a', bot, {name: 'pelle', discordId: null}), {name: 'pll'}],
    ['the author name', leader('a', bot, {name: 'x', discordId: null}), {name: 'x'}],
    ['nobody while the owner is private', leader('a', bot, null), undefined],
  ])('is %s', (_, l, expected) => {
    expect(ownerOf(l, CONFIG)).toEqual(expected);
  });
});

describe('findMember', () => {
  const members = [
    {user: {id: '1', username: 'nessiedev'}, roles: []},
    {user: {id: '2', username: 'other', global_name: '9'}, nick: '9', roles: []},
  ];

  test('an id matches the member id and nothing else', () => {
    expect(findMember(members, {id: '1'})?.user.username).toBe('nessiedev');
    expect(findMember(members, {id: '9'})).toBeUndefined();
  });

  test('a name matches the id, username, global name or nickname', () => {
    expect(findMember(members, {name: 'NESSIEDEV'})?.user.id).toBe('1');
    expect(findMember(members, {name: '9'})?.user.id).toBe('2');
  });
});

interface Call {
  method: string;
  url: string;
  authorization?: string;
}

const realFetch = globalThis.fetch;

function stubFetch(
  leaders: Leader[], members: object[], fail: (call: Call) => boolean = () => false
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

const MEMBERS = [{user: {id: 'old', username: 'old'}, roles: ['role-a', 'role-b']},
  {user: {id: 'new', username: 'new'}, roles: []}];
const LEADERS = [
  leader('a', {id: 'b1', name: 'Leader'}, {name: 'x', discordId: 'new'}),
  leader('b', null, null),
];
const memberFetches = (calls: Call[]) => calls.filter(c => c.url.includes('/members?')).length;

describe('syncRoles', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('asks both sites with the token, then moves each role, fetching the members once',
    async () => {
      const calls = stubFetch(LEADERS, MEMBERS);
      await syncRoles('token', 'vgc', CONFIG, new Map());
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
    const state = new Map();
    await syncRoles('token', 'vgc', CONFIG, state);
    const before = calls.length;
    await syncRoles('token', 'vgc', CONFIG, state);
    expect(calls.slice(before).map(c => c.url)).toEqual([
      expect.stringContaining('vgc.bot'),
      expect.stringContaining('pkmn.bot'),
    ]);
  });

  test('tries again next cycle while the owner is not in the server', async () => {
    const gone = leader('a', {id: 'b1', name: 'Leader'}, {name: 'x', discordId: 'gone'});
    const calls = stubFetch([gone], MEMBERS);
    const state = new Map();
    await syncRoles('token', 'vgc', CONFIG, state);
    await syncRoles('token', 'vgc', CONFIG, state);
    expect(memberFetches(calls)).toBe(2);
    expect(calls.filter(c => c.method === 'PUT')).toEqual([]);
  });

  test('a failing site does not stop the next one', async () => {
    const calls = stubFetch([
      leader('a', null, {name: 'x', discordId: 'new'}),
      leader('b', null, {name: 'x', discordId: 'new'}),
    ], MEMBERS, call => call.url.includes('vgc.bot'));
    const error = console.error;
    console.error = () => undefined;
    await syncRoles('token', 'vgc', CONFIG, new Map());
    console.error = error;
    expect(calls).toContainEqual(expect.objectContaining({method: 'PUT',
      url: expect.stringContaining('/members/new/roles/role-b')}));
  });

  test('a failing ladder does not stop the next one', async () => {
    const calls = stubFetch([
      leader('a', null, {name: 'x', discordId: 'new'}),
      leader('b', null, {name: 'x', discordId: 'new'}),
    ], MEMBERS, call => call.method === 'DELETE' && call.url.includes('role-a'));
    const error = console.error;
    console.error = () => undefined;
    await syncRoles('token', 'vgc', CONFIG, new Map());
    console.error = error;
    expect(calls).toContainEqual(expect.objectContaining({method: 'PUT',
      url: expect.stringContaining('/members/new/roles/role-b')}));
  });
});

describe('formatMessage', () => {
  const base: DiscordMessage = {
    id: '10',
    type: 0,
    timestamp: '2026-11-02T14:18:30.000Z',
    content: 'should we use PUCT or plain UCB?',
    author: {id: 'u1', username: 'bob'},
  };

  test('formats a standard message in IRC style', () => {
    expect(formatMessage(base)).toEqual({
      date: '2026-11-02',
      line: '[14:18:30] bob: should we use PUCT or plain UCB?',
    });
  });

  test('formats a same-day reply with @author[HH:MM:SS]', () => {
    const reply: DiscordMessage = {
      id: '11',
      type: 19,
      timestamp: '2026-11-02T14:22:05.000Z',
      content: 'PUCT works much better once you have a policy net',
      author: {id: 'u2', username: 'alice'},
      referenced_message: base,
    };
    expect(formatMessage(reply)).toEqual({
      date: '2026-11-02',
      line: '[14:22:05] alice: @bob[14:18:30] PUCT works much better once you have a policy net',
    });
  });

  test('formats a cross-day reply with @author[YYYY-MM-DD HH:MM:SS]', () => {
    const reply: DiscordMessage = {
      id: '12',
      type: 19,
      timestamp: '2026-11-03T00:05:10.000Z',
      content: 'agreed with alice',
      author: {id: 'u3', username: 'charlie'},
      referenced_message: base,
    };
    expect(formatMessage(reply)).toEqual({
      date: '2026-11-03',
      line: '[00:05:10] charlie: @bob[2026-11-02 14:18:30] agreed with alice',
    });
  });

  test('resolves user mentions and display names (nick > global_name > username)', () => {
    const msg: DiscordMessage = {
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
    const members = [
      {user: {id: '2', username: 'sauce_user', global_name: 'sauce'}, roles: []},
      {user: {id: '3', username: 'bob_user', global_name: 'Bob Global'}, nick: 'bobby', roles: []},
    ];
    expect(formatMessage(msg, members)?.line).toBe(
      '[14:18:30] pre: @bobby[14:18:30] hey @nessie and @sauce and @bobby and <@999>'
    );
  });

  test('includes clean attachment URLs for messages with or without text', () => {
    const url =
      'https://cdn.discordapp.com/attachments/689316506265321535/775113930074882068/img.jpg' +
      '?ex=6aea5619&is=6ae90499&hm=0563e093';
    expect(formatMessage({...base, content: 'look:', attachments: [{url}]})?.line).toBe(
      '[14:18:30] bob: look: https://cdn.discordapp.com/attachments/689316506265321535/775113930074882068/img.jpg'
    );
    expect(formatMessage({...base, content: '', attachments: [{url}]})?.line).toBe(
      '[14:18:30] bob: https://cdn.discordapp.com/attachments/689316506265321535/775113930074882068/img.jpg'
    );
  });

  test('resolves channels, roles, custom emojis, and timestamps', () => {
    const msg: DiscordMessage = {
      ...base,
      content: 'in <#10> ping <@&20> <:pokeball:99> at <t:1762093110:F>',
    };
    const channels = [{id: '10', name: 'general'}];
    const roles = [{id: '20', name: 'Gen 9 OU'}];
    expect(formatMessage(msg, undefined, channels, roles)?.line).toBe(
      '[14:18:30] bob: in #general ping @Gen 9 OU :pokeball: at 2025-11-02 14:18:30 UTC'
    );
  });

  test('formats polls, forwarded messages, embeds, stickers, and deleted replies', () => {
    const pollMsg: DiscordMessage = {
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
    expect(formatMessage(pollMsg)?.line).toBe(
      '[14:18:30] bob: [Poll: Best search?] 1. 🌲 PUCT (5) | 2. CFR (3)'
    );

    const forwarded: DiscordMessage = {
      ...base,
      content: 'thoughts?',
      message_snapshots: [{
        message: {
          content: 'new result in <#10>',
          attachments: [{url: 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=1'}],
        },
      }],
    };
    expect(formatMessage(forwarded, undefined, [{id: '10', name: 'papers'}])?.line).toBe(
      '[14:18:30] bob: thoughts? [Forwarded] new result in #papers https://cdn.discordapp.com/attachments/1/2/a.png'
    );

    const richEmbed: DiscordMessage = {
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
    expect(formatMessage(richEmbed)?.line).toBe(
      '[14:18:30] bob: [Embed: Tournament Result — 0-ERROR won — Score: 3-1 — https://pkmn.ai/leaderboard] [Sticker: pikachu]'
    );

    // Link preview embeds on normal text messages should not be duplicated
    const linkPreview: DiscordMessage = {
      ...base,
      content: 'see https://pkmn.ai',
      embeds: [{type: 'link', title: 'pkmn.ai', url: 'https://pkmn.ai'}],
    };
    expect(formatMessage(linkPreview)?.line).toBe('[14:18:30] bob: see https://pkmn.ai');

    const deletedReply: DiscordMessage = {
      ...base,
      type: 19,
      referenced_message: null,
      content: 'agree with that',
    };
    expect(formatMessage(deletedReply)?.line).toBe('[14:18:30] bob: @[deleted] agree with that');
  });

  test('skips empty messages and system message types', () => {
    expect(formatMessage({...base, content: '   '})).toBeUndefined();
    expect(formatMessage({...base, type: 7, content: 'joined'})).toBeUndefined();
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
    const batch1: DiscordMessage[] = [
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
    const batch2: DiscordMessage[] = [
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

    await syncMessages('token', 'chan', tmpDir);
    expect(urls).toEqual([expect.stringContaining('/channels/chan/messages?limit=100&after=0')]);
    expect(fs.readFileSync(path.join(tmpDir, '2026-11-02.txt'), 'utf8')).toBe(
      '[14:18:30] bob: first message\n' +
      '[14:22:05] alice: @bob[14:18:30] second message (typo)\n'
    );
    expect(fs.readFileSync(path.join(tmpDir, '.cursor'), 'utf8')).toBe('0\n2026-11-02.txt 0\n');

    await syncMessages('token', 'chan', tmpDir);
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
    const fullPage: DiscordMessage[] = Array.from({length: 100}, (_, i) => ({
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

    await syncMessages('token', 'chan', tmpDir);
    // Older 50 are ids 101..150, so after advances to page[50].id === '150'
    const cursor = fs.readFileSync(path.join(tmpDir, '.cursor'), 'utf8');
    expect(cursor).toMatch(/^150\n2026-11-03\.txt \d+\n$/);
  });
});

describe('syncPins', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('replaces user pins with bot pins in reverse order and deletes system messages',
    async () => {
      const actions: Array<{method: string; url: string; body?: string}> = [];
      let nextId = 100;
      const userPins: DiscordMessage[] = [
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
          const created: DiscordMessage = {
            id: String(++nextId),
            timestamp: '2026-11-07T00:00:00Z',
            content,
            author: {id: 'bot', username: 'pkmn', bot: true},
          };
          return Promise.resolve({status: 200, ok: true, json: () => Promise.resolve(created)});
        }
        if (method === 'GET' && u.includes('/messages?limit=')) {
          const recent: DiscordMessage[] = [
            {id: '201', type: 6, timestamp: '2026-11-07T00:00:00Z', content: '',
              author: {id: 'bot', username: 'pkmn', bot: true}},
            {id: '202', type: 6, timestamp: '2026-11-07T00:00:00Z', content: '',
              author: {id: 'u1', username: 'pre'}},
            {id: '103', type: 0, timestamp: '2026-11-07T00:00:00Z', content: 'first',
              author: {id: 'bot', username: 'pkmn', bot: true}},
          ];
          return Promise.resolve({status: 200, ok: true, json: () => Promise.resolve(recent)});
        }
        return Promise.resolve({status: 204, ok: true});
      }) as unknown as typeof fetch;

      const state = new Map<string, string | undefined>();
      await syncPins('token', 'chan', ['first', 'second', 'third'], state);

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
      await syncPins('token', 'chan', ['first', 'second', 'third'], state);
      expect(actions).toEqual([]);
    });

  test('reuses unchanged bot pins, replaces changed ones, and deletes stale bot pins', async () => {
    const actions: Array<{method: string; url: string; body?: string}> = [];
    const botPins: DiscordMessage[] = [
      {id: '103', timestamp: '2026-11-07T00:00:00Z', content: 'first',
        author: {id: 'bot', username: 'pkmn', bot: true}},
      {id: '102', timestamp: '2026-11-07T00:00:00Z', content: 'second',
        author: {id: 'bot', username: 'pkmn', bot: true}},
      {id: '101', timestamp: '2026-11-07T00:00:00Z', content: 'third',
        author: {id: 'bot', username: 'pkmn', bot: true}},
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
          json: () => Promise.resolve({items: botPins.map(message => ({message}))}),
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
            author: {id: 'bot', username: 'pkmn', bot: true},
          }),
        });
      }
      if (method === 'GET' && u.includes('/messages?limit=')) {
        return Promise.resolve({status: 200, ok: true, json: () => Promise.resolve([])});
      }
      return Promise.resolve({status: 204, ok: true});
    }) as unknown as typeof fetch;

    // Already in sync -> no mutations
    await syncPins('token', 'chan', ['first', 'second', 'third']);
    expect(actions).toEqual([
      {method: 'GET', url: expect.stringContaining('/channels/chan/messages/pins')},
    ]);

    // Update the 3rd pin -> unpins all, posts only 'third v2', deletes old bot msg 101, repins
    actions.length = 0;
    await syncPins('token', 'chan', ['first', 'second', 'third v2']);
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

describe('validateAuth', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubVouch(status: number, headers: Record<string, string>) {
    globalThis.fetch = (() => Promise.resolve({
      status,
      ok: status === 200,
      headers: new Headers(headers),
    })) as unknown as typeof fetch;
  }

  test('forwards 401 and x-vouch-* headers when unauthenticated', async () => {
    stubVouch(401, {'x-vouch-err': 'no jwt', 'x-vouch-failcount': '1'});
    const res = await validateAuth('/vouch/validate', {}, new Set(['1']));
    expect(res).toEqual({
      status: 401,
      headers: {'x-vouch-err': 'no jwt', 'x-vouch-failcount': '1'},
    });
  });

  test('checks guild membership for /vouch/validate', async () => {
    const members = new Set(['member']);

    stubVouch(200, {'x-vouch-user': 'member'});
    expect((await validateAuth('/vouch/validate', {}, members)).status).toBe(200);

    stubVouch(200, {'x-vouch-user': 'outsider'});
    expect((await validateAuth('/vouch/validate', {}, members)).status).toBe(403);
  });

  test('supports Bearer token auth and serves /chat/logs/token for guild members', async () => {
    let forwardedHeaders: Record<string, string> = {};
    globalThis.fetch = ((_: string, init?: {headers?: Record<string, string>}) => {
      forwardedHeaders = init?.headers ?? {};
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: new Headers({'x-vouch-user': 'member'}),
      });
    }) as unknown as typeof fetch;

    const members = new Set(['member']);
    const authRes = await validateAuth(
      '/vouch/validate',
      {authorization: 'Bearer my-jwt'},
      members
    );
    expect(authRes.status).toBe(200);
    expect(forwardedHeaders['x-vouch-token']).toBe('my-jwt');
    expect(forwardedHeaders.cookie).toContain('VouchCookie=my-jwt');

    const tokenRes = await validateAuth(
      '/chat/logs/token',
      {cookie: 'VouchCookie=cookie-jwt'},
      members
    );
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body).toBe('cookie-jwt\n');
  });
});

describe('glossary slash commands', () => {
  const glossary = loadGlossary();
  const {publicKey, privateKey} = crypto.generateKeyPairSync('ed25519');
  const verifyKey = publicKey.export({type: 'spki', format: 'der'}).subarray(12).toString('hex');

  function signedInteraction(payload: object, timestamp = '1700000000') {
    const body = JSON.stringify(payload);
    const sig = crypto.sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString('hex');
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
      const reply = formatGlossaryReply(term, raw);
      expect(reply.startsWith(`**[${term}](https://pkmn.ai/glossary/#`)).toBe(true);
      expect(reply.length).toBeLessThanOrEqual(2000);
      expect(reply).not.toMatch(/\{[^}]+\}/);
      expect(reply).not.toMatch(/\$`/);
    }
  });

  test('looks up exact keys, slugs/IDs, and {.dfn} aliases', () => {
    expect(lookupGlossary('NE', glossary)?.term).toBe('NE');
    expect(lookupGlossary('ne', glossary)?.term).toBe('NE');
    expect(lookupGlossary('nash', glossary)?.term).toBe('NE');
    expect(lookupGlossary('Nash', glossary)?.term).toBe('NE');
    expect(lookupGlossary('Nash equilibrium', glossary)?.term).toBe('NE');
    expect(lookupGlossary('MNE', glossary)?.term).toBe('NE');
    expect(lookupGlossary('alpha-beta', glossary)?.term).toBe('alpha-beta');
    expect(lookupGlossary('alphabeta', glossary)?.term).toBe('alpha-beta');
    expect(lookupGlossary('reinforcement learning', glossary)?.term).toBe('RL');
    expect(lookupGlossary('nonexistentterm123', glossary)).toBeUndefined();
  });

  test('autocompletes matching terms and aliases up to 25 choices', () => {
    const empty = autocompleteGlossary('', glossary);
    expect(empty).toHaveLength(25);

    const ne = autocompleteGlossary('Nash', glossary);
    expect(ne[0]).toEqual({name: 'Nash equilibrium (NE)', value: 'NE'});

    const cfr = autocompleteGlossary('CFR', glossary);
    expect(cfr[0]).toEqual({name: 'CFR', value: 'CFR'});
  });

  test('verifies Ed25519 signatures and handles PING, /def, and autocomplete', () => {
    const bad = handleInteraction('{"type":1}', {}, verifyKey, glossary);
    expect(bad.status).toBe(401);

    const ping = signedInteraction({type: 1});
    const pingRes = handleInteraction(ping.body, ping.headers, verifyKey, glossary);
    expect(pingRes.status).toBe(200);
    expect(JSON.parse(pingRes.body!)).toEqual({type: 1});

    const cmd = signedInteraction({
      type: 2,
      data: {name: 'def', options: [{name: 'term', value: 'NE'}]},
    });
    const res = handleInteraction(cmd.body, cmd.headers, verifyKey, glossary);
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
      data: {name: 'def', options: [{name: 'term', value: 'not-a-term'}]},
    });
    const unknownRes = handleInteraction(unknown.body, unknown.headers, verifyKey, glossary);
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
      data: {name: 'def', options: [{name: 'term', value: 'NE', focused: true}]},
    });
    const autoRes = handleInteraction(auto.body, auto.headers, verifyKey, glossary);
    expect(autoRes.status).toBe(200);
    const autoData = JSON.parse(autoRes.body!) as {
      type: number;
      data: {choices: Array<{name: string; value: string}>};
    };
    expect(autoData.type).toBe(8);
    expect(autoData.data.choices[0]).toEqual({name: 'NE', value: 'NE'});
  });

  test('syncCommands registers /def when missing and skips PUT when in sync', async () => {
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
    const app = await syncCommands('token', 'guild1', state);
    expect(app).toEqual({id: 'app1', verify_key: verifyKey});
    expect(calls.map(c => c.method)).toEqual(['GET', 'GET', 'PUT']);
    expect(JSON.parse(calls[2].body!)).toEqual(COMMANDS);

    await syncCommands('token', 'guild1', state);
    expect(calls).toHaveLength(3);

    const freshState = new Map<string, string | undefined>();
    await syncCommands('token', 'guild1', freshState);
    expect(calls.map(c => c.method)).toEqual(['GET', 'GET', 'PUT', 'GET', 'GET']);
  });
});
