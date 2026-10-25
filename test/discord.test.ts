import {type Leader, findMember, ownerOf, syncRoles} from '../server/discord';

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
    const body = call.url.includes('vgc.bot') ? {leaders} : members;
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

  test('asks vgc.bot with the token, then moves each role, fetching the members once', async () => {
    const calls = stubFetch(LEADERS, MEMBERS);
    await syncRoles('token', 'vgc', CONFIG, new Map());
    expect(calls[0]).toEqual({method: 'GET', url: expect.stringContaining('vgc.bot'),
      authorization: 'Bearer vgc'});
    expect(memberFetches(calls)).toBe(1);
    expect(calls.filter(c => c.method !== 'GET').map(({method, url}) => ({method, url}))).toEqual([
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
    expect(calls.slice(before).map(c => c.url)).toEqual([expect.stringContaining('vgc.bot')]);
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
