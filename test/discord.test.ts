import * as crypto from 'crypto';

import {type Delivery, applyLeaders, verify} from '../server/discord';

const SECRET = Buffer.from('d2ViaG9vay1zZWNyZXQ=', 'base64');
const NOW = 1700000000000;
const BODY = '{"version":1,"leaders":[]}';
const VERSION2 = '{"version":2,"leaders":[]}';
const MALFORMED = '{"version":1,"leaders":{}}';

function sign(id: string, timestamp: number, body: string, secret: Buffer = SECRET) {
  return 'v1,' + crypto.createHmac('sha256', secret)
    .update(`${id}.${timestamp}.${body}`).digest('base64');
}

function signed(body: string, at: number, secret: Buffer = SECRET) {
  const id = String(at);
  const timestamp = Math.floor(at / 1000);
  return {'webhook-id': id, 'webhook-timestamp': String(timestamp),
    'webhook-signature': sign(id, timestamp, body, secret)};
}

function delivery(...leaders: Delivery['leaders']): Delivery {
  return {version: 1, leaders};
}

interface Rejection {
  name: string;
  reason: string;
  body?: string;
  at?: number;
  secret?: Buffer;
  headers?: Record<string, string>;
  lastAccepted?: number;
}

describe('verify', () => {
  test('returns the delivery and when it was sent', () => {
    expect(verify(Buffer.from(BODY), signed(BODY, NOW), SECRET, 0, NOW))
      .toEqual({delivery: JSON.parse(BODY), sent: NOW / 1000});
  });

  test.each<Rejection>([
    {name: 'wrong secret', reason: 'bad signature', secret: Buffer.from('other')},
    {name: 'unsigned', reason: 'unsigned', headers: {}},
    {name: 'stale', reason: 'stale', at: NOW - 301_000},
    {name: 'future', reason: 'stale', at: NOW + 301_000},
    {name: 'applied', reason: 'already applied', lastAccepted: NOW / 1000},
    {name: 'unknown version', reason: 'unknown version or shape', body: VERSION2},
    {name: 'malformed leaders', reason: 'unknown version or shape', body: MALFORMED},
  ])('throws on $name', ({
    reason, body = BODY, at = NOW, secret = SECRET, headers = signed(body, at, secret),
    lastAccepted = 0,
  }) => {
    expect(() => verify(Buffer.from(body), headers, SECRET, lastAccepted, NOW)).toThrow(reason);
  });

  test('pins the signature of a known body', () => {
    expect(sign('1700000000000', 1700000000, BODY))
      .toBe('v1,2QBVDD/rCh2YNefjsl0i9mAgfPPEHQ43EDhGAe12PAs=');
  });
});

interface Call {
  method: string;
  url: string;
}

const realFetch = globalThis.fetch;

function stubFetch(members: object[], fail: (call: Call) => boolean = () => false) {
  const calls: Call[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const call = {method: init?.method ?? 'GET', url: String(url)};
    calls.push(call);
    const status = fail(call) ? 500 : call.method === 'GET' ? 200 : 204;
    const body = status === 200 ? members : 'boom';
    return Promise.resolve({status, ok: status < 300, text: () => Promise.resolve(''),
      json: () => Promise.resolve(body)});
  }) as unknown as typeof fetch;
  return calls;
}

const CONFIG = {guild: 'guild', ladders: {a: 'role-a', b: 'role-b'}};
const MEMBERS = [{user: {id: 'old', username: 'old'}, roles: ['role-a', 'role-b']},
  {user: {id: 'new', username: 'new'}, roles: []}];

describe('applyLeaders', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("matches vgc.bot's discordId only against a member id", async () => {
    const calls = stubFetch([{user: {id: '9', username: 'imp', global_name: '1'}, nick: '1',
      roles: []}]);
    await applyLeaders('token', CONFIG,
      delivery({ladder: 'a', bot: null, owner: {discordId: '1'}}));
    expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
  });

  test('moves the role and takes it from one who no longer has it', async () => {
    const calls = stubFetch(MEMBERS);
    await applyLeaders('token', CONFIG, delivery(
      {ladder: 'a', bot: null, owner: {discordId: 'new'}},
      {ladder: 'b', bot: {id: 'b1', name: 'Bot'}, owner: null}
    ));
    expect(calls.slice(1)).toEqual([
      {method: 'DELETE', url: expect.stringContaining('/members/old/roles/role-a')},
      {method: 'PUT', url: expect.stringContaining('/members/new/roles/role-a')},
      {method: 'DELETE', url: expect.stringContaining('/members/old/roles/role-b')},
    ]);
  });

  test('gives the role to an override over what vgc.bot sends', async () => {
    const calls = stubFetch([{user: {id: '111', username: 'nessiedev'}, roles: []}]);
    await applyLeaders('token', {...CONFIG, bots: {b1: 'NessieDev'}}, delivery(
      {ladder: 'a', bot: {id: 'b1', name: 'Bot'}, owner: {discordId: '999'}}
    ));
    expect(calls).toContainEqual({method: 'PUT',
      url: expect.stringContaining('/members/111/roles/role-a')});
  });

  test('a failing ladder does not stop the next one', async () => {
    const calls = stubFetch(MEMBERS,
      call => call.method === 'DELETE' && call.url.includes('role-a'));
    await applyLeaders('token', CONFIG, delivery(
      {ladder: 'a', bot: null, owner: {discordId: 'new'}},
      {ladder: 'b', bot: null, owner: {discordId: 'new'}}
    ));
    expect(calls).toContainEqual({method: 'PUT',
      url: expect.stringContaining('/members/new/roles/role-b')});
  });
});
