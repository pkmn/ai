import * as crypto from 'crypto';

import {type Delivery, applyLeaders, verify} from '../server/discord';

const SECRET = 'webhook-secret';
const NOW = 1700000000000;
const BODY = '{"version":1,"leaders":[]}';
const VERSION2 = '{"version":2,"leaders":[]}';
const MALFORMED = '{"version":1,"leaders":{}}';
const NON_ASCII = 'sha256=' + 'é'.repeat(64);

function sign(timestamp: number, body: string, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${body}`).digest('hex');
}

function delivery(...leaders: Delivery['leaders']): Delivery {
  return {version: 1, leaders};
}

interface VerifyCase {
  name: string;
  // Why the delivery is not applied; left out where it is.
  reason?: string;
  body?: string;
  timestamp?: number;
  signature?: string;
  lastAccepted?: number;
}

describe('verify', () => {
  test.each<VerifyCase>([
    {name: 'valid', signature: sign(NOW, BODY)},
    {name: 'wrong secret', reason: 'bad signature', signature: sign(NOW, BODY, 'other')},
    {name: 'non-ASCII signature', reason: 'bad signature', signature: NON_ASCII},
    {name: 'unsigned', reason: 'unsigned'},
    {name: 'stale', reason: 'stale', timestamp: NOW - 300_001,
      signature: sign(NOW - 300_001, BODY)},
    {name: 'future', reason: 'stale', timestamp: NOW + 300_001,
      signature: sign(NOW + 300_001, BODY)},
    {name: 'applied', reason: 'already applied', signature: sign(NOW, BODY), lastAccepted: NOW},
    {name: 'unknown version', reason: 'unknown version or shape', body: VERSION2,
      signature: sign(NOW, VERSION2)},
    {name: 'malformed leaders', reason: 'unknown version or shape', body: MALFORMED,
      signature: sign(NOW, MALFORMED)},
  ])('$name', ({reason, body = BODY, timestamp = NOW, signature, lastAccepted = 0}) => {
    const headers = signature
      ? {'x-arena-timestamp': String(timestamp), 'x-arena-signature': signature}
      : {};
    expect(verify(Buffer.from(body), headers, SECRET, lastAccepted, NOW))
      .toEqual(reason ?? {delivery: JSON.parse(body), sent: timestamp});
  });

  test('pins the signature of a known body', () => {
    expect(sign(NOW, BODY)).toBe(
      'sha256=603e03acb67a8aaf164bda2b4d39baf3465564530c9c9f54c8d13a3c67ca19e2'
    );
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
    expect(await applyLeaders('token', CONFIG, delivery(
      {ladder: 'a', bot: null, owner: {discordId: '1'}}
    ))).toBe(true);
    expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
  });

  test('moves the role and takes it from one who no longer has it', async () => {
    const calls = stubFetch(MEMBERS);
    expect(await applyLeaders('token', CONFIG, delivery(
      {ladder: 'a', bot: null, owner: {discordId: 'new'}},
      {ladder: 'b', bot: {id: 'b1', name: 'Bot'}, owner: null}
    ))).toBe(true);
    expect(calls.slice(1)).toEqual([
      {method: 'DELETE', url: expect.stringContaining('/members/old/roles/role-a')},
      {method: 'PUT', url: expect.stringContaining('/members/new/roles/role-a')},
      {method: 'DELETE', url: expect.stringContaining('/members/old/roles/role-b')},
    ]);
  });

  test('gives the role to an override over what vgc.bot sends', async () => {
    const calls = stubFetch([{user: {id: '111', username: 'nessiedev'}, roles: []}]);
    expect(await applyLeaders('token', {...CONFIG, bots: {b1: '111'}}, delivery(
      {ladder: 'a', bot: {id: 'b1', name: 'Bot'}, owner: {discordId: '999'}}
    ))).toBe(true);
    expect(calls).toContainEqual({method: 'PUT',
      url: expect.stringContaining('/members/111/roles/role-a')});
  });

  test('a failing ladder does not stop the next one', async () => {
    const calls = stubFetch(MEMBERS,
      call => call.method === 'DELETE' && call.url.includes('role-a'));
    expect(await applyLeaders('token', CONFIG, delivery(
      {ladder: 'a', bot: null, owner: {discordId: 'new'}},
      {ladder: 'b', bot: null, owner: {discordId: 'new'}}
    ))).toBe(false);
    expect(calls).toContainEqual({method: 'PUT',
      url: expect.stringContaining('/members/new/roles/role-b')});
  });
});
