import type { ActionClass, Enforcement, GovernancePolicy } from '../model/types'
import type { RunKind, RunStatus } from '../runner/contract'

export type Row = Record<string, any>

export type RunEvaluation = 'evaluated' | 'failed' | 'not-visible'
export type ActionOutcome = 'applied' | 'skipped' | 'failed'

export interface RunCounts { matched?: number; acted?: number; failed?: number; skipped?: number }

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))
const isoRequired = (v: unknown): string => iso(v) ?? ''

export interface PolicyDto {
  id: string
  customerId: string
  canvasId: string | null
  name: string
  model: GovernancePolicy
  compiledYaml: string | null
  actionClass: ActionClass
  enforcement: Enforcement
  version: number
  createdAt: string
  updatedAt: string
}

export const mapPolicy = (r: Row): PolicyDto => ({
  id: r.id, customerId: r.customer_id, canvasId: r.canvas_id ?? null, name: r.name, model: r.model,
  compiledYaml: r.compiled_yaml ?? null, actionClass: r.action_class, enforcement: r.enforcement,
  version: Number(r.version), createdAt: isoRequired(r.created_at), updatedAt: isoRequired(r.updated_at),
})

export interface PolicyAccountDto {
  id: string
  customerId: string
  policyId: string
  componentId: string
  accountRef: string | null
  regions: string[]
  activeRunId: string | null
  appliedAt: string | null
  createdAt: string
}

export const mapPolicyAccount = (r: Row): PolicyAccountDto => ({
  id: r.id, customerId: r.customer_id, policyId: r.policy_id, componentId: r.component_id,
  accountRef: r.account_ref ?? null, regions: r.regions ?? [], activeRunId: r.active_run_id ?? null,
  appliedAt: iso(r.applied_at), createdAt: isoRequired(r.created_at),
})

export interface RunDto {
  id: string
  customerId: string
  policyId: string
  policyAccountId: string
  componentId: string
  kind: RunKind
  enforcement: Enforcement
  actionClass: ActionClass
  status: RunStatus
  evaluation: RunEvaluation | null
  counts: RunCounts
  message: string | null
  dispatchedAt: string | null
  requestedBy: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export const mapRun = (r: Row): RunDto => ({
  id: r.id, customerId: r.customer_id, policyId: r.policy_id, policyAccountId: r.policy_account_id,
  componentId: r.component_id, kind: r.kind, enforcement: r.enforcement, actionClass: r.action_class,
  status: r.status, evaluation: r.evaluation ?? null, counts: r.counts ?? {}, message: r.message ?? null,
  dispatchedAt: iso(r.dispatched_at), requestedBy: r.requested_by ?? null, createdAt: isoRequired(r.created_at),
  startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
})

export interface RunMatchDto {
  id: string
  runId: string
  resourceId: string
  resourceType: string
  arn: string | null
  region: string
  name: string | null
  tags: Record<string, string>
  owner: string | null
  createdAt: string
}

export const mapMatch = (r: Row): RunMatchDto => ({
  id: r.id, runId: r.run_id, resourceId: r.resource_id, resourceType: r.resource_type, arn: r.arn ?? null,
  region: r.region, name: r.name ?? null, tags: r.tags ?? {}, owner: r.owner ?? null, createdAt: isoRequired(r.created_at),
})

export interface RunActionDto {
  id: string
  runId: string
  resourceId: string
  action: string
  outcome: ActionOutcome
  message: string | null
  priorState: Record<string, unknown> | null
  at: string
}

export const mapAction = (r: Row): RunActionDto => ({
  id: r.id, runId: r.run_id, resourceId: r.resource_id, action: r.action, outcome: r.outcome,
  message: r.message ?? null, priorState: r.prior_state ?? null, at: isoRequired(r.at),
})

export interface ExceptionDto {
  id: string
  customerId: string
  canvasId: string | null
  policyName: string
  resourceId: string
  reason: string
  approver: string
  expiresAt: string
  createdAt: string
}

export const mapException = (r: Row): ExceptionDto => ({
  id: r.id, customerId: r.customer_id, canvasId: r.canvas_id ?? null, policyName: r.policy_name,
  resourceId: r.resource_id, reason: r.reason, approver: r.approver, expiresAt: isoRequired(r.expires_at),
  createdAt: isoRequired(r.created_at),
})

export interface ScheduleDto {
  id: string
  customerId: string
  canvasId: string | null
  policyName: string
  cron: string
  enabled: boolean
  enforcement: Enforcement
  lastRunAt: string | null
  nextRunAt: string | null
  createdAt: string
  updatedAt: string
}

export const mapSchedule = (r: Row): ScheduleDto => ({
  id: r.id, customerId: r.customer_id, canvasId: r.canvas_id ?? null, policyName: r.policy_name, cron: r.cron,
  enabled: Boolean(r.enabled), enforcement: r.enforcement, lastRunAt: iso(r.last_run_at), nextRunAt: iso(r.next_run_at),
  createdAt: isoRequired(r.created_at), updatedAt: isoRequired(r.updated_at),
})
