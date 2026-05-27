import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

function makeMockResponse(
  body: string,
  statusCode: number,
  headers: Record<string, string | string[]> = {},
) {
  return {
    message: { statusCode, headers },
    readBody: async (): Promise<string> => body,
  };
}

interface MockState {
  lastUrl: string | undefined;
  lastHeaders: Record<string, string> | undefined;
  lastAuthHeader: string | undefined;
  lastBody: string | undefined;
  getMock: ReturnType<typeof vi.fn>;
  postMock: ReturnType<typeof vi.fn>;
}

function setupMocks(state: MockState): void {
  vi.doMock('@actions/http-client', () => ({
    HttpClient: class {
      private handlers: Array<{
        prepareRequest?: (opts: { headers: Record<string, string> }) => void;
      }>;
      constructor(
        _ua: string,
        handlers: Array<{
          prepareRequest?: (opts: { headers: Record<string, string> }) => void;
        }>,
        _opts?: unknown,
      ) {
        this.handlers = handlers;
      }
      private captureAuth(): void {
        const opts = { headers: {} as Record<string, string> };
        for (const h of this.handlers ?? []) {
          h.prepareRequest?.(opts);
        }
        state.lastAuthHeader = opts.headers['Authorization'] ?? opts.headers['authorization'];
      }
      async get(url: string, headers: Record<string, string>): Promise<unknown> {
        state.lastUrl = url;
        state.lastHeaders = headers;
        state.lastBody = undefined;
        this.captureAuth();
        return state.getMock();
      }
      async post(url: string, body: string, headers: Record<string, string>): Promise<unknown> {
        state.lastUrl = url;
        state.lastHeaders = headers;
        state.lastBody = body;
        this.captureAuth();
        return state.postMock();
      }
    },
  }));
  vi.doMock('@actions/http-client/lib/auth.js', () => ({
    BearerCredentialHandler: class {
      token: string;
      constructor(token: string) {
        this.token = token;
      }
      prepareRequest(opts: { headers: Record<string, string> }): void {
        opts.headers['Authorization'] = `Bearer ${this.token}`;
      }
      canHandleAuthentication(): boolean {
        return false;
      }
      async handleAuthentication(): Promise<unknown> {
        throw new Error('not implemented');
      }
    },
  }));
}

describe('createFetcher.getMonitor', () => {
  let state: MockState;

  beforeEach(() => {
    state = {
      lastUrl: undefined,
      lastHeaders: undefined,
      lastAuthHeader: undefined,
      lastBody: undefined,
      getMock: vi.fn(),
      postMock: vi.fn(),
    };
    vi.resetModules();
    setupMocks(state);
  });

  afterEach(() => {
    vi.unmock('@actions/http-client');
    vi.unmock('@actions/http-client/lib/auth.js');
    vi.resetModules();
  });

  it('hits the canonical URL with bearer + user-agent', async () => {
    state.getMock.mockResolvedValue(
      makeMockResponse(
        JSON.stringify({
          monitor: { id: 42 },
          state: { status: 'up', last_check_at: 't', primary_region: 'EU' },
        }),
        200,
      ),
    );
    const { createFetcher, USER_AGENT } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.getMonitor(42);
    expect(result.kind).toBe('ok');
    expect(state.lastUrl).toBe('https://api.uptimemonitoring.com/api/v1/monitors/42');
    expect(state.lastHeaders?.['accept']).toBe('application/json');
    expect(state.lastHeaders?.['user-agent']).toBe(USER_AGENT);
    expect(state.lastAuthHeader).toBe('Bearer umk_live_X');
  });

  it('returns http_error on 4xx with body', async () => {
    state.getMock.mockResolvedValue(makeMockResponse('{"error":"unauthorized"}', 401));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result).toEqual({
      kind: 'http_error',
      status: 401,
      body: '{"error":"unauthorized"}',
    });
  });

  it('returns transport_error when get throws', async () => {
    state.getMock.mockRejectedValue(new Error('ECONNRESET'));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result).toEqual({ kind: 'transport_error', message: 'ECONNRESET' });
  });

  it('returns protocol_error on invalid JSON (server reachable, body unusable)', async () => {
    state.getMock.mockResolvedValue(makeMockResponse('not json', 200));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('protocol_error');
  });

  it('returns protocol_error when state.status missing', async () => {
    state.getMock.mockResolvedValue(makeMockResponse(JSON.stringify({ monitor: { id: 1 } }), 200));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('protocol_error');
  });

  it('returns protocol_error on unknown state.status (API schema drift)', async () => {
    state.getMock.mockResolvedValue(
      makeMockResponse(
        JSON.stringify({
          monitor: { id: 1 },
          state: { status: 'paused', last_check_at: null },
        }),
        200,
      ),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('protocol_error');
    if (result.kind === 'protocol_error') {
      expect(result.message).toContain('paused');
    }
  });

  it('returns protocol_error when evidence_buffer is not an array (schema drift)', async () => {
    state.getMock.mockResolvedValue(
      makeMockResponse(
        JSON.stringify({
          monitor: { id: 1 },
          state: { status: 'down', last_check_at: 't', evidence_buffer: {} },
        }),
        200,
      ),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('protocol_error');
    if (result.kind === 'protocol_error') {
      expect(result.message).toContain('evidence_buffer');
    }
  });

  it('returns protocol_error when last_check_at is not string or null', async () => {
    state.getMock.mockResolvedValue(
      makeMockResponse(
        JSON.stringify({
          monitor: { id: 1 },
          state: { status: 'up', last_check_at: 12345 },
        }),
        200,
      ),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('protocol_error');
    if (result.kind === 'protocol_error') {
      expect(result.message).toContain('last_check_at');
    }
  });

  it('returns protocol_error when primary_region is the wrong type', async () => {
    state.getMock.mockResolvedValue(
      makeMockResponse(
        JSON.stringify({
          monitor: { id: 1 },
          state: { status: 'up', last_check_at: null, primary_region: 42 },
        }),
        200,
      ),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('protocol_error');
    if (result.kind === 'protocol_error') {
      expect(result.message).toContain('primary_region');
    }
  });

  it('returns transport_error when readBody rejects mid-stream', async () => {
    state.getMock.mockResolvedValue({
      message: { statusCode: 200, headers: {} },
      readBody: () => Promise.reject(new Error('socket hang up')),
    });
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('transport_error');
    if (result.kind === 'transport_error') {
      expect(result.message).toContain('socket hang up');
    }
  });

  it('retries once on 500 (not just 502/503/504)', async () => {
    state.getMock
      .mockResolvedValueOnce(makeMockResponse('{"error":"boom"}', 500))
      .mockResolvedValueOnce(
        makeMockResponse(
          JSON.stringify({
            monitor: { id: 1 },
            state: { status: 'up', last_check_at: 't' },
          }),
          200,
        ),
      );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('ok');
    expect(state.getMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on transport error and surfaces the second result', async () => {
    state.getMock.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(
      makeMockResponse(
        JSON.stringify({
          monitor: { id: 1 },
          state: { status: 'up', last_check_at: 't' },
        }),
        200,
      ),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('ok');
    expect(state.getMock).toHaveBeenCalledTimes(2);
  });

  it('preserves first 5xx verdict when retry loses connectivity', async () => {
    state.getMock
      .mockResolvedValueOnce(makeMockResponse('{"error":"boom"}', 503))
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.getMonitor(1);
    expect(result).toEqual({
      kind: 'http_error',
      status: 503,
      body: '{"error":"boom"}',
    });
    expect(state.getMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 4xx', async () => {
    state.getMock.mockResolvedValue(makeMockResponse('{"error":"unauthorized"}', 401));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('http_error');
    expect(state.getMock).toHaveBeenCalledTimes(1);
  });

  it('with retryOn5xx=false does not retry 5xx', async () => {
    state.getMock.mockResolvedValue(makeMockResponse('boom', 503));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X', retryOn5xx: false });
    const result = await fetcher.getMonitor(1);
    expect(result.kind).toBe('http_error');
    expect(state.getMock).toHaveBeenCalledTimes(1);
  });

  it('strips trailing slashes from baseUrl', async () => {
    state.getMock.mockResolvedValue(
      makeMockResponse(
        JSON.stringify({
          monitor: { id: 1 },
          state: { status: 'up', last_check_at: null },
        }),
        200,
      ),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({
      apiKey: 'umk_live_X',
      baseUrl: 'https://example.test///',
      retryOn5xx: false,
    });
    await fetcher.getMonitor(1);
    expect(state.lastUrl).toBe('https://example.test/api/v1/monitors/1');
  });
});

describe('createFetcher.testMonitor', () => {
  let state: MockState;

  beforeEach(() => {
    state = {
      lastUrl: undefined,
      lastHeaders: undefined,
      lastAuthHeader: undefined,
      lastBody: undefined,
      getMock: vi.fn(),
      postMock: vi.fn(),
    };
    vi.resetModules();
    setupMocks(state);
  });

  afterEach(() => {
    vi.unmock('@actions/http-client');
    vi.unmock('@actions/http-client/lib/auth.js');
    vi.resetModules();
  });

  it('hits POST /api/v1/monitors/{id}/test with bearer + user-agent + empty body', async () => {
    state.postMock.mockResolvedValue(
      makeMockResponse(JSON.stringify({ state: 'up', region: 'EU-W' }), 200),
    );
    const { createFetcher, USER_AGENT } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(42);
    expect(result.kind).toBe('ok');
    expect(state.lastUrl).toBe('https://api.uptimemonitoring.com/api/v1/monitors/42/test');
    expect(state.lastBody).toBe('');
    expect(state.lastHeaders?.['accept']).toBe('application/json');
    expect(state.lastHeaders?.['user-agent']).toBe(USER_AGENT);
    expect(state.lastAuthHeader).toBe('Bearer umk_live_X');
  });

  it('200 with state:up and region → ok with probe.state and probe.region', async () => {
    state.postMock.mockResolvedValue(
      makeMockResponse(JSON.stringify({ state: 'up', region: 'EU-W' }), 200),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(1);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.probe.state).toBe('up');
      expect(result.probe.region).toBe('EU-W');
    }
  });

  it('200 with state:down, status_code, and error → ok with statusCode and errorText', async () => {
    state.postMock.mockResolvedValue(
      makeMockResponse(JSON.stringify({ state: 'down', status_code: 500, error: '5xx' }), 200),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(1);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.probe.state).toBe('down');
      expect(result.probe.statusCode).toBe(500);
      expect(result.probe.errorText).toBe('5xx');
    }
  });

  it('200 with invalid JSON → protocol_error', async () => {
    state.postMock.mockResolvedValue(makeMockResponse('not json', 200));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(1);
    expect(result.kind).toBe('protocol_error');
  });

  it('200 missing state field → protocol_error', async () => {
    state.postMock.mockResolvedValue(makeMockResponse(JSON.stringify({ region: 'EU' }), 200));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(1);
    expect(result.kind).toBe('protocol_error');
    if (result.kind === 'protocol_error') {
      expect(result.message).toContain('state');
    }
  });

  it('200 with unknown state value (e.g. paused) → protocol_error', async () => {
    state.postMock.mockResolvedValue(makeMockResponse(JSON.stringify({ state: 'paused' }), 200));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(1);
    expect(result.kind).toBe('protocol_error');
    if (result.kind === 'protocol_error') {
      expect(result.message).toContain('paused');
    }
  });

  it('429 with Retry-After and monitor-limiter body → rate_limited/monitor', async () => {
    state.postMock.mockResolvedValue(
      makeMockResponse('too many tests for this monitor; retry in 7s', 429, { 'retry-after': '7' }),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(1);
    expect(result.kind).toBe('rate_limited');
    if (result.kind === 'rate_limited') {
      expect(result.retryAfterSec).toBe(7);
      expect(result.source).toBe('monitor');
    }
  });

  it('429 with domain-limiter body → rate_limited/domain', async () => {
    state.postMock.mockResolvedValue(
      makeMockResponse('domain rate limit exceeded; retry in 3s', 429, { 'retry-after': '3' }),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(1);
    expect(result.kind).toBe('rate_limited');
    if (result.kind === 'rate_limited') {
      expect(result.source).toBe('domain');
    }
  });

  it('429 with no Retry-After header → retryAfterSec null, source unknown for unrecognised body', async () => {
    state.postMock.mockResolvedValue(
      makeMockResponse('account rate limit exceeded; retry in 5s', 429),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(1);
    expect(result.kind).toBe('rate_limited');
    if (result.kind === 'rate_limited') {
      expect(result.retryAfterSec).toBeNull();
      expect(result.source).toBe('unknown');
    }
  });

  it('503 with kill_switch_active body and Retry-After → kill_switch', async () => {
    state.postMock.mockResolvedValue(
      makeMockResponse('{"error":"kill_switch_active","retry_after":60}', 503, {
        'retry-after': '60',
      }),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(1);
    expect(result.kind).toBe('kill_switch');
    if (result.kind === 'kill_switch') {
      expect(result.retryAfterSec).toBe(60);
    }
  });

  it('500 with checker-error body → http_error (not kill_switch)', async () => {
    state.postMock.mockResolvedValue(
      makeMockResponse('{"error":"checker returned no result"}', 500),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(1);
    expect(result.kind).toBe('http_error');
    if (result.kind === 'http_error') {
      expect(result.status).toBe(500);
    }
  });

  it('400 with "not yet supported" body → unsupported', async () => {
    state.postMock.mockResolvedValue(
      makeMockResponse("monitor type 'tcp' is not yet supported by the test endpoint", 400),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(1);
    expect(result.kind).toBe('unsupported');
  });

  it('400 with unrecognised body → http_error (not silently unsupported)', async () => {
    state.postMock.mockResolvedValue(makeMockResponse('some other error', 400));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(1);
    expect(result.kind).toBe('http_error');
    if (result.kind === 'http_error') {
      expect(result.status).toBe(400);
    }
  });

  it.each([401, 403, 404, 500, 502])('%i → http_error with correct status', async (status) => {
    state.postMock.mockResolvedValue(makeMockResponse(`{"error":"err ${status}"}`, status));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(1);
    expect(result.kind).toBe('http_error');
    if (result.kind === 'http_error') {
      expect(result.status).toBe(status);
    }
  });

  it('transport error (post rejects) → transport_error', async () => {
    state.postMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(1);
    expect(result.kind).toBe('transport_error');
    if (result.kind === 'transport_error') {
      expect(result.message).toContain('ECONNREFUSED');
    }
  });

  it('429 with HTTP-date Retry-After → retryAfterSec computed from date', async () => {
    const fixedNow = new Date('2025-01-01T00:00:00.000Z').getTime();
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      state.postMock.mockResolvedValue(
        makeMockResponse('too many tests for this monitor; retry in 120s', 429, {
          'retry-after': 'Wed, 01 Jan 2025 00:02:00 GMT',
        }),
      );
      const { createFetcher } = await import('../src/client.js');
      const fetcher = createFetcher({ apiKey: 'umk_live_X' });
      const result = await fetcher.testMonitor(1);
      expect(result.kind).toBe('rate_limited');
      if (result.kind === 'rate_limited') {
        expect(result.retryAfterSec).toBe(120);
        expect(result.source).toBe('monitor');
      }
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('503 kill_switch with no Retry-After header but retry_after in body → kill_switch with body value', async () => {
    state.postMock.mockResolvedValue(
      makeMockResponse('{"error":"kill_switch_active","retry_after":45}', 503),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(1);
    expect(result.kind).toBe('kill_switch');
    if (result.kind === 'kill_switch') {
      expect(result.retryAfterSec).toBe(45);
    }
  });

  it('503 kill_switch with both Retry-After header and retry_after in body → header wins', async () => {
    state.postMock.mockResolvedValue(
      makeMockResponse('{"error":"kill_switch_active","retry_after":999}', 503, {
        'retry-after': '60',
      }),
    );
    const { createFetcher } = await import('../src/client.js');
    const fetcher = createFetcher({ apiKey: 'umk_live_X' });
    const result = await fetcher.testMonitor(1);
    expect(result.kind).toBe('kill_switch');
    if (result.kind === 'kill_switch') {
      expect(result.retryAfterSec).toBe(60);
    }
  });
});

describe('USER_AGENT', () => {
  it('is set to the action name', async () => {
    const { USER_AGENT } = await import('../src/client.js');
    expect(USER_AGENT).toBe('uptimemonitoring-assert-healthy');
  });
});
