import * as core from '@actions/core';
import { readInputs, InputError } from './inputs.js';
import {
  createFetcher,
  type Fetcher,
  type FetchResult,
  type MonitorDetail,
  type TestProbe,
} from './client.js';
import { decide, decideAfterRetry, type MonitorStatus, type PolicyOutcome } from './policy.js';
import { writeStepSummary } from './summary.js';

export const EXIT_INPUT = 2;
export const EXIT_TRANSPORT = 3;
export const EXIT_KILL_SWITCH = 4;

export interface MonitorOutcome {
  id: number;
  observedStatus: MonitorStatus | 'error';
  outcome:
    | PolicyOutcome
    | {
        kind: 'unhealthy';
        reason: 'http_error' | 'transport_error' | 'protocol_error' | 'auth_error';
      };
  lastCheckAt: string | null;
  region: string | null;
  detail: string;
}

export interface RunDeps {
  fetcher: Fetcher;
  sleep: (ms: number) => Promise<void>;
}

class KillSwitchError extends Error {
  retryAfterSec: number | null;
  constructor(retryAfterSec: number | null) {
    super('kill switch active');
    this.name = 'KillSwitchError';
    this.retryAfterSec = retryAfterSec;
  }
}

// Internal discriminated union for the single-shot result of one /test call.
type FreshProbeStep =
  | { tag: 'outcome'; outcome: MonitorOutcome }
  | { tag: 'fallback' }
  | { tag: 'rate_limited'; retryAfterSec: number | null; source: 'monitor' | 'domain' | 'unknown' }
  | { tag: 'server_error' };

async function freshProbe(
  id: number,
  deps: RunDeps,
  opts: { strictFlapping: boolean; unknownRetryDelayMs: number },
): Promise<FreshProbeStep> {
  const result = await deps.fetcher.testMonitor(id);

  switch (result.kind) {
    case 'ok': {
      const { probe } = result;
      const outcome = decide(probe.state, opts);
      return {
        tag: 'outcome',
        outcome: {
          id,
          observedStatus: probe.state,
          outcome,
          lastCheckAt: null,
          region: probe.region,
          detail: formatProbeEvidence(probe),
        },
      };
    }
    case 'rate_limited':
      return { tag: 'rate_limited', retryAfterSec: result.retryAfterSec, source: result.source };
    case 'kill_switch':
      throw new KillSwitchError(result.retryAfterSec);
    case 'unsupported':
      core.warning(
        `monitor ${id}: /test endpoint does not support this monitor type — falling back to cached state`,
      );
      return { tag: 'fallback' };
    case 'http_error': {
      const { status, body } = result;
      if (status === 401 || status === 403 || status === 404) {
        return {
          tag: 'outcome',
          outcome: {
            id,
            observedStatus: 'error',
            outcome: { kind: 'unhealthy', reason: 'auth_error' },
            lastCheckAt: null,
            region: null,
            detail: `HTTP ${status}: ${truncateBody(body)}`,
          },
        };
      }
      if (status >= 400 && status < 500) {
        // Any unexpected 4xx (not 401/403/404 and not the 400 "unsupported" handled
        // in client.ts) is a real client error — fail fatally, no cached fallback.
        return {
          tag: 'outcome',
          outcome: {
            id,
            observedStatus: 'error',
            outcome: { kind: 'unhealthy', reason: 'http_error' },
            lastCheckAt: null,
            region: null,
            detail: `HTTP ${status}: ${truncateBody(body)}`,
          },
        };
      }
      // 5xx: retry once, then fall through to cached GET.
      return { tag: 'server_error' };
    }
    case 'transport_error':
      core.warning(
        `monitor ${id}: /test transport error (${result.message}) — falling back to cached state`,
      );
      return { tag: 'fallback' };
    case 'protocol_error':
      core.warning(
        `monitor ${id}: /test protocol error (${result.message}) — falling back to cached state`,
      );
      return { tag: 'fallback' };
  }
}

async function freshProbeWithRetry(
  id: number,
  deps: RunDeps,
  opts: { strictFlapping: boolean; unknownRetryDelayMs: number },
): Promise<MonitorOutcome | null> {
  const MAX_429_RETRIES = 3;
  const BACKOFF_429_MS = [1000, 3000, 5000];
  const MAX_SLEEP_MS = 300_000;

  let attempts429 = 0;
  let attempts5xx = 0;

  for (;;) {
    core.info(`→ POST /api/v1/monitors/${id}/test`);
    const step = await freshProbe(id, deps, opts);

    if (step.tag === 'outcome') {
      return step.outcome;
    }

    if (step.tag === 'fallback') {
      return null;
    }

    if (step.tag === 'rate_limited') {
      core.info(`← 429 Too Many Requests, Retry-After: ${step.retryAfterSec ?? 'n/a'}`);
      if (attempts429 >= MAX_429_RETRIES) {
        core.warning(
          `force-fresh /test rate-limited after ${MAX_429_RETRIES} retries — falling back to cached state for monitor ${id}`,
        );
        return null;
      }
      const planned = BACKOFF_429_MS[attempts429] ?? BACKOFF_429_MS[BACKOFF_429_MS.length - 1];
      const sleepMs = Math.min(Math.max((step.retryAfterSec ?? 0) * 1000, planned), MAX_SLEEP_MS);
      core.info(`   retry ${attempts429 + 1}/${MAX_429_RETRIES} after ${sleepMs / 1000}s …`);
      await deps.sleep(sleepMs);
      attempts429++;
      continue;
    }

    if (step.tag === 'server_error') {
      if (attempts5xx >= 1) {
        core.warning(`monitor ${id}: /test 5xx after retry — falling back to cached state`);
        return null;
      }
      core.info(`monitor ${id}: /test 5xx, retrying after 2s`);
      await deps.sleep(2000);
      attempts5xx++;
      continue;
    }
  }
}

async function evaluateMonitorCached(
  id: number,
  deps: RunDeps,
  opts: { strictFlapping: boolean; unknownRetryDelayMs: number },
): Promise<MonitorOutcome> {
  const first = await deps.fetcher.getMonitor(id);
  if (first.kind !== 'ok') {
    return errorOutcome(id, first);
  }
  const initial = decide(first.detail.state.status, opts);
  if (initial.kind !== 'retry') {
    return outcomeFromDetail(id, first.detail, initial);
  }
  if (opts.unknownRetryDelayMs > 0) {
    await deps.sleep(opts.unknownRetryDelayMs);
  }
  const second = await deps.fetcher.getMonitor(id);
  if (second.kind !== 'ok') {
    // Retry didn't get a fresh verdict, but the first reading was a real
    // API verdict (unknown). Apply decideAfterRetry to that, so the run
    // exits as "unknown after retry" — exit 1, not exit 3.
    const final = decideAfterRetry(first.detail.state.status, opts);
    return outcomeFromDetail(id, first.detail, final);
  }
  const final = decideAfterRetry(second.detail.state.status, opts);
  return outcomeFromDetail(id, second.detail, final);
}

export async function evaluateMonitor(
  id: number,
  deps: RunDeps,
  opts: { strictFlapping: boolean; unknownRetryDelayMs: number },
): Promise<MonitorOutcome> {
  const fresh = await freshProbeWithRetry(id, deps, opts);
  if (fresh !== null) {
    return fresh;
  }
  const cached = await evaluateMonitorCached(id, deps, opts);
  return { ...cached, detail: `(fallback) ${cached.detail}` };
}

function outcomeFromDetail(
  id: number,
  detail: MonitorDetail,
  outcome: PolicyOutcome,
): MonitorOutcome {
  const lastEvidence = detail.state.evidence_buffer?.slice(-1)[0];
  const detailLine = lastEvidence ? formatEvidence(lastEvidence) : reasonHumanReadable(outcome);
  return {
    id,
    observedStatus: detail.state.status,
    outcome,
    lastCheckAt: detail.state.last_check_at,
    region: detail.state.primary_region ?? null,
    detail: detailLine,
  };
}

function errorOutcome(id: number, result: Exclude<FetchResult, { kind: 'ok' }>): MonitorOutcome {
  if (result.kind === 'http_error') {
    return {
      id,
      observedStatus: 'error',
      outcome: { kind: 'unhealthy', reason: 'http_error' },
      lastCheckAt: null,
      region: null,
      detail: `HTTP ${result.status}: ${truncateBody(result.body)}`,
    };
  }
  if (result.kind === 'protocol_error') {
    return {
      id,
      observedStatus: 'error',
      outcome: { kind: 'unhealthy', reason: 'protocol_error' },
      lastCheckAt: null,
      region: null,
      detail: result.message,
    };
  }
  return {
    id,
    observedStatus: 'error',
    outcome: { kind: 'unhealthy', reason: 'transport_error' },
    lastCheckAt: null,
    region: null,
    detail: result.message,
  };
}

function formatEvidence(
  ev: NonNullable<MonitorDetail['state']['evidence_buffer']>[number],
): string {
  const parts: string[] = [];
  if (ev.region) parts.push(ev.region);
  if (typeof ev.http_status === 'number') parts.push(`HTTP ${ev.http_status}`);
  if (typeof ev.latency_ms === 'number') parts.push(`${ev.latency_ms}ms`);
  if (ev.error) parts.push(ev.error);
  return parts.join(' · ');
}

function formatProbeEvidence(probe: TestProbe): string {
  const parts: string[] = [];
  if (probe.region) parts.push(probe.region);
  if (typeof probe.statusCode === 'number') parts.push(`HTTP ${probe.statusCode}`);
  if (probe.errorText) parts.push(probe.errorText);
  return parts.join(' · ');
}

function reasonHumanReadable(outcome: PolicyOutcome): string {
  if (outcome.kind === 'healthy') return outcome.reason === 'up' ? 'up' : 'flapping (lenient)';
  if (outcome.kind === 'unhealthy') {
    if (outcome.reason === 'down') return 'down';
    if (outcome.reason === 'flapping_strict') return 'flapping (strict)';
    return 'unknown after retry';
  }
  return 'pending retry';
}

function truncateBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= 200) return trimmed;
  return `${trimmed.slice(0, 199)}…`;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function run(depsOverride?: Partial<RunDeps>): Promise<void> {
  let inputs: ReturnType<typeof readInputs>;
  try {
    inputs = readInputs();
  } catch (err) {
    if (err instanceof InputError) {
      core.setFailed(err.message);
      process.exitCode = EXIT_INPUT;
      return;
    }
    throw err;
  }

  const fetcher = depsOverride?.fetcher ?? createFetcher({ apiKey: inputs.apiKey });
  const sleep = depsOverride?.sleep ?? defaultSleep;
  const deps: RunDeps = { fetcher, sleep };

  const outcomes: MonitorOutcome[] = [];

  try {
    for (const id of inputs.monitorIds) {
      core.info(`Evaluating monitor ${id}…`);
      const outcome = await evaluateMonitor(id, deps, {
        strictFlapping: inputs.strictFlapping,
        unknownRetryDelayMs: inputs.unknownRetryDelayMs,
      });
      outcomes.push(outcome);
      logOutcome(outcome);
    }
  } catch (err) {
    if (err instanceof KillSwitchError) {
      // Append synthetic outcomes for monitors not yet evaluated so the step
      // summary always has one row per input monitor.
      const evaluatedIds = new Set(outcomes.map((o) => o.id));
      for (const id of inputs.monitorIds) {
        if (!evaluatedIds.has(id)) {
          outcomes.push({
            id,
            observedStatus: 'error',
            outcome: { kind: 'unhealthy', reason: 'http_error' },
            lastCheckAt: null,
            region: null,
            detail: 'kill switch active',
          });
        }
      }
      const retryMsg = err.retryAfterSec != null ? `; retry after ${err.retryAfterSec}s` : '';
      core.setFailed(`kill switch active upstream${retryMsg}`);
      process.exitCode = EXIT_KILL_SWITCH;
      const ksUnhealthy = outcomes.filter((o) => o.outcome.kind === 'unhealthy');
      const ksDown = outcomes.filter((o) => {
        const { outcome } = o;
        return outcome.kind === 'unhealthy' && outcome.reason === 'down';
      });
      core.setOutput('unhealthy-count', String(ksUnhealthy.length));
      core.setOutput('unhealthy-ids', ksUnhealthy.map((o) => o.id).join(','));
      core.setOutput('down-ids', ksDown.map((o) => o.id).join(','));
      await writeStepSummary(outcomes);
      return;
    }
    throw err;
  }

  const unhealthy = outcomes.filter((o) => o.outcome.kind === 'unhealthy');
  const down = outcomes.filter((o) => {
    const { outcome } = o;
    return outcome.kind === 'unhealthy' && outcome.reason === 'down';
  });
  core.setOutput('unhealthy-count', String(unhealthy.length));
  core.setOutput('unhealthy-ids', unhealthy.map((o) => o.id).join(','));
  core.setOutput('down-ids', down.map((o) => o.id).join(','));

  await writeStepSummary(outcomes);

  if (unhealthy.length > 0) {
    const authOrConfigOnly = unhealthy.every((o) => {
      const { outcome } = o;
      return outcome.kind === 'unhealthy' && outcome.reason === 'auth_error';
    });
    const transportOnly = outcomes.every((o) => {
      const { outcome } = o;
      return outcome.kind === 'unhealthy' && outcome.reason === 'transport_error';
    });
    const summaryLine = `${unhealthy.length} of ${outcomes.length} monitor${outcomes.length === 1 ? '' : 's'} unhealthy.`;
    core.setFailed(summaryLine);
    if (authOrConfigOnly) {
      process.exitCode = EXIT_INPUT;
    } else if (transportOnly) {
      process.exitCode = EXIT_TRANSPORT;
    }
    return;
  }

  core.info(`All ${outcomes.length} monitor${outcomes.length === 1 ? '' : 's'} healthy.`);
}

function logOutcome(o: MonitorOutcome): void {
  const detail = o.detail ? ` — ${o.detail}` : '';
  const lastSeen = o.lastCheckAt ? ` (last check ${o.lastCheckAt})` : '';
  if (o.outcome.kind === 'healthy') {
    core.info(`PASS monitor ${o.id} — ${o.observedStatus}${lastSeen}${detail}`);
    return;
  }
  core.error(`FAIL monitor ${o.id} — ${o.observedStatus}${lastSeen}${detail}`);
}
