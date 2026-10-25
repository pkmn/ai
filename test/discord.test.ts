import * as crypto from 'crypto';

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

import {type Delivery, applyLeaders, findMember, reconciler, verify} from '../server/discord';

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

describe('verify', () => {
  test.each<{name: string; kind: 'apply' | 'ignore' | 'reject'; status?: number; body?: string;
    timestamp?: number; signature?: string; lastAccepted?: number;}>([
    {name: 'valid', kind: 'apply', signature: sign(NOW, BODY)},
    {name: 'wrong secret', kind: 'reject', status: 401, signature: sign(NOW, BODY, 'other')},
    {name: 'non-ASCII signature', kind: 'reject', status: 401, signature: NON_ASCII},
    {name: 'unsigned', kind: 'reject', status: 401},
    {name: 'stale', kind: 'reject', status: 400, timestamp: NOW - 300_001,
      signature: sign(NOW - 300_001, BODY)},
    {name: 'future', kind: 'reject', status: 400, timestamp: NOW + 300_001,
      signature: sign(NOW + 300_001, BODY)},
    {name: 'applied', kind: 'ignore', signature: sign(NOW, BODY), lastAccepted: NOW},
    {name: 'unknown version', kind: 'reject', status: 400, body: VERSION2,
      signature: sign(NOW, VERSION2)},
    {name: 'malformed leaders', kind: 'reject', status: 400, body: MALFORMED,
      signature: sign(NOW, MALFORMED)},
  ])('$name', ({kind, status, body = BODY, timestamp = NOW, signature, lastAccepted = 0}) => {
    const headers = signature
      ? {'x-arena-timestamp': String(timestamp), 'x-arena-signature': signature}
      : {};
    let verified!: ReturnType<typeof verify>;
    expect(() => {
      verified = verify(Buffer.from(body), headers, SECRET, lastAccepted, NOW);
    }).not.toThrow();
    expect(verified.kind).toBe(kind);
    if (status) expect(verified).toMatchObject({status});
  });

  test('signs the vector vgc.bot carries', () => {
    expect(sign(NOW, BODY)).toBe(
      'sha256=603e03acb67a8aaf164bda2b4d39baf3465564530c9c9f54c8d13a3c67ca19e2'
    );
  });
});

describe('findMember', () => {
  test('matches by id or username, never by nickname or global name', () => {
    const members = [{user: {id: '1', username: 'nessiedev'}, roles: []},
      {user: {id: '2', username: 'other', global_name: 'SAUCE'}, nick: 'sauce', roles: []}];
    expect(findMember(members, '1')?.user.username).toBe('nessiedev');
    expect(findMember(members, 'NESSIEDEV')?.user.id).toBe('1');
    expect(findMember(members, 'sauce')).toBeUndefined();
  });
});

interface Call {
  method: string;
  url: string;
}

function stubFetch(members: object[], fail: (call: Call) => boolean = () => false) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const call = {method: init?.method ?? 'GET', url: String(url)};
    calls.push(call);
    const status = fail(call) ? 500 : call.method === 'GET' ? 200 : 204;
    const body = status === 200 ? members : 'boom';
    return Promise.resolve({status, ok: status < 300, text: () => Promise.resolve(''),
      json: () => Promise.resolve(body)});
  }));
  return calls;
}

const CONFIG = {guild: 'guild', ladders: {a: 'role-a', b: 'role-b'}};
const MEMBERS = [{user: {id: 'old', username: 'old'}, roles: ['role-a', 'role-b']},
  {user: {id: 'new', username: 'new'}, roles: []}];

describe('applyLeaders', () => {
  afterEach(() => vi.unstubAllGlobals());

  test("matches vgc.bot's discordId only against a member id", async () => {
    const calls = stubFetch([{user: {id: '9', username: 'imp', global_name: '1'}, nick: '1',
      roles: []}]);
    expect(await applyLeaders('token', CONFIG, {version: 1 as const,
      leaders: [{ladder: 'a', bot: null, owner: {discordId: '1'}}]})).toBe(true);
    expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
  });

  test('moves the role and takes it from one who no longer has it', async () => {
    const calls = stubFetch(MEMBERS);
    expect(await applyLeaders('token', CONFIG, {version: 1 as const, leaders: [
      {ladder: 'a', bot: null, owner: {discordId: 'new'}},
      {ladder: 'b', bot: {id: 'b1', name: 'Bot'}, owner: null},
    ]})).toBe(true);
    expect(calls.slice(1)).toEqual([
      {method: 'DELETE', url: expect.stringContaining('/members/old/roles/role-a')},
      {method: 'PUT', url: expect.stringContaining('/members/new/roles/role-a')},
      {method: 'DELETE', url: expect.stringContaining('/members/old/roles/role-b')},
    ]);
  });

  test('gives the role to an override over what vgc.bot sends', async () => {
    const calls = stubFetch([{user: {id: '111', username: 'nessiedev'}, roles: []}]);
    expect(await applyLeaders('token', {...CONFIG, bots: {b1: 'NessieDev'}},
      {version: 1 as const, leaders: [
        {ladder: 'a', bot: {id: 'b1', name: 'Bot'}, owner: {discordId: '999'}},
      ]})).toBe(true);
    expect(calls).toContainEqual({method: 'PUT',
      url: expect.stringContaining('/members/111/roles/role-a')});
  });

  test('a failing ladder does not stop the next one', async () => {
    const calls = stubFetch(MEMBERS,
      call => call.method === 'DELETE' && call.url.includes('role-a'));
    expect(await applyLeaders('token', CONFIG, {version: 1 as const, leaders: [
      {ladder: 'a', bot: null, owner: {discordId: 'new'}},
      {ladder: 'b', bot: null, owner: {discordId: 'new'}},
    ]})).toBe(false);
    expect(calls).toContainEqual({method: 'PUT',
      url: expect.stringContaining('/members/new/roles/role-b')});
  });
});

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(r => {
    resolve = r;
  });
  return {promise, resolve};
}

describe('reconciler', () => {
  const first: Delivery = {version: 1, leaders: [{ladder: 'a', bot: null, owner: null}]};
  const second: Delivery = {version: 1, leaders: [{ladder: 'b', bot: null, owner: null}]};

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('retries a failed apply on every tick until it succeeds', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const apply = vi.fn<(delivery: Delivery) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const queue = reconciler(apply, 60_000);
    queue.offer(first);
    for (const [ms, calls] of [[0, 1], [60_000, 2], [60_000, 3]]) {
      await vi.advanceTimersByTimeAsync(ms);
      expect(apply).toHaveBeenCalledTimes(calls);
    }
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(apply).toHaveBeenCalledTimes(3);
    error.mockRestore();
    queue.stop();
  });

  test('runs a delivery offered while applying right after, never at once', async () => {
    const inFlight = deferred();
    const apply = vi.fn<(delivery: Delivery) => Promise<boolean>>()
      .mockImplementationOnce(() => inFlight.promise).mockResolvedValue(true);
    const queue = reconciler(apply, 60_000);
    queue.offer(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(apply.mock.calls).toEqual([[first]]);
    queue.offer(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(apply.mock.calls).toEqual([[first]]);
    inFlight.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(apply.mock.calls).toEqual([[first], [second]]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(apply.mock.calls).toEqual([[first], [second]]);
    queue.stop();
  });
});
