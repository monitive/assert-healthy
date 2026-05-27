# assert-healthy

A GitHub Action that asserts one or more [uptimemonitoring.com](https://uptimemonitoring.com) monitors are healthy. Drop it into a workflow to gate a deploy, a canary, or any pipeline step on real-world reachability.

```yaml
- uses: uptimemonitoring/assert-healthy@v2
  with:
    api-key: ${{ secrets.UPTIMEMONITORING_API_KEY }}
    monitor-ids: ${{ vars.MONITOR_ID }}
```

If the monitor is healthy, the step exits 0. If it is `down`, the step exits 1 and prints the last evidence (region, HTTP status, error). For multiple monitors, it evaluates each one and fails if any is unhealthy.

## How it works

For each monitor ID in the input list the action calls `POST /api/v1/monitors/{id}/test`, which triggers an immediate out-of-band probe through the same checker pipeline used for scheduled checks. The response `state` (`up` or `down`) drives the verdict — no stale data.

**Upstream 10 s per-monitor cooldown.** The `/test` endpoint enforces a 10-second cooldown per monitor. Concurrent CI runs against the same monitor (e.g., a matrix workflow with many jobs) will hit 429 on the second run. The action retries up to 3 times (honouring `Retry-After`), then falls back to the cached `GET` state with a warning so the step is not blocked indefinitely.

**Fallback chain.** The action falls through to the cached `GET /monitors/{id}` path and emits a `(fallback)` warning when:
- The `/test` endpoint returns 429 after 3 retries.
- The upstream returns a 5xx after one retry.
- The monitor type is not yet supported by `/test` (e.g., TCP/ping monitors).
- A transport or protocol error occurs on the `/test` call.

## Inputs

| Name                          | Required | Default | Description                                                                                                       |
| ----------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `api-key`                     | yes      | —       | An `umk_live_…` or `umk_test_…` API key. Pass it via a secret. The action calls `core.setSecret` to scrub it from logs. |
| `monitor-ids`                 | yes      | —       | One or more monitor IDs, comma- or newline-separated. Whitespace is ignored. Duplicates are de-duped.            |
| `strict-flapping`             | no       | `true`  | When `true`, a monitor in `flapping` state fails the step. Set to `false` to treat `flapping` as healthy.        |
| `unknown-retry-delay-seconds` | no       | `10`    | Brand-new or just-restarted monitors can sit in `unknown` for a few seconds. The action retries once after this delay on the cached-state fallback path; if still `unknown`, it fails. Max 600. |

## Outputs

| Name              | Description                                                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unhealthy-count` | Number of monitors that were unhealthy (any reason).                                                                                                                                                       |
| `unhealthy-ids`   | Comma-separated IDs of unhealthy monitors. Empty on full success. Includes monitors that failed for any reason — down, flapping, HTTP error, transport error.                                              |
| `down-ids`        | Comma-separated IDs of monitors with a confirmed `down` verdict. A subset of `unhealthy-ids` that excludes API errors. Use this when you need to distinguish "really down" from "can't tell". |

## Status mapping

| Monitor status | Default behavior          | With `strict-flapping: false` |
| -------------- | ------------------------- | ----------------------------- |
| `up`           | pass                      | pass                          |
| `down`         | fail                      | fail                          |
| `flapping`     | fail                      | pass                          |
| `unknown`      | retry once, then fail     | retry once, then fail         |

## Exit codes

| Code | Meaning                                                                     |
| ---- | --------------------------------------------------------------------------- |
| 0    | All monitors healthy.                                                       |
| 1    | At least one monitor is unhealthy (the normal "deploy is bad" signal).      |
| 2    | Input error — missing or malformed `api-key` / `monitor-ids` / etc. Also set when every monitor's `/test` call returns 401/403/404 (auth or configuration error). |
| 3    | Every monitor was unreachable — transport error on both `/test` and the cached-state fallback `GET`. The action could not get a verdict and is intentionally distinguishable from a down monitor. |
| 4    | Kill switch active upstream (operator-initiated dispatch pause). Retry after the upstream window passes (default 60s). |

## Multi-monitor

```yaml
- uses: uptimemonitoring/assert-healthy@v2
  with:
    api-key: ${{ secrets.UPTIMEMONITORING_API_KEY }}
    monitor-ids: |
      111
      222
      333
```

Each monitor is checked independently. The step fails if any is unhealthy and lists the offenders in `unhealthy-ids`. A GitHub Step Summary table is rendered with one row per monitor.

## Pinning

| Pattern    | Behavior                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| `@v2`      | Auto-picks the latest 2.x.y release. Recommended for most workflows.      |
| `@v2.0.0`  | Frozen — never auto-upgrades. Use this when you need byte-stable behavior. |
| `@v1`      | Stays on the v1 cached-state behavior. Use if you are not ready to migrate. |
| `@master`  | Bleeding edge. Not recommended.                                           |

When 2.x.y ships, the moving `v2` ref is force-updated to point at the new tag.

## Migration from `@v1`

The only breaking change is the default probe path: v2 calls `POST /test` first (force-fresh) instead of going straight to `GET /monitors/{id}` (cached state). The action inputs and outputs are identical; no workflow changes are required beyond updating the ref.

If you want to keep v1 cached-only behaviour, pin to `@v1` — that ref is not moved by v2 releases.

## Behavior on errors

- **HTTP 4xx (auth/permission/not-found) from `/test`** — fails the step immediately with exit 2 (auth/config class). No cached-state fallback is attempted — the error is definitive.
- **HTTP 5xx from `/test`** — retried once before falling back to the cached `GET` path with a warning.
- **Non-HTTP monitor** — `/test` is HTTP-only today; the action falls through to the cached state for these monitors with a warning. Verdict comes from the last scheduled probe.
- **Transport errors (DNS, TLS, reset, timeout) on `/test`** — falls back to cached `GET` with a warning. If a transport error then occurs on the cached `GET` too, the step fails (exit 3 if every monitor failed this way, otherwise exit 1).
- **Protocol errors (HTTP 200 but invalid JSON, missing fields, or an unknown `state`) on `/test`** — falls back to cached `GET` with a warning. If a protocol error then occurs on the cached `GET`, the step fails with exit 1.
- **Retry on `unknown` whose retry fetch fails** — keeps the first `unknown` reading and treats the run as `unhealthy` after retry (exit 1).

## Privacy

The action only contacts `https://api.uptimemonitoring.com`. It does not phone home, collect telemetry, or write outside the runner.

## License

MIT — see [LICENSE](LICENSE).
