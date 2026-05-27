# Changelog

All notable changes to `assert-healthy` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 2.0.0 — Force-fresh probe by default

### Changed

- **Default behavior is now `POST /api/v1/monitors/{id}/test` first (force-fresh, single-region)** with automatic fallback to cached `GET /monitors/{id}` on upstream rate-limit, 5xx, or unsupported monitor type. v1 callers who want the old cached-only semantics can stay on `@v1`.

### Added

- New exit code `4` — kill switch active upstream (operator-initiated dispatch pause). Retry after the upstream window passes (default 60s).
- 429 with backoff retry loop: up to 3 retries with `Retry-After`-honoring sleep (`max(Retry-After × 1000, [1s, 3s, 5s])`).
- Warning log on every fallback to cached state so it is visible in step output.

### Migration

Swap `@v1` → `@v2` in your workflow. No input changes required. To keep the v1 cached-only behaviour, pin to `@v1` (the ref is not moved by v2 releases).

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
