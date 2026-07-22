# Changelog

All notable changes to the Palo Alto Panorama app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 1.1.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed Panorama object (tags, address & service objects, address & service
  groups, security pre-rules), each reported difference is now annotated with the
  administrator who made the last change and when. The platform stores the
  `actor` on each diff and the drift view renders it, so a drift alert answers
  *who* and *when*, not just *what*.
  - Attribution reads the PAN-OS **config audit log** (`type=log&log-type=config`)
    — an asynchronous log job that is started, polled briefly for the recent rows
    of the drifted object, then correlated to that object by matching its name in
    the row's `path` / `full-path` xpath at a token boundary (so "web" is never
    mistaken for "web-server"). The row's `admin`, `cmd` and `time_generated`
    become the actor's name, event type and timestamp.
  - Real object edits (`set` / `edit` / `delete` / `rename` / `move` / …) are
    preferred over activation-only commands (`commit` / `validate`), and only
    succeeded rows count, so the actor is whoever made the change rather than
    whoever pushed it.
  - Veltrix's own deploys are recorded in the config log under the connection
    admin, so a change WE made is excluded via that admin username — the
    attribution reflects the *manual* change rather than our deploy.
  - **Strictly best-effort:** attribution never throws, and never slows down or
    fails a drift check. The config-log job is tightly bounded and, on any error,
    an unreachable or timed-out log, or no usable row (for example a deleted
    object, or a log the admin role cannot read), the diff is reported without an
    actor and the drift view shows "—". Only objects that actually drifted are
    attributed (one bounded query per drifted object).
