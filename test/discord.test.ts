import {Webhook} from 'standardwebhooks';

import {type Delivery, applyLeaders, verify} from '../server/discord';

const WEBHOOK = new Webhook('d2ViaG9vay1zZWNyZXQ=');
const BODY = '{"version":1,"leaders":[]}';
const VERSION2 = '{"version":2,"leaders":[]}';
const MALFORMED = '{"version":1,"leaders":{}}';

const seconds = (at: Date) => Math.floor(at.getTime() / 1000);

function signed(body: string, at: Date, webhook = WEBHOOK) {
  const id = String(at.getTime());
  return {'webhook-id': id, 'webhook-timestamp': String(seconds(at)),
    'webhook-signature': webhook.sign(id, at, body)};
}

function delivery(...leaders: Delivery['leaders']): Delivery {
  return {version: 1, leaders};
}

interface VerifyCase {
  name: string;
  reason?: string;
  body?: string;
  at?: Date;
  webhook?: Webhook;
  headers?: Record<string, string>;
  lastAccepted?: number;
}

describe('verify', () => {
  const now = new Date();
  test.each<VerifyCase>([
    {name: 'valid'},
    {name: 'wrong secret', reason: 'No matching signature found', webhook: new Webhook('b3RoZXI=')},
    {name: 'unsigned', reason: 'Missing required headers', headers: {}},
    {name: 'stale', reason: 'Message timestamp too old', at: new Date(now.getTime() - 301_000)},
    {name: 'future', reason: 'Message timestamp too new', at: new Date(now.getTime() + 301_000)},
    {name: 'applied', reason: 'already applied', lastAccepted: seconds(now)},
    {name: 'unknown version', reason: 'unknown version or shape', body: VERSION2},
    {name: 'malformed leaders', reason: 'unknown version or shape', body: MALFORMED},
  ])('$name', ({
    reason, body = BODY, at = now, webhook = WEBHOOK, headers = signed(body, at, webhook),
    lastAccepted = 0,
  }) => {
    expect(verify(Buffer.from(body), headers, WEBHOOK, lastAccepted))
      .toEqual(reason ?? {delivery: JSON.parse(body), sent: seconds(at)});
  });

  test('pins the signature of a known body', () => {
    expect(WEBHOOK.sign('1700000000000', new Date(1700000000000), BODY))
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
