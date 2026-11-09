// =============================================================================
// Runner contract — what the app publishes and what the platform runner sends
// back. The runner (a per-job container with a pinned c7n, owned by the
// platform) is the ONLY thing that touches a customer cloud. The app never
// holds cloud credentials: it names the account component and the runner
// resolves a scoped session through the platform credential broker.
//
// Correlation: every message carries `runId`. The app honours a message only
// when it matches the run the policy/account pair is waiting on, so a late
// message from an older run can never change a newer one (same rule as the
// Splunk BYOL lifecycle).
// =============================================================================

import type { ActionClass, Enforcement, Provider } from '../model/types'

/** Published by the app via `ctx.events.publish` (routed as `cloud-governance.<topic>`). */
export const RUN_REQUESTED = 'governance.run.requested'
export const RUN_CANCEL_REQUESTED = 'governance.run.cancel.requested'

/** Topics the app subscribes to in `manifest.events` (delivered to hooks/onEvent). */
export const RUN_STATUS = 'governance.run.status'
export const RUN_MATCH = 'governance.run.match'
export const RUN_ACTION = 'governance.run.action'
/** Host heartbeat: re-dispatch persisted commands the broker never confirmed. */
export const RECONCILE = 'governance.reconcile'
/** Host heartbeat, once a minute: the app fires whichever of its own schedules are due. */
export const SCHEDULE_TICK = 'governance.schedule.tick'

export interface ScheduleTickPayload {
  /** ISO timestamp of the minute the host is announcing. */
  now: string
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** What the runner actually did, independent of what the policy asked for. */
export type RunKind = 'preview' | 'enforce'

export interface RunRequestedPayload {
  runId: string
  customerId: string
  policyId: string
  policyName: string
  /** Platform component id of the `aws-account` the run targets. */
  componentId: string
  provider: Provider
  /** Cloud account identifier as the runner should report it (e.g. AWS account id). */
  accountRef: string | null
  regions: string[]
  kind: RunKind
  enforcement: Enforcement
  actionClass: ActionClass
  /** Compiled c7n document; the runner executes exactly this and nothing else. */
  compiledYaml: string
  /** Absolute resource cap the compiler injected; the runner must also honour it. */
  maxResources: number
  /** Tag keys, in order, the runner consults to fill `MatchedResource.owner`. */
  ownerTagKeys: string[]
  requestedBy: string | null
  requestedAt: string
}

export interface RunStatusPayload {
  runId: string
  policyId: string
  status: RunStatus
  message?: string | null
  /** Counts the runner has final numbers for. */
  counts?: { matched?: number; acted?: number; failed?: number; skipped?: number }
  /** Set when evaluation itself could not complete (auth, quota, engine crash). */
  evaluation?: 'evaluated' | 'failed' | 'not-visible'
  startedAt?: string
  finishedAt?: string
}

export interface MatchedResource {
  resourceId: string
  resourceType: string
  arn?: string | null
  region: string
  name?: string | null
  tags?: Record<string, string>
  /** Owner the runner resolved from `ownerTagKeys`, if any. */
  owner?: string | null
}

export interface RunMatchPayload {
  runId: string
  policyId: string
  /** Page of matches; the runner may send several. */
  resources: MatchedResource[]
}

export interface RunActionPayload {
  runId: string
  policyId: string
  resourceId: string
  action: string
  outcome: 'applied' | 'skipped' | 'failed'
  message?: string | null
  /** Prior state the runner captured for reversible actions (Phase 1 ledger). */
  priorState?: Record<string, unknown> | null
  at: string
}

export interface RunCancelPayload {
  runId: string
  customerId: string
  policyId: string
  requestedBy: string | null
}
