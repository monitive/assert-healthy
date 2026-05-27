import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';
import { evaluateMonitor, run, EXIT_KILL_SWITCH } from '../src/main.js';
import type { Fetcher, FetchResult, MonitorDetail, TestResult } from '../src/client.js';
import type { MonitorStatus } from '../src/policy.js';

function detail(status: MonitorStatus, opts: Partial<MonitorDetail['state']> = {}): MonitorDetail {
  return {
    monitor: { id: 1, url: 'https://example.com', type: 'http' },
    state: {
      status,
      last_check_at: opts.last_check_at ?? '2026-05-10T20:00:00Z',
      primary_region: opts.primary_region ?? 'EU',
      evidence_buffer: opts.evidence_buffer ?? [],
    },
  };
}

function ok(d: MonitorDetail): FetchResult {
  return { kind: 'ok', detail: d };
}

// Default fetcher for legacy tests: testMonitor always returns unsupported so
// the fresh-probe path falls through to the existing cached-GET logic.
function makeFetcher(responses: Record<number, FetchResult[]>): {
  fetcher: Fetcher;
  calls: number[];
} {
  const cursor: Record<number, number> = {};
  const calls: number[] = [];
  const fetcher: Fetcher = {
    async getMonitor(id: number): Promise<FetchResult> {
      calls.push(id);
      const list = responses[id];
      if (!list || list.length === 0) {
        throw new Error(`no mock response set up for monitor ${id}`);
      }
      const idx = cursor[id] ?? 0;
      const r = list[Math.min(idx, list.length - 1)];
      cursor[id] = idx + 1;
      return r;
    },
    async testMonitor(_id: number): Promise<TestResult> {
      return { kind: 'unsupported', message: '' };
    },
  };
  return { fetcher, calls };
}

function makeFetcherWithTest(config: {
  test: Record<number, TestResult[]>;
  get: Record<number, FetchResult[]>;
}): {
  fetcher: Fetcher;
  testCalls: number[];
  getCalls: number[];
} {
  const testCursor: Record<number, number> = {};
  const getCursor: Record<number, number> = {};
  const testCalls: number[] = [];
  const getCalls: number[] = [];
  const fetcher: Fetcher = {
    async getMonitor(id: number): Promise<FetchResult> {
      getCalls.push(id);
      const list = config.get[id];
      if (!list || list.length === 0) {
        throw new Error(`no GET mock for monitor ${id}`);
      }
      const idx = getCursor[id] ?? 0;
      const r = list[Math.min(idx, list.length - 1)];
      getCursor[id] = idx + 1;
      return r;
    },
    async testMonitor(id: number): Promise<TestResult> {
      testCalls.push(id);
      const list = config.test[id];
      if (!list || list.length === 0) {
        throw new Error(`no POST/test mock for monitor ${id}`);
      }
      const idx = testCursor[id] ?? 0;
      const r = list[Math.min(idx, list.length - 1)];
      testCursor[id] = idx + 1;
      return r;
    },
  };
  return { fetcher, testCalls, getCalls };
}

// ─── Legacy cached-GET path (via unsupported shim) ───────────────────────────

describe('evaluateMonitor', () => {
  it('up → healthy, no retry', async () => {
    const { fetcher, calls } = makeFetcher({ 1: [ok(detail('up'))] });
    const out = await evaluateMonitor(
      1,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 10_000 },
    );
    expect(out.outcome.kind).toBe('healthy');
    expect(calls).toEqual([1]);
  });

  it('down → unhealthy, no retry', async () => {
    const { fetcher } = makeFetcher({
      2: [
        ok(
          detail('down', {
            evidence_buffer: [
              {
                timestamp: 't',
                region: 'EU',
                status: 'down',
                http_status: 503,
                error: 'connection refused',
              },
            ],
          }),
        ),
      ],
    });
    const out = await evaluateMonitor(
      2,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 10_000 },
    );
    expect(out.outcome).toEqual({ kind: 'unhealthy', reason: 'down' });
    expect(out.detail).toContain('503');
  });

  it('flapping × strict=true → unhealthy', async () => {
    const { fetcher } = makeFetcher({ 3: [ok(detail('flapping'))] });
    const out = await evaluateMonitor(
      3,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 10_000 },
    );
    expect(out.outcome).toEqual({ kind: 'unhealthy', reason: 'flapping_strict' });
  });

  it('flapping × strict=false → healthy', async () => {
    const { fetcher } = makeFetcher({ 3: [ok(detail('flapping'))] });
    const out = await evaluateMonitor(
      3,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: false, unknownRetryDelayMs: 10_000 },
    );
    expect(out.outcome).toEqual({ kind: 'healthy', reason: 'flapping_lenient' });
  });

  it('unknown → retry then up = healthy', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { fetcher, calls } = makeFetcher({ 4: [ok(detail('unknown')), ok(detail('up'))] });
    const out = await evaluateMonitor(
      4,
      { fetcher, sleep },
      { strictFlapping: true, unknownRetryDelayMs: 1234 },
    );
    expect(out.outcome).toEqual({ kind: 'healthy', reason: 'up' });
    expect(calls).toEqual([4, 4]);
    expect(sleep).toHaveBeenCalledWith(1234);
  });

  it('unknown → retry still unknown = unhealthy', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { fetcher } = makeFetcher({ 5: [ok(detail('unknown')), ok(detail('unknown'))] });
    const out = await evaluateMonitor(
      5,
      { fetcher, sleep },
      { strictFlapping: true, unknownRetryDelayMs: 1 },
    );
    expect(out.outcome).toEqual({ kind: 'unhealthy', reason: 'unknown_after_retry' });
  });

  it('unknown with delay 0 skips sleep', async () => {
    const sleep = vi.fn();
    const { fetcher } = makeFetcher({ 6: [ok(detail('unknown')), ok(detail('up'))] });
    await evaluateMonitor(6, { fetcher, sleep }, { strictFlapping: true, unknownRetryDelayMs: 0 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('http_error → unhealthy/http_error with status in detail', async () => {
    const { fetcher } = makeFetcher({
      7: [{ kind: 'http_error', status: 401, body: '{"error":"unauthorized"}' }],
    });
    const out = await evaluateMonitor(
      7,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome).toEqual({ kind: 'unhealthy', reason: 'http_error' });
    expect(out.detail).toContain('401');
  });

  it('transport_error → unhealthy/transport_error', async () => {
    const { fetcher } = makeFetcher({
      8: [{ kind: 'transport_error', message: 'ECONNREFUSED' }],
    });
    const out = await evaluateMonitor(
      8,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome).toEqual({ kind: 'unhealthy', reason: 'transport_error' });
    expect(out.detail).toContain('ECONNREFUSED');
  });

  it('protocol_error → unhealthy/protocol_error', async () => {
    const { fetcher } = makeFetcher({
      9: [{ kind: 'protocol_error', message: 'invalid JSON: unexpected token <' }],
    });
    const out = await evaluateMonitor(
      9,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome).toEqual({ kind: 'unhealthy', reason: 'protocol_error' });
    expect(out.detail).toContain('invalid JSON');
  });

  it('first unknown + retry transport-fails → unhealthy_after_retry (preserves first verdict)', async () => {
    const { fetcher } = makeFetcher({
      10: [ok(detail('unknown')), { kind: 'transport_error', message: 'ECONNRESET' }],
    });
    const out = await evaluateMonitor(
      10,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome).toEqual({ kind: 'unhealthy', reason: 'unknown_after_retry' });
    // Region/last-check should come from the first reading we DID get.
    expect(out.region).toBe('EU');
    expect(out.lastCheckAt).toBe('2026-05-10T20:00:00Z');
  });
});

// ─── Force-fresh /test path ───────────────────────────────────────────────────

describe('evaluateMonitor (force-fresh /test)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(core, 'info').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(core, 'warning').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('state:up → healthy/up, no GET call made', async () => {
    const { fetcher, testCalls, getCalls } = makeFetcherWithTest({
      test: {
        1: [
          { kind: 'ok', probe: { state: 'up', region: 'EU-W', statusCode: 200, errorText: null } },
        ],
      },
      get: {},
    });
    const out = await evaluateMonitor(
      1,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome).toEqual({ kind: 'healthy', reason: 'up' });
    expect(testCalls).toEqual([1]);
    expect(getCalls).toEqual([]);
  });

  it('state:down → unhealthy/down, no GET call, detail has region and HTTP status', async () => {
    const { fetcher, getCalls } = makeFetcherWithTest({
      test: {
        1: [
          {
            kind: 'ok',
            probe: { state: 'down', region: 'EU-W', statusCode: 503, errorText: 'timeout' },
          },
        ],
      },
      get: {},
    });
    const out = await evaluateMonitor(
      1,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome).toEqual({ kind: 'unhealthy', reason: 'down' });
    expect(getCalls).toEqual([]);
    expect(out.detail).toContain('EU-W');
    expect(out.detail).toContain('503');
  });

  it('fresh state:up populates region from probe response', async () => {
    const { fetcher } = makeFetcherWithTest({
      test: {
        1: [
          { kind: 'ok', probe: { state: 'up', region: 'US-E', statusCode: null, errorText: null } },
        ],
      },
      get: {},
    });
    const out = await evaluateMonitor(
      1,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.region).toBe('US-E');
    expect(out.lastCheckAt).toBeNull();
  });

  it('429 × 2 then ok(up) → success after 2 retries, sleep called with max(retryAfter, backoff)', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { fetcher } = makeFetcherWithTest({
      test: {
        1: [
          { kind: 'rate_limited', retryAfterSec: 7, source: 'monitor' },
          { kind: 'rate_limited', retryAfterSec: 7, source: 'monitor' },
          { kind: 'ok', probe: { state: 'up', region: null, statusCode: null, errorText: null } },
        ],
      },
      get: {},
    });
    const out = await evaluateMonitor(
      1,
      { fetcher, sleep },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome.kind).toBe('healthy');
    // First retry: max(7000, 1000) = 7000; second retry: max(7000, 3000) = 7000
    expect(sleep).toHaveBeenNthCalledWith(1, 7000);
    expect(sleep).toHaveBeenNthCalledWith(2, 7000);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('429 × 4 → falls through to cached GET, detail prefixed with (fallback)', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const rl: TestResult = { kind: 'rate_limited', retryAfterSec: 3, source: 'monitor' };
    const { fetcher } = makeFetcherWithTest({
      test: { 1: [rl, rl, rl, rl] },
      get: { 1: [ok(detail('up'))] },
    });
    const out = await evaluateMonitor(
      1,
      { fetcher, sleep },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome.kind).toBe('healthy');
    expect(out.detail).toMatch(/^\(fallback\)/);
    // 3 sleeps for the 3 retries (4th hits the limit and returns null)
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('rate-limited after 3 retries'));
  });

  it('429 × 4 then cached GET returns down → unhealthy/down via fallback', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const rl: TestResult = { kind: 'rate_limited', retryAfterSec: 0, source: 'monitor' };
    const { fetcher } = makeFetcherWithTest({
      test: { 1: [rl, rl, rl, rl] },
      get: { 1: [ok(detail('down'))] },
    });
    const out = await evaluateMonitor(
      1,
      { fetcher, sleep },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome).toEqual({ kind: 'unhealthy', reason: 'down' });
    expect(out.detail).toMatch(/^\(fallback\)/);
  });

  it('400 unsupported → fallback, warning logged, cached GET up → healthy', async () => {
    const { fetcher } = makeFetcherWithTest({
      test: { 1: [{ kind: 'unsupported', message: "monitor type 'tcp' is not yet supported" }] },
      get: { 1: [ok(detail('up'))] },
    });
    const out = await evaluateMonitor(
      1,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome.kind).toBe('healthy');
    expect(out.detail).toMatch(/^\(fallback\)/);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('falling back to cached state'));
  });

  it('500 → retry once at 2s, then fallback to cached GET', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { fetcher } = makeFetcherWithTest({
      test: {
        1: [
          { kind: 'http_error', status: 500, body: '{"error":"server error"}' },
          { kind: 'http_error', status: 500, body: '{"error":"server error"}' },
        ],
      },
      get: { 1: [ok(detail('up'))] },
    });
    const out = await evaluateMonitor(
      1,
      { fetcher, sleep },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome.kind).toBe('healthy');
    expect(out.detail).toMatch(/^\(fallback\)/);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('5xx after retry'));
  });

  it('401 from /test → auth_error outcome, no GET fallback', async () => {
    const { fetcher, getCalls } = makeFetcherWithTest({
      test: { 1: [{ kind: 'http_error', status: 401, body: '{"error":"unauthorized"}' }] },
      get: {},
    });
    const out = await evaluateMonitor(
      1,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome).toEqual({ kind: 'unhealthy', reason: 'auth_error' });
    expect(getCalls).toEqual([]);
    expect(out.detail).toContain('401');
  });

  it('404 from /test → auth_error outcome, no GET fallback', async () => {
    const { fetcher, getCalls } = makeFetcherWithTest({
      test: { 1: [{ kind: 'http_error', status: 404, body: '{"error":"not found"}' }] },
      get: {},
    });
    const out = await evaluateMonitor(
      1,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome).toEqual({ kind: 'unhealthy', reason: 'auth_error' });
    expect(getCalls).toEqual([]);
  });

  it('transport_error from /test → fallback to cached GET (backwards-compat)', async () => {
    const { fetcher, getCalls } = makeFetcherWithTest({
      test: { 1: [{ kind: 'transport_error', message: 'ECONNREFUSED' }] },
      get: { 1: [ok(detail('up'))] },
    });
    const out = await evaluateMonitor(
      1,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome.kind).toBe('healthy');
    expect(getCalls).toEqual([1]);
    expect(out.detail).toMatch(/^\(fallback\)/);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('transport error'));
  });

  it('protocol_error from /test → fallback to cached GET', async () => {
    const { fetcher, getCalls } = makeFetcherWithTest({
      test: { 1: [{ kind: 'protocol_error', message: 'unexpected state: paused' }] },
      get: { 1: [ok(detail('up'))] },
    });
    const out = await evaluateMonitor(
      1,
      { fetcher, sleep: vi.fn() },
      { strictFlapping: true, unknownRetryDelayMs: 0 },
    );
    expect(out.outcome.kind).toBe('healthy');
    expect(getCalls).toEqual([1]);
    expect(out.detail).toMatch(/^\(fallback\)/);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('protocol error'));
  });
});

// ─── run() ───────────────────────────────────────────────────────────────────

describe('run (multi-monitor fan-out)', () => {
  const apiKey = 'umk_test_abcdef0123456789';
  let originalEnv: NodeJS.ProcessEnv;
  let setFailed: ReturnType<typeof vi.spyOn>;
  let setOutput: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.GITHUB_STEP_SUMMARY = '';
    process.env['INPUT_API-KEY'] = apiKey;
    process.exitCode = 0;
    setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => undefined);
    setOutput = vi.spyOn(core, 'setOutput').mockImplementation(() => undefined);
    vi.spyOn(core, 'info').mockImplementation(() => undefined);
    vi.spyOn(core, 'error').mockImplementation(() => undefined);
    vi.spyOn(core, 'warning').mockImplementation(() => undefined);
    vi.spyOn(core, 'setSecret').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it('all healthy → no failure, exit 0, outputs zeroed', async () => {
    process.env['INPUT_MONITOR-IDS'] = '111,222';
    process.env['INPUT_STRICT-FLAPPING'] = 'true';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    const { fetcher } = makeFetcher({
      111: [ok(detail('up'))],
      222: [ok(detail('up'))],
    });
    await run({ fetcher, sleep: vi.fn() });
    expect(setFailed).not.toHaveBeenCalled();
    expect(setOutput).toHaveBeenCalledWith('unhealthy-count', '0');
    expect(setOutput).toHaveBeenCalledWith('unhealthy-ids', '');
    expect(setOutput).toHaveBeenCalledWith('down-ids', '');
    expect(process.exitCode).toBe(0);
  });

  it('down-ids includes only confirmed-down monitors, excludes http_error', async () => {
    process.env['INPUT_MONITOR-IDS'] = '1,2,3';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    const { fetcher } = makeFetcher({
      1: [ok(detail('down'))], // real down
      2: [{ kind: 'http_error', status: 401, body: '{"error":"x"}' }], // API error
      3: [ok(detail('up'))], // healthy
    });
    await run({ fetcher, sleep: vi.fn() });
    expect(setOutput).toHaveBeenCalledWith('unhealthy-count', '2');
    expect(setOutput).toHaveBeenCalledWith('unhealthy-ids', '1,2');
    expect(setOutput).toHaveBeenCalledWith('down-ids', '1');
  });

  it('one down out of two → failure with ID list', async () => {
    process.env['INPUT_MONITOR-IDS'] = '111\n222';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    const { fetcher } = makeFetcher({
      111: [ok(detail('up'))],
      222: [ok(detail('down'))],
    });
    await run({ fetcher, sleep: vi.fn() });
    expect(setOutput).toHaveBeenCalledWith('unhealthy-count', '1');
    expect(setOutput).toHaveBeenCalledWith('unhealthy-ids', '222');
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('1 of 2 monitors unhealthy'));
  });

  it('all down → failure', async () => {
    process.env['INPUT_MONITOR-IDS'] = '1,2';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    const { fetcher } = makeFetcher({
      1: [ok(detail('down'))],
      2: [ok(detail('down'))],
    });
    await run({ fetcher, sleep: vi.fn() });
    expect(setOutput).toHaveBeenCalledWith('unhealthy-count', '2');
    expect(setOutput).toHaveBeenCalledWith('unhealthy-ids', '1,2');
    expect(process.exitCode).not.toBe(3);
  });

  it('all protocol_errors do NOT collapse to exit 3 (server was reachable)', async () => {
    process.env['INPUT_MONITOR-IDS'] = '1,2';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    const { fetcher } = makeFetcher({
      1: [{ kind: 'protocol_error', message: 'invalid JSON' }],
      2: [{ kind: 'protocol_error', message: 'response missing state.status' }],
    });
    await run({ fetcher, sleep: vi.fn() });
    // Reachable but unusable — exit 1, not 3.
    expect(process.exitCode).not.toBe(3);
  });

  it('all transport errors → exit code 3', async () => {
    process.env['INPUT_MONITOR-IDS'] = '1,2';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    const { fetcher } = makeFetcher({
      1: [{ kind: 'transport_error', message: 'ECONNRESET' }],
      2: [{ kind: 'transport_error', message: 'ETIMEDOUT' }],
    });
    await run({ fetcher, sleep: vi.fn() });
    expect(process.exitCode).toBe(3);
  });

  it('one healthy + one transport error does NOT collapse to exit 3', async () => {
    process.env['INPUT_MONITOR-IDS'] = '1,2';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    const { fetcher } = makeFetcher({
      1: [ok(detail('up'))],
      2: [{ kind: 'transport_error', message: 'ECONNRESET' }],
    });
    await run({ fetcher, sleep: vi.fn() });
    // We got a verdict for monitor 1 (healthy), so the run is "regular unhealthy".
    expect(process.exitCode).not.toBe(3);
    expect(setOutput).toHaveBeenCalledWith('unhealthy-count', '1');
    expect(setOutput).toHaveBeenCalledWith('unhealthy-ids', '2');
  });

  it('invalid api-key → exit code 2', async () => {
    process.env['INPUT_API-KEY'] = 'not-a-key';
    process.env['INPUT_MONITOR-IDS'] = '1';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    await run();
    expect(process.exitCode).toBe(2);
    expect(setFailed).toHaveBeenCalled();
    const failArg = String(setFailed.mock.calls[0]?.[0] ?? '');
    expect(failArg).not.toContain('not-a-key');
  });

  it('error message does not echo the api key', async () => {
    process.env['INPUT_MONITOR-IDS'] = ''; // empty → triggers InputError
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    await run();
    for (const call of setFailed.mock.calls) {
      expect(String(call[0])).not.toContain(apiKey);
    }
  });

  it('401 from /test for all monitors → exit code 2 (auth/config error)', async () => {
    process.env['INPUT_MONITOR-IDS'] = '1';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    const { fetcher } = makeFetcherWithTest({
      test: { 1: [{ kind: 'http_error', status: 401, body: '{"error":"unauthorized"}' }] },
      get: {},
    });
    await run({ fetcher, sleep: vi.fn() });
    expect(process.exitCode).toBe(2);
    expect(setFailed).toHaveBeenCalled();
  });

  it('kill-switch short-circuits loop: exit 4, all monitors in outputs, only first tested', async () => {
    process.env['INPUT_MONITOR-IDS'] = '1,2';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    const { fetcher, testCalls } = makeFetcherWithTest({
      test: {
        1: [{ kind: 'kill_switch', retryAfterSec: 60 }],
        2: [],
      },
      get: {},
    });
    await run({ fetcher, sleep: vi.fn() });
    expect(process.exitCode).toBe(EXIT_KILL_SWITCH);
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('kill switch'));
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('60'));
    expect(testCalls).toEqual([1]); // monitor 2 never reached
    expect(setOutput).toHaveBeenCalledWith('unhealthy-count', '2'); // both synthetic
    expect(setOutput).toHaveBeenCalledWith('unhealthy-ids', '1,2');
  });

  it('all monitors down via /test → correct down-ids and unhealthy-ids outputs', async () => {
    process.env['INPUT_MONITOR-IDS'] = '10,20';
    process.env['INPUT_UNKNOWN-RETRY-DELAY-SECONDS'] = '0';
    const { fetcher } = makeFetcherWithTest({
      test: {
        10: [
          { kind: 'ok', probe: { state: 'down', region: null, statusCode: null, errorText: null } },
        ],
        20: [
          { kind: 'ok', probe: { state: 'down', region: null, statusCode: null, errorText: null } },
        ],
      },
      get: {},
    });
    await run({ fetcher, sleep: vi.fn() });
    expect(setOutput).toHaveBeenCalledWith('unhealthy-count', '2');
    expect(setOutput).toHaveBeenCalledWith('unhealthy-ids', '10,20');
    expect(setOutput).toHaveBeenCalledWith('down-ids', '10,20');
    expect(setFailed).toHaveBeenCalled();
  });
});
