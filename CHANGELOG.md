# Changelog

All notable changes to `assert-healthy` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.1 — Force-fresh probe by default

Shipped as a patch bump (not 2.0.0) because the action has no external consumers yet, so the default-behavior change can roll forward via the floating `@v1` tag without breaking anyone. Future contract changes after consumers adopt will follow semver strictly.

### Changed

- **Default behavior is now `POST /api/v1/monitors/{id}/test` first (force-fresh, single-region)** with automatic fallback to cached `GET /monitors/{id}` on upstream rate-limit, 5xx, unsupported monitor type, or transport/protocol error on the `/test` call. Each fallback is logged as a warning.

### Added

- New exit code `4` — kill switch active upstream (operator-initiated dispatch pause). Retry after the upstream window passes (default 60s).
- 429 with backoff retry loop: up to 3 retries with `Retry-After`-honoring sleep (`max(Retry-After × 1000, [1s, 3s, 5s])`).
- Warning log on every fallback to cached state so it is visible in step output.

## 1.0.0 — Initial release

### Added

- `assert-healthy` GitHub Action: assert one or more uptimemonitoring.com monitors are healthy.
- Inputs: `api-key`, `monitor-ids` (comma- or newline-separated), `strict-flapping` (default `true`), `unknown-retry-delay-seconds` (default `10`).
- Outputs: `unhealthy-count`, `unhealthy-ids`.
- Status mapping: `up` → pass, `down` → fail, `flapping` → fail (or pass with `strict-flapping: false`), `unknown` → retry once then fail.
- Distinct exit codes: `1` (unhealthy), `2` (input error), `3` (all transport errors).
- Step summary table with one row per monitor.
- CI: lint, typecheck, test (≥90% line coverage), build, and a `dist/`-in-sync guard.
- Weekly canary workflow that runs the action against a known-up and known-down monitor and files a labelled issue on mismatch.
- Release workflow that force-moves the major-version ref (`v1`) to the latest tagged release.
