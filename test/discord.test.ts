import * as crypto from 'crypto';

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

import {type Delivery, applyLeaders, findMember, reconciler, verify} from '../server/discord';

const SECRET = 'webhook-secret';
const NOW = 1700000000000;
const MAX_AGE_MS = 5 * 60_000;

function sign(timestamp: number, body: string, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${body}`).digest('hex');
}

function headers(timestamp: number, signature: string) {
  return {'x-arena-timestamp': String(timestamp), 'x-arena-signature': signature};
}

function verifyBody(body: string, timestamp = NOW, signature = sign(timestamp, body)) {
  return verify(Buffer.from(body), headers(timestamp, signature), SECRET, 0, NOW);
}

describe('verify', () => {
  test('accepts a valid delivery', () => {
    const body = '{"version":1,"leaders":[' +
      '{"ladder":"a","bot":{"id":"b1","name":"Bot"},"owner":{"discordId":"123"}}]}';
    expect(verifyBody(body)).toEqual({
      kind: 'apply',
      delivery: {
        version: 1,
        leaders: [{ladder: 'a', bot: {id: 'b1', name: 'Bot'}, owner: {discordId: '123'}}],
      },
      sent: NOW,
    });
  });

  test('accepts the fixed vector', () => {
    const body = '{"version":1,"leaders":[]}';
    const signature = sign(NOW, body);
    expect(signature).toBe(
      'sha256=603e03acb67a8aaf164bda2b4d39baf3465564530c9c9f54c8d13a3c67ca19e2'
    );
    expect(verify(Buffer.from(body), headers(NOW, signature), SECRET, 0, NOW).kind).toBe('apply');
  });

  test('turns away a delivery with missing headers', () => {
    const body = '{"version":1,"leaders":[]}';
    expect(verify(Buffer.from(body), {}, SECRET, 0, NOW))
      .toMatchObject({kind: 'reject', status: 401});
    expect(verify(Buffer.from(body), {'x-arena-timestamp': String(NOW)}, SECRET, 0, NOW))
      .toMatchObject({kind: 'reject', status: 401});
  });

  test('turns away a bad signature', () => {
    const body = '{"version":1,"leaders":[]}';
    expect(verifyBody(body, NOW, sign(NOW, body, 'other-secret')))
      .toMatchObject({kind: 'reject', status: 401, reason: 'bad signature'});
  });

  test('rejects a same-length non-ASCII signature instead of throwing', () => {
    const signature = 'sha256=' + 'é'.repeat(64);
    expect(signature).toHaveLength(71);
    expect(Buffer.byteLength(signature)).toBeGreaterThan(71);
    const verifySignature = () => verify(
      Buffer.from('{"version":1,"leaders":[]}'), headers(NOW, signature), SECRET, 0, NOW
    );
    expect(verifySignature).not.toThrow();
    expect(verifySignature()).toMatchObject({kind: 'reject', status: 401});
  });

  test('turns away stale deliveries in both directions', () => {
    const body = '{"version":1,"leaders":[]}';
    const old = NOW - MAX_AGE_MS - 1;
    expect(verifyBody(body, old)).toMatchObject({kind: 'reject', status: 400, reason: 'stale'});
    const future = NOW + MAX_AGE_MS + 1;
    expect(verifyBody(body, future)).toMatchObject({kind: 'reject', status: 400, reason: 'stale'});
  });

  test('acknowledges a delivery at or before lastAccepted without applying it', () => {
    const body = '{"version":1,"leaders":[]}';
    const signature = sign(NOW, body);
    expect(verify(Buffer.from(body), headers(NOW, signature), SECRET, NOW, NOW))
      .toEqual({kind: 'ignore', reason: 'already applied'});
    expect(verify(Buffer.from(body), headers(NOW, signature), SECRET, NOW + 1, NOW))
      .toMatchObject({kind: 'ignore'});
  });

  test('turns away invalid JSON', () => {
    expect(verifyBody('not json')).toMatchObject({kind: 'reject', status: 400, reason: 'not JSON'});
  });

  test('turns away an unknown version', () => {
    expect(verifyBody('{"version":2,"leaders":[]}'))
      .toMatchObject({kind: 'reject', status: 400});
  });

  test('turns away malformed leaders', () => {
    const bodies = [
      '{"version":1,"leaders":{}}',
      '{"version":1,"leaders":[{"ladder":1,"bot":null,"owner":null}]}',
      '{"version":1,"leaders":[{"ladder":"a","bot":{"id":"b1"},"owner":null}]}',
      '{"version":1,"leaders":[{"ladder":"a","bot":null,"owner":{"discordId":"abc"}}]}',
      '{"version":1,"leaders":[{"ladder":"a"}]}',
    ];
    for (const body of bodies) {
      expect(verifyBody(body)).toMatchObject({kind: 'reject', status: 400});
    }
  });
});

interface TestMember {
  user: {id: string; username: string; global_name?: string};
  nick?: string;
  roles: string[];
}

function member(
  id: string, username: string, roles: string[] = [],
  handles: {global_name?: string; nick?: string} = {}
): TestMember {
  return {user: {id, username, global_name: handles.global_name}, nick: handles.nick, roles};
}

describe('findMember', () => {
  const members = [member('111', 'nessiedev')];

  test('matches an override by Discord id', () => {
    expect(findMember(members, '111')?.user.username).toBe('nessiedev');
  });

  test('matches an override by username, case-insensitively', () => {
    expect(findMember(members, 'NessieDev')?.user.id).toBe('111');
    expect(findMember(members, 'NESSIEDEV')?.user.id).toBe('111');
  });

  test('ignores global names and nicknames', () => {
    const list = [member('111', 'nessiedev', [], {global_name: 'SAUCE1337', nick: 'sauce1337'})];
    expect(findMember(list, 'sauce1337')).toBeUndefined();
    expect(findMember(list, 'SAUCE1337')).toBeUndefined();
  });

  test('ignores a missing override', () => {
    expect(findMember(members, undefined)).toBeUndefined();
  });
});

interface Call {
  method: string;
  url: string;
}

function response(status: number, body: unknown) {
  return {
    status,
    ok: status < 300,
    text: () => Promise.resolve(typeof body === 'string' ? body : ''),
    json: () => Promise.resolve(body),
  };
}

function stubFetch(members: TestMember[], fail: (call: Call) => boolean = () => false): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    const call = {method: init?.method ?? 'GET', url: String(input)};
    calls.push(call);
    if (fail(call)) return Promise.resolve(response(500, 'boom'));
    return Promise.resolve(response(call.method === 'GET' ? 200 : 204, members));
  }));
  return calls;
}

const CONFIG = {guild: 'guild', ladders: {a: 'role-a', b: 'role-b'}};

function delivery(leaders: {
  ladder: string;
  bot: {id: string; name: string} | null;
  owner: {discordId: string} | null;
}[]) {
  return {version: 1 as const, leaders};
}

describe('applyLeaders', () => {
  afterEach(() => vi.unstubAllGlobals());

  test("matches vgc.bot's discordId only by member id", async () => {
    const members = [member('999', 'impostor', [], {global_name: '123', nick: '123'})];
    const calls = stubFetch(members);
    const ok = await applyLeaders('token', CONFIG,
      delivery([{ladder: 'a', bot: null, owner: {discordId: '123'}}]));
    expect(ok).toBe(true);
    expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
  });

  test('moves the role from the old holder to the new one', async () => {
    const members = [member('old', 'old', ['role-a']), member('new', 'new')];
    const calls = stubFetch(members);
    const ok = await applyLeaders('token', CONFIG,
      delivery([{ladder: 'a', bot: null, owner: {discordId: 'new'}}]));
    expect(ok).toBe(true);
    expect(calls.slice(1)).toEqual([
      {method: 'DELETE', url: expect.stringContaining('/members/old/roles/role-a')},
      {method: 'PUT', url: expect.stringContaining('/members/new/roles/role-a')},
    ]);
  });

  test('removes the role when the ladder has no leader', async () => {
    const calls = stubFetch([member('old', 'old', ['role-a'])]);
    const ok = await applyLeaders('token', CONFIG,
      delivery([{ladder: 'a', bot: null, owner: null}]));
    expect(ok).toBe(true);
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
    expect(calls.some(call => call.method === 'PUT')).toBe(false);
  });

  test('removes the role when the owner does not share their account', async () => {
    const calls = stubFetch([member('old', 'old', ['role-a'])]);
    const ok = await applyLeaders('token', CONFIG,
      delivery([{ladder: 'a', bot: {id: 'b1', name: 'Bot'}, owner: null}]));
    expect(ok).toBe(true);
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
    expect(calls.some(call => call.method === 'PUT')).toBe(false);
  });

  test('gives the role to an override, matched case-insensitively by username', async () => {
    const calls = stubFetch([member('111', 'NessieDev')]);
    const config = {...CONFIG, bots: {b1: 'nessiedev'}};
    const ok = await applyLeaders('token', config,
      delivery([{ladder: 'a', bot: {id: 'b1', name: 'Bot'}, owner: {discordId: '999'}}]));
    expect(ok).toBe(true);
    expect(calls).toContainEqual({
      method: 'PUT',
      url: expect.stringContaining('/members/111/roles/role-a'),
    });
  });

  test('ignores an unconfigured ladder', async () => {
    const calls = stubFetch([member('old', 'old', ['role-a'])]);
    const ok = await applyLeaders('token', CONFIG,
      delivery([{ladder: 'nope', bot: null, owner: {discordId: 'old'}}]));
    expect(ok).toBe(true);
    expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
  });

  test('a failing ladder does not stop the next one', async () => {
    const members = [member('old', 'old', ['role-a']), member('new', 'new')];
    const calls = stubFetch(members,
      call => call.method === 'DELETE' && call.url.includes('role-a'));
    const ok = await applyLeaders('token', CONFIG, delivery([
      {ladder: 'a', bot: null, owner: {discordId: 'new'}},
      {ladder: 'b', bot: null, owner: {discordId: 'new'}},
    ]));
    expect(ok).toBe(false);
    expect(calls).toContainEqual({
      method: 'PUT',
      url: expect.stringContaining('/members/new/roles/role-b'),
    });
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
  const first = delivery([{ladder: 'a', bot: null, owner: null}]);
  const second = delivery([{ladder: 'b', bot: null, owner: null}]);

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('applies an offered delivery once', async () => {
    const apply = vi.fn<(value: Delivery) => Promise<boolean>>().mockResolvedValue(true);
    const queue = reconciler(apply, 60_000);
    queue.offer(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(apply.mock.calls).toEqual([[first]]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(apply.mock.calls).toEqual([[first]]);
    queue.stop();
  });

  test('retries a failed apply on every tick until it succeeds', async () => {
    const apply = vi.fn<(value: Delivery) => Promise<boolean>>()
      .mockResolvedValue(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const queue = reconciler(apply, 60_000);
    queue.offer(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(apply).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(apply).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(apply).toHaveBeenCalledTimes(3);
    queue.stop();
  });

  test('counts a throwing apply as a failure and retries it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const apply = vi.fn<(value: Delivery) => Promise<boolean>>()
      .mockResolvedValue(true)
      .mockRejectedValueOnce(new Error('boom'));
    const queue = reconciler(apply, 60_000);
    queue.offer(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(apply.mock.calls).toEqual([[first]]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(apply.mock.calls).toEqual([[first], [first]]);
    error.mockRestore();
    queue.stop();
  });

  test('a newer delivery replaces a failed one, which is never applied again', async () => {
    const apply = vi.fn<(value: Delivery) => Promise<boolean>>()
      .mockResolvedValue(true)
      .mockResolvedValueOnce(false);
    const queue = reconciler(apply, 60_000);
    queue.offer(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(apply.mock.calls).toEqual([[first]]);
    queue.offer(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(apply.mock.calls).toEqual([[first], [second]]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(apply.mock.calls).toEqual([[first], [second]]);
    queue.stop();
  });

  test('a delivery offered while applying runs right after, never at the same time', async () => {
    const inFlight = deferred();
    const apply = vi.fn<(value: Delivery) => Promise<boolean>>()
      .mockResolvedValue(true)
      .mockImplementationOnce(() => inFlight.promise);
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

  test('applies nothing after stop', async () => {
    const apply = vi.fn<(value: Delivery) => Promise<boolean>>().mockResolvedValue(false);
    const queue = reconciler(apply, 60_000);
    queue.offer(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).toHaveBeenCalledTimes(1);
    queue.stop();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
