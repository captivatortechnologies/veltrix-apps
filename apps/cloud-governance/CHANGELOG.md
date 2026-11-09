# Changelog

All notable changes to the Veltrix Cloud Governance app are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## 0.3.0 — 2026-11-09

### Added — "Connect AWS account" on the Accounts page (SDK 3.13.0)

The manifest declares `connection.onboarding` with the platform's new
`aws-assume-role` adapter, so the Accounts page's connect button is live. The
admin enters a name, an environment and the 12-digit account id; the platform
mints an External ID and shows a pre-filled CloudFormation quick-create link
(when the platform hosts the template) together with the equivalent
`aws iam create-role` / `attach-role-policy` commands. The page polls until
the platform can assume the new `VeltrixGovernance` role, then stores the
connection in the shape this app already reads (account id, role ARN,
External ID). Manual connections keep working unchanged.

The role gets `ReadOnlyAccess`, enough for previews; enforcement still needs
the write actions your policies use, attached by you.

A new optional app setting `aws_account_id` pre-fills the account id in the
connect dialog; it is not required.

## 0.2.1 — 2026-11-09

### Changed — declares the platform runner identity it needs

The manifest now declares `platform.cloudIdentities: [aws]` (SDK 3.12.0). While
this app is installed, platform admins see a "Runner identity" setting under
Cloud Integrations › Settings where the platform's own AWS principal (host
identity or a stored access key) is configured and verified. Runs that
previously failed with "no valid AWS identity" succeed once it is set. The app
itself still never holds a cloud credential.

## 0.2.0 — 2026-11-09

### Fixed — colors on the Tailwind 4 host

Theme colors now read `rgb(var(--color-x-rgb, var(--color-x)))`, which
renders on hosts that ship bare RGB-triple tokens and on hosts that ship
full `rgb()` tokens (Veltrix Tailwind 4). Previously, on the new host,
status dots, badges and panel colors fell back to defaults.

### Added — schedules fire

The app now subscribes to the host's minute heartbeat
(`governance.schedule.tick`) and fires its own schedules: a schedule stored
without a due time is armed on its first tick, a due schedule is claimed
atomically and requests one run per registered account, and `next_run_at`
moves to the next UTC cron match. `auto` schedules request enforcement runs;
`observe`, `notify` and (until the approval gate ships) `ask` schedules
request previews. Deploying a schedule computes its first due time from the
cron and keeps an armed due time when the cron is unchanged. Runs requested
this way carry `requestedBy: schedule:<policy>`.

The platform side of Phase 0 — `ctx.db` on pipeline handler contexts, the
c7n runner worker, the credential broker and the heartbeat — shipped in the
Veltrix repository, so deploy handlers and runs are no longer inert on an
up-to-date host.

## 0.1.0 — 2026-11-08

### Added — Phase 0: author, compile, preview

First release. Policies, policy packs, exceptions and schedules are authored
as configuration canvases. Deploying a policy runs it through the admission
compiler, which emits Cloud Custodian-compatible YAML and refuses unsafe
constructs — `value_from` at any depth, `webhook`, `invoke-lambda`,
`invoke-sfn`, `notify`, user-set `mode` or `conditions`, event filters,
unknown policy keys, unknown actions and resources outside the AWS
allow-list (the full code table is in the README) — always runs in `pull`
mode and always carries a resource cap (default 100, ceiling 10 000).

Runs are requested per policy and AWS account as a **preview** (actions
stripped, matches reported) or an **enforcement** run. Enforcement is
accepted only for `auto` policies whose action class is reversible or
snapshot-backed; `ask` and irreversible enforcement are refused until the
per-run approval gate ships. Runs are executed by the
platform runner and reported back over correlated events; a message that
does not carry the run the account is waiting on is ignored. Run commands
are persisted before they are published and re-dispatched by the host
heartbeat if the broker never confirmed them.

Not in this release: Azure and GCP, owner notifications, the pre-image
rollback ledger, savings ledger, canaries by account, and the live
AssumeRole connection probe (the runner performs it). See the README
Coverage section for the full list of honest drops.
