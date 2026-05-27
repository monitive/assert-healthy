import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeStepSummary } from '../src/summary.js';
import type { MonitorOutcome } from '../src/main.js';

let summaryFile: string;

const sampleOutcomes: MonitorOutcome[] = [
  {
    id: 111,
    observedStatus: 'up',
    outcome: { kind: 'healthy', reason: 'up' },
    lastCheckAt: '2026-05-10T20:00:00Z',
    region: 'EU',
    detail: 'EU · HTTP 200 · 142ms',
  },
  {
    id: 222,
    observedStatus: 'down',
    outcome: { kind: 'unhealthy', reason: 'down' },
    lastCheckAt: '2026-05-10T19:59:55Z',
    region: 'EU',
    detail: 'EU · HTTP 503 · connection refused',
  },
];

describe('writeStepSummary', () => {
  beforeAll(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assert-healthy-summary-'));
    summaryFile = path.join(dir, 'summary.md');
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
  });

  beforeEach(async () => {
    await fs.writeFile(summaryFile, '');
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    core.summary.emptyBuffer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a table with one row per outcome', async () => {
    await writeStepSummary(sampleOutcomes);
    const content = await fs.readFile(summaryFile, 'utf8');
    expect(content).toContain('assert-healthy');
    expect(content).toContain('111');
    expect(content).toContain('222');
    expect(content).toContain('up');
    expect(content).toContain('down');
  });

  it('is a no-op when GITHUB_STEP_SUMMARY is unset', async () => {
    delete process.env.GITHUB_STEP_SUMMARY;
    const writeSpy = vi.spyOn(core.summary, 'write');
    await writeStepSummary(sampleOutcomes);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('escapes raw HTML in detail (CDN/proxy error pages do not break the table)', async () => {
    await writeStepSummary([
      {
        id: 7,
        observedStatus: 'down',
        outcome: { kind: 'unhealthy', reason: 'http_error' },
        lastCheckAt: null,
        region: null,
        detail: '<html><body>502 Bad Gateway</body></html>',
      },
    ]);
    const content = await fs.readFile(summaryFile, 'utf8');
    expect(content).toContain('&lt;html&gt;');
    expect(content).toContain('&lt;body&gt;');
    expect(content).not.toContain('<html>');
    expect(content).not.toContain('<body>');
  });

  it('truncates very long detail strings', async () => {
    const long = 'x'.repeat(500);
    await writeStepSummary([
      {
        id: 1,
        observedStatus: 'down',
        outcome: { kind: 'unhealthy', reason: 'down' },
        lastCheckAt: null,
        region: null,
        detail: long,
      },
    ]);
    const content = await fs.readFile(summaryFile, 'utf8');
    expect(content).toContain('xxxx');
    expect(content).not.toContain('x'.repeat(200));
  });

  it('(fallback) prefix in detail is rendered verbatim (HTML-escaped along with rest of cell)', async () => {
    await writeStepSummary([
      {
        id: 42,
        observedStatus: 'up',
        outcome: { kind: 'healthy', reason: 'up' },
        lastCheckAt: null,
        region: null,
        detail: '(fallback) EU-W · HTTP 200',
      },
    ]);
    const content = await fs.readFile(summaryFile, 'utf8');
    expect(content).toContain('(fallback) EU-W');
    expect(content).toContain('HTTP 200');
  });
});
