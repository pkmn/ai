import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  type DiscordMessage,
  type Leader,
  findMember,
  formatMessage,
  ownerOf,
  syncMessages,
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

  test('writes chronological daily logs and resumes from cursor', async () => {
    const urls: string[] = [];
    const batch1: DiscordMessage[] = [
      {
        id: '102',
        timestamp: '2026-11-02T14:22:05.000Z',
        content: 'second message',
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
    ];

    globalThis.fetch = ((url: string) => {
      urls.push(String(url));
      const body = String(url).endsWith('after=0') ? batch1 : batch2;
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
      '[14:22:05] alice: @bob[14:18:30] second message\n'
    );
    expect(fs.readFileSync(path.join(tmpDir, '.cursor'), 'utf8')).toBe('102\n');

    await syncMessages('token', 'chan', tmpDir);
    expect(urls[1]).toContain('/channels/chan/messages?limit=100&after=102');
    expect(fs.readFileSync(path.join(tmpDir, '2026-11-03.txt'), 'utf8')).toBe(
      '[01:02:03] bob: next day message\n'
    );
    expect(fs.readFileSync(path.join(tmpDir, '.cursor'), 'utf8')).toBe('103\n');
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
});
