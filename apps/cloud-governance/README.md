# Veltrix Cloud Governance (Veltrix app)

Cloud governance policies as code. A policy is authored as a form (resource
type, filters, actions, enforcement level), compiled by an **admission
compiler** that refuses unsafe constructs and injects a resource cap, run first
as a **preview** that lists exactly which resources would be touched, and only
then enforced. Every run is correlated to one policy/account pair, capped and
recorded. The emitted documents are **compatible with Cloud Custodian
policies** and execute on the upstream engine inside a platform-owned runner.
Cloud Custodian is a trademark of The Linux Foundation; this app is not
affiliated with or endorsed by the Cloud Custodian project, and the trademark
is not used in the app's id, name or imagery (`manifest.yaml`, `branding`).

- **Category:** Cloud Security
- **Provider (Phase 0):** AWS only (`lib/model/types.ts`, `Provider = 'aws'`)
- **Database:** app-owned tables, `isolation: database`, prefix `cgov_`
- **Cloud credentials held by the app:** none (see Security notes)
- **Status:** 0.1.0, Phase 0 (author, compile, preview). The platform runner
  that executes runs **does not exist yet** — see Architecture.

## How it works

### The loop: preview → approve → act → verify

1. **Author.** A policy is a configuration-canvas item (`policies` config
   type). Deploying it validates the model (`lib/model/validate.ts`), compiles
   it (`lib/compiler/compilePolicy.ts`) and upserts the row in `cgov_policy`
   with the compiled YAML, action class and enforcement. Nothing reaches a
   cloud at deploy time.
2. **Preview.** `POST /api/apps/cloud-governance/policies/:id/runs` with
   `kind: "preview"` requests a run for one policy on one `aws-account`
   component. A preview always runs at `observe`, so the compiled document
   carries no actions; the runner reports matches
   (`governance.run.match`) and a terminal status.
3. **Approve / act.** An `enforce` run is only accepted when the policy's own
   enforcement is `ask` or `auto`, and a run can never use stronger
   enforcement than the policy (`resolveEnforcement` in
   `lib/runLifecycle.ts`). The runner applies actions under the injected cap
   and reports each one (`governance.run.action`).
4. **Verify.** Run status, counts (`matched / acted / failed / skipped`) and
   the `evaluation` outcome (`evaluated`, `failed`, `not-visible`) are stored
   on `cgov_run`; matches and actions are stored per resource.

### Enforcement ladder

| Level | What it compiles to | Who may request runs at this level |
| --- | --- | --- |
| `observe` | Filters only; actions stripped (`stripped` in `compilePolicy.ts`) | Preview runs; schedules |
| `notify` | Same as `observe` today — actions stripped. Owner notification is Phase 2 | Preview runs; schedules |
| `ask` | Filters **and** actions emitted | `enforce` runs when the policy is `ask` or `auto` |
| `auto` | Filters and actions emitted | `enforce` runs only when the policy itself is `auto` |

`lib/model/types.ts` documents `ask` as "each run's action set needs an
approval". In 0.1.0 that approval gate is **not implemented** in
`lib/runLifecycle.ts`: an `ask` enforce run is dispatched like an `auto` one.
The platform pipeline's own deploy approvals still apply to deploying the
policy; the per-run approval is Phase 1 work.

Every compiled document also carries `veltrix:policy=<name>` and
`veltrix:enforcement=<level>` in `tags` (`TAG_POLICY`, `TAG_ENFORCEMENT`).

## Architecture

```
veltrix-apps/apps/cloud-governance (this repo)        Veltrix platform (other repo)
┌─────────────────────────────────────────┐          ┌──────────────────────────────┐
│ config types  → model → admission       │ publish  │ runner worker (per-job        │
│ compiler → cgov_policy (compiled YAML)  │ ───────▶ │ container, pinned engine)     │
│ run lifecycle → cgov_run (command)      │ events   │ credential broker: AssumeRole │
│ onEvent ← status / match / action       │ ◀─────── │ + External ID, short session  │
└─────────────────────────────────────────┘          └──────────────────────────────┘
```

**The app (this repo) authors, compiles and records.** It never spawns a
process (app vetting forbids `child_process`) and never calls AWS. Its only
outbound act is publishing two events through `ctx.events.publish`
(`lib/runner/contract.ts`): `governance.run.requested` carrying the compiled
YAML, cap, regions, enforcement and action class, and
`governance.run.cancel.requested`.

**The platform runner (Veltrix repo) executes.** By contract it runs the
upstream engine pinned to one version in a per-job container, obtains a
short-lived session for the target account through the platform credential
broker (`sts:AssumeRole` into the customer's role with a provider-generated
External ID), executes exactly the YAML it was given, enforces the same
`maxResources` cap, and reports back on `governance.run.status`,
`governance.run.match` and `governance.run.action`.

**The runner lives in the Veltrix platform repository**
(`rabbitmq/src/services/governance/`, `governance-worker.ts`): a per-job
container running a pinned `cloudcustodian/c7n` image under a 15-minute
`sts:AssumeRole` session, `--dryrun` for previews, the resource cap enforced
again on its side, and an inbound app-event consumer that returns its
messages to `hooks/onEvent`. Its `contract.ts` mirrors `lib/runner/contract.ts`
here; change them together. On a host without the worker, a requested run is
persisted and published but nothing consumes it; the run stays `running`
after dispatch and the host heartbeat re-dispatches it every five minutes
(see Run correlation). The UI shows this state honestly rather than claiming
the account was evaluated.

**Schedules** are fired by the app itself on the host's minute tick
(`governance.schedule.tick`, payload `{ now }`): `lib/schedule/tick.ts` arms a
freshly stored schedule on its first tick, claims a due one atomically (two
overlapping ticks cannot both fire it), requests one run per registered
account — `auto` enforces, `observe`/`notify`/`ask` preview — and moves
`next_run_at` to the next cron match (`lib/schedule/cron.ts`, UTC).

## Admission compiler

Tenant YAML is never accepted raw. The UI, store and compiler exchange only
the internal model in `lib/model/types.ts`; `compilePolicy` turns it into a
document and refuses anything outside the allow-lists. A `CompileResult` is a
non-union shape — `document`, `yaml`, `errors`, `warnings`, `actionClass` and
`usedTypes` are always present.

### Deny codes (`lib/compiler/denyList.ts`)

| Code | Trigger | Why |
| --- | --- | --- |
| `FILTER_VALUE_FROM` | Any key matching `value_from` / `value-from` anywhere in a filter or action object (`scanValueFrom`) | `value_from` fetches `http`, `https` or `file` URIs at run time: server-side request forgery and local file read from inside the runner |
| `FILTER_TYPE_NOT_ALLOWED` | Filter type `event` | Only meaningful in event-driven modes; the runner runs `pull` only |
| `FILTER_INVALID` | Filter that is neither a type name nor an object, or an object with no `type` and no `or`/`and`/`not`, or a group whose value is not an array | Shape error; nothing else can be checked |
| `FILTER_TOO_DEEP` | Nesting beyond 64 levels (`MAX_DEPTH`) | Bounds the recursive scan |
| `ACTION_WEBHOOK` | Action `webhook` | Sends resource data to arbitrary URLs: exfiltration channel |
| `ACTION_INVOKE_LAMBDA` | Action `invoke-lambda` | Executes arbitrary customer code from a governance run |
| `ACTION_INVOKE_SFN` | Action `invoke-sfn` | Starts arbitrary state machines: same class as `invoke-lambda` |
| `ACTION_NOTIFY` | Action `notify` | Not available yet; owner routing and the message transport arrive in Phase 2 |
| `ACTION_INVALID` | Action that is neither a type name nor an object with `type` | Shape error |
| `UNKNOWN_ACTION_TYPE` | Action type not classified by `classifyActionType` (`lib/model/awsResources.ts`) | Every action must have a known reversibility class; unknown actions are rejected rather than guessed |
| `MODE_NOT_ALLOWED` | `mode` key on the authored model | Execution mode is runner-controlled; the compiler always emits `mode: { type: pull }` |
| `CONDITIONS_NOT_ALLOWED` | `conditions` key on the authored model | Policy-level conditions are not part of the model |
| `UNKNOWN_POLICY_KEY` | Any model key outside `MODEL_POLICY_KEYS`; also any emitted key outside `EMITTED_POLICY_KEYS` (`scanEmittedKeys`, a self-check on the compiler's own output) | Closed key set in both directions |
| `RESOURCE_NOT_ALLOWED` | `resource` not in `AWS_RESOURCES` (`lib/model/validate.ts`) | Only the 40 allow-listed AWS resource types compile |

Additional validation codes (`NAME_INVALID`, `PROVIDER_INVALID`, `CAP_INVALID`,
`GRACE_PERIOD_INVALID`, `TAGS_INVALID`, `OWNER_TAG_KEYS_INVALID`, ...) are
shape checks in `lib/model/validate.ts`.

### Injected and ceilinged caps

- `max-resources` is always emitted: the policy's `maxResources` or
  `DEFAULT_MAX_RESOURCES = 100` (`compilePolicy.ts`). `maxResources` must be an
  integer in `1..10000` (`MAX_RESOURCES_CEILING`, `validate.ts`).
- `max-resources-percent` is always emitted: the policy's
  `maxResourcesPercent` or `DEFAULT_MAX_RESOURCES_PERCENT = 10`; valid range
  `1..100`.
- `mode` is always `{ type: pull }`.
- The run command repeats the absolute cap in `maxResources` so the runner
  enforces it independently of the YAML (`buildPayload`, `runLifecycle.ts`).

### Exceptions compile to filters

`lib/compiler/exceptions.ts` turns each unexpired exception for the policy into
`{ not: [{ type: value, key: <resource id key>, value: <resourceId> }] }`,
using the per-resource id key from `RESOURCE_ID_KEYS` (`InstanceId` for `ec2`,
`VolumeId` for `ebs`, `Name` for `s3`, ...). An expired exception is dropped
with warning `EXCEPTION_EXPIRED`; an ARN given for a resource type matched on a
non-ARN key warns `EXCEPTION_ARN_UNMATCHED`.

### Policy packs

`lib/compiler/pack.ts` compiles each member by name and concatenates the
documents into one `policies:` list. Pack action class is the maximum of the
members' (`maxActionClass`); a missing member fails with `PACK_MEMBER_MISSING`.

## Run correlation and durable dispatch

Same model as the Splunk BYOL provisioning lifecycle
(`apps/splunk-enterprise/lib/byolLifecycle.ts`), implemented in
`lib/runLifecycle.ts`:

- **Single writer per policy/account.** `requestRun` runs in one transaction:
  it locks the `cgov_policy_account` row `FOR UPDATE`, refuses if
  `active_run_id` is set (409 "A run is already in progress"), inserts the
  `cgov_run` row with the full command in `command_payload`, and sets
  `active_run_id` to the new run. The transaction requires `db.transaction`
  (503 otherwise).
- **Persist, then publish.** Only after commit does `dispatchCommand` publish
  `governance.run.requested` and stamp `dispatched_at`; a `queued` run becomes
  `running` on dispatch (`markRunDispatched`, `lib/db/runs.ts`). If publishing
  throws, the request still succeeds with `dispatchPending: true` and the
  command waits for reconcile.
- **Late messages are ignored.** `handleRunnerEvent` locks the account of the
  run, and drops the message unless `active_run_id === runId`, the run's
  `policyId` matches the payload and the run is not already terminal. A message
  from an older or cancelled run can never change a newer one.
- **Terminal status releases the account.** `succeeded`, `failed` or
  `cancelled` clears `active_run_id` and, on success, stamps `applied_at`.
- **Reconcile heartbeat.** `governance.reconcile` (manifest `events`, routed by
  `hooks/onEvent.ts`) re-dispatches up to 50 runs per tenant whose command is
  persisted, `started_at` is null, status is `queued`/`running`, and
  `dispatched_at` is null or older than five minutes (`STALE_DISPATCH_SQL`).
  The runner's `running` status sets `started_at`, which takes the run out of
  the reconcile set.
- **Cancel semantics.** `cancelRun` refuses finished runs and runs that are no
  longer the account's active run. A run that was **never dispatched** is
  cancelled locally (`status = cancelled`, "Cancelled before dispatch.",
  `active_run_id` cleared) without publishing anything. A dispatched run
  publishes `governance.run.cancel.requested` and stays `running` until the
  runner reports `cancelled`.
- Uncorrelated runner messages (no `runId` or `policyId`) are logged and
  dropped in `hooks/onEvent.ts`.

## Setup

### 1. Create the IAM role in the AWS account

Trust policy. Replace the principal with the Veltrix runner principal shown in
the platform (it is platform infrastructure, not this app) and the External ID
with the value you will store on the connection. The `sts:ExternalId`
condition is what stops a confused-deputy assumption of your role.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<VELTRIX_RUNNER_ACCOUNT_ID>:role/<VELTRIX_RUNNER_ROLE>" },
      "Action": "sts:AssumeRole",
      "Condition": { "StringEquals": { "sts:ExternalId": "<EXTERNAL_ID_AT_LEAST_8_CHARS>" } }
    }
  ]
}
```

Permissions for previews: attach the AWS managed policy
`arn:aws:iam::aws:policy/ReadOnlyAccess` (or `SecurityAudit` for a narrower
read set). Preview runs compile with actions stripped and need only describe /
list / get calls. For enforcement, grant the write actions your policies'
action types need (`CompileResult.usedTypes` lists the filter and action types
each policy uses; the runner is the component that resolves them to IAM
actions).

### 2. Register the account connection

Add an `aws-account` component and a connection on the **Accounts** page
(`/connections`, manifest `client.pages`). The fields map onto the platform
connection record as read by `lib/accountConnection.ts`:

| Field | Platform slot | Rule |
| --- | --- | --- |
| AWS account id | component hostname / endpoint | Exactly 12 digits (`ACCOUNT_ID_PATTERN`) |
| Role ARN | credential `username` | `arn:aws:iam::<account>:role/<name>`; the account in the ARN must equal the account id (`ROLE_ARN_PATTERN`) |
| External ID | credential `apiToken` (or `password`) | At least 8 characters |

**Test connection** (`handlers/testConnection.ts`) is a shape check only. It
confirms the three fields are well-formed and consistent, and says explicitly
that the live `AssumeRole` is verified by the platform runner on the first run.
It does not contact AWS.

### 3. Author and run

Author a policy in the Configuration Canvas (`policies` type), deploy it to
one or more `aws-account` components, then request a **preview** from the
policy or Runs page. Read the match list. Raise enforcement to `ask` or `auto`
and request an **enforce** run only once the preview shows what you expect.

App settings (`manifest.yaml`): `default_max_resources` (default 100) and
`default_regions` (default `us-east-1`). Note that in 0.1.0 the lifecycle uses
the compiler constant `DEFAULT_MAX_RESOURCES = 100` directly and regions come
from the `cgov_policy_account` row; neither setting is read yet.

## Configuration types

All four target `aws-account` components with `requiresCredential: false` and
`requiresConnectivity: false` (the runner, not the pipeline, needs the
account connection). Each ships the six pipeline handlers (`validate`,
`deploy`, `rollback`, `healthCheck`, `driftDetect`, `getStatus`); packs,
exceptions and schedules also ship `options` for live pickers.

| Config type | Group | Reconcile key | Backing table | Notes |
| --- | --- | --- | --- | --- |
| `policies` | Policies | policy `name` (unique per tenant) | `cgov_policy` | Deploy compiles and stores YAML + action class; also registers the policy on each targeted account in `cgov_policy_account` |
| `policy-packs` | Policies | pack `name` | `cgov_policy` members only — no pack row | Members compiled into one document (`lib/compiler/pack.ts`); stored as member registrations |
| `exceptions` | Guardrails | (`policy_name`, `resource_id`) | `cgov_exception` | Expiring, approver-attributed; compiled into the policy as a `not` filter until `expires_at` |
| `schedules` | Guardrails | `policy_name` | `cgov_schedule` | Five-field cron, UTC (`isValidCron`); enforcement never stronger than the policy's own |

Policy `name`, pack `name`, exception `policy` and schedule `policy` all obey
`NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/`.

## Coverage

### AWS resource allow-list (`lib/model/awsResources.ts`, 40 types)

Resource names are the upstream resource type without the `aws.` prefix; the
compiler re-adds the prefix on emit. Anything else fails with
`RESOURCE_NOT_ALLOWED`.

| Service area | Resources |
| --- | --- |
| Compute | `ec2`, `ami`, `asg`, `launch-template`, `lambda`, `ecs`, `eks` |
| Storage | `ebs`, `ebs-snapshot`, `s3`, `efs`, `ecr` |
| Database / cache / analytics | `rds`, `rds-snapshot`, `rds-cluster`, `dynamodb-table`, `elasticache`, `redshift` |
| Networking | `vpc`, `subnet`, `security-group`, `eip`, `elb`, `app-elb`, `nat-gateway`, `internet-gateway`, `route-table`, `network-acl` |
| Identity | `iam-user`, `iam-role`, `iam-group`, `iam-policy` |
| Messaging / logging / audit | `sqs`, `sns`, `log-group`, `cloudtrail` |
| Secrets / keys / parameters | `kms-key`, `secrets-manager`, `ssm-parameter` |
| Infrastructure as code | `cfn` |

Each resource has a documented id key (`RESOURCE_ID_KEYS`) used by exception
filters and by the UI to display matches.

### Action classes (`lib/model/awsResources.ts`, `lib/model/actionClass.ts`)

| Class | Rule | Members |
| --- | --- | --- |
| `reversible` | Listed, or any `set-*` type | `tag`, `untag`, `mark`, `mark-for-op`, `unmark`, `remove-tag`, `rename-tag`, `normalize-tag`, `tag-trim`, `auto-tag-user`, `copy-related-tag`, `stop`, `start`, `snapshot`, `modify-security-groups`, `remove-permissions`, `detach`, `disassociate`, `set-retention`, `set-encryption`, `post-finding`, `put-metric` |
| `irreversible` | Listed, or any `delete-*` type | `delete`, `terminate`, `remove`, `schedule-key-deletion`, `disable-key`, `release`, `deregister`, `revoke` |
| `snapshot-delete` | A `delete`/`terminate`/`delete-*` action preceded by a `snapshot` action in the same policy, or carrying a truthy `*snapshot*` option (`skip-snapshot: false` counts) | derived |
| `none` | No actions, or `observe`/`notify` policy | — |

A policy's `actionClass` is the maximum over its actions
(`none < reversible < snapshot-delete < irreversible`) and is stored on
`cgov_policy.action_class` and on every run. Any action type outside these
rules is `UNKNOWN_ACTION_TYPE` and does not compile. The manifest description
says Phase 0 covers "reversible actions"; the compiler and lifecycle do not yet
block `irreversible` enforce runs — the class is recorded for the Phase 1
approval rules, not enforced in 0.1.0.

### Filters

Any filter type other than `event` compiles, including string shorthand
(`tag:Owner`), `value`, `and`/`or`/`not` groups nested up to 64 deep. The
compiler does not validate filter semantics against the upstream schema; see
Honest drops.

## Honest drops / not managed in 0.1.0

- **Azure and GCP.** `Provider` is `'aws'` only; the model, allow-list and
  connection check are AWS-shaped. Azure is Phase 2 in the plan.
- **Notifications and owner routing.** `notify` compiles to a no-action
  preview; the `notify` action is denied (`ACTION_NOTIFY`). `ownerTagKeys` is
  accepted on the model but is **not** emitted in the YAML and **not** carried
  in `RunRequestedPayload`, so the runner has no way to resolve `owner` on a
  match yet.
- **Grace period.** `gracePeriodDays` is validated (`0..365`) but is not
  emitted; `mark-for-op` days must be set on the action itself.
- **Pre-image rollback ledger.** `cgov_run_action.prior_state` and
  `RunActionPayload.priorState` exist, but nothing restores from them. Pipeline
  rollback restores the *policy*, not changed resources.
- **Savings ledger**, **blast-radius score**, **per-run approval for `ask`**,
  **kill switches** — Phase 1.
- **Account canaries / canary rollout by account** — Phase 1.
- **IaC pull-request loop** and **AI-assisted policy drafting** — not planned
  for Phase 0.
- **Live AssumeRole probe in Test connection.** Shape check only, by design:
  the app must never exercise cloud credentials.
- **`custodian validate` on emitted YAML.** The compiler's own
  `scanEmittedKeys` self-check runs, but the document is not validated against
  the upstream JSON schema before dispatch; a filter with a valid shape but
  wrong semantics will fail in the runner, not at compile time.
- **Policy-pack row.** A pack is stored as its member registrations in
  `cgov_policy` / `cgov_policy_account`; there is no `cgov_policy_pack` table
  in `migrations/001_initial.sql`, so a pack cannot be listed or diffed as its
  own record.
- **Schedule firing** needs the host's minute tick (`governance.schedule.tick`,
  platform ≥ the app-heartbeat release). On a host without it, schedules are
  stored and armed but never fire; nothing in the UI says so yet.
- **The runner itself.** See Architecture.
- **App settings `default_max_resources` / `default_regions`** are declared
  but not read by the lifecycle yet.
- **`component:deleted`** is subscribed in `manifest.events` but has no
  handler in `hooks/onEvent.ts`; deleting an `aws-account` component does not
  clean up `cgov_policy_account` rows.

## Data model (`migrations/001_initial.sql`)

| Table | Key / uniqueness | Holds |
| --- | --- | --- |
| `cgov_policy` | `UNIQUE (customer_id, name)` | `model` (JSONB), `compiled_yaml`, `action_class`, `enforcement`, `version` (bumped on every upsert), `canvas_id` |
| `cgov_policy_account` | `UNIQUE (policy_id, component_id)` | `account_ref`, `regions[]`, `active_run_id` (single-writer lock), `applied_at` |
| `cgov_run` | PK `id`; partial index on `dispatched_at` where a command is pending | `kind`, `enforcement`, `action_class`, `status`, `evaluation`, `counts` (JSONB), `message`, `command_payload` (JSONB, the persisted command), `dispatched_at`, `requested_by`, `started_at`, `finished_at` |
| `cgov_run_match` | `UNIQUE (run_id, resource_id)` | `resource_type`, `arn`, `region`, `name`, `tags` (JSONB), `owner` |
| `cgov_run_action` | `UNIQUE (run_id, resource_id, action)` | `outcome`, `message`, `prior_state` (JSONB), `at` |
| `cgov_exception` | `UNIQUE (customer_id, policy_name, resource_id)` | `reason`, `approver`, `expires_at`, `canvas_id` |
| `cgov_schedule` | `UNIQUE (customer_id, policy_name)` | `cron`, `enabled`, `enforcement`, `last_run_at`, `next_run_at`, `canvas_id` |

Policy, exception and schedule rows cascade from `cgov_policy` where they
reference it by id; exceptions and schedules reference policies by `name`.

## Security notes

- **No cloud credentials in the app.** The app holds no AWS access keys and
  never calls AWS. The connection record holds the role ARN and the External
  ID (both are inputs to the runner's `AssumeRole`, neither grants access on
  its own); the app reads them only to shape-check them. `credential:read` in
  `manifest.permissions.platform` exists for that check.
- **Runner executes only the compiled document.** `RunRequestedPayload.compiledYaml`
  is the full input; the runner must not read policies from anywhere else.
- **Closed-world compiler.** Unknown keys, unknown actions, unknown resources
  and any `value_from` are refused rather than passed through. Emitted keys are
  re-checked against `EMITTED_POLICY_KEYS` so a compiler bug cannot leak a key.
- **Tenant scoping.** Every query filters on `customer_id`; routes in
  `server/index.ts` require an authenticated tenant and the per-resource app
  permissions declared in the manifest (`policies`, `runs`, `exceptions`,
  `schedules`).
- **External ID minimum** is 8 characters (`readAccountConnection`); use a
  long random value generated by the platform, never a guessable one.

## Development

```
cd apps/cloud-governance
node node_modules/typescript/bin/tsc --noEmit                   # typecheck
node ../../scripts/test-apps.mjs cloud-governance               # run lib/__tests__ and config-type tests
node ../../scripts/validate-app.mjs apps/cloud-governance       # validate against the app contract
```

Unit tests live in `lib/__tests__/` (compiler deny-list, YAML emitter,
validator, exceptions, run lifecycle correlation and dispatch, account
connection) and in each `config-types/<id>/__tests__/`. Every change to the
compiler must keep the rule "an unsafe construct never compiles" green.

## Layout

`manifest.yaml`, `CHANGELOG.md`, `migrations/`, `hooks/`
(`onInstall`/`onUninstall`/`onEvent`), `handlers/testConnection.ts`,
`server/index.ts` (routes under `/api/apps/cloud-governance`),
`config-types/<id>/`, `client/` (Overview, Runs, Accounts pages), and `lib/`:
`model/` (types, validator, AWS allow-list, action classes), `compiler/`
(policy, pack, exceptions, YAML, deny list), `runner/contract.ts`,
`runLifecycle.ts`, `db/`.

## License

Apache-2.0
