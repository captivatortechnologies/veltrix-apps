import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import type { MatchedResource, RunActionPayload, RunKind, RunRequestedPayload, RunStatus } from '../runner/contract'
import type { ActionClass, Enforcement } from '../model/types'
import { mapAction, mapMatch, mapRun, type RunActionDto, type RunCounts, type RunDto, type RunEvaluation, type RunMatchDto } from './mappers'

export interface CreateRunInput {
  id: string
  policyId: string
  policyAccountId: string
  componentId: string
  kind: RunKind
  enforcement: Enforcement
  actionClass: ActionClass
  requestedBy?: string | null
  commandPayload: RunRequestedPayload
}

export async function createRun(db: PlatformDatabaseClient, customerId: string, input: CreateRunInput): Promise<RunDto> {
  const rows = await db.$queryRawUnsafe<any[]>(
    `INSERT INTO cgov_run (id, customer_id, policy_id, policy_account_id, component_id, kind, enforcement, action_class, status, requested_by, command_payload)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, 'queued', $9::uuid, $10::jsonb)
     RETURNING *`,
    input.id, customerId, input.policyId, input.policyAccountId, input.componentId, input.kind, input.enforcement,
    input.actionClass, input.requestedBy ?? null, JSON.stringify(input.commandPayload))
  return mapRun(rows[0])
}

export async function getRun(db: PlatformDatabaseClient, customerId: string, id: string): Promise<RunDto | null> {
  const rows = await db.$queryRawUnsafe<any[]>('SELECT * FROM cgov_run WHERE id = $1::uuid AND customer_id = $2::uuid', id, customerId)
  return rows[0] ? mapRun(rows[0]) : null
}

export interface ListRunsOptions {
  policyId?: string | null
  limit?: number
}

export async function listRuns(db: PlatformDatabaseClient, customerId: string, options: ListRunsOptions = {}): Promise<RunDto[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 500)
  const rows = await db.$queryRawUnsafe<any[]>(
    `SELECT * FROM cgov_run WHERE customer_id = $1::uuid AND ($2::uuid IS NULL OR policy_id = $2::uuid)
     ORDER BY created_at DESC LIMIT $3`,
    customerId, options.policyId ?? null, limit)
  return rows.map(mapRun)
}

export interface RunStatusUpdate {
  status: RunStatus
  evaluation?: RunEvaluation | null
  message?: string | null
  counts?: RunCounts | null
  startedAt?: string | null
  finishedAt?: string | null
}

const TERMINAL: RunStatus[] = ['succeeded', 'failed', 'cancelled']
export const isTerminalStatus = (status: RunStatus): boolean => TERMINAL.includes(status)

export async function setRunStatus(db: PlatformDatabaseClient, customerId: string, id: string, update: RunStatusUpdate): Promise<void> {
  const terminal = isTerminalStatus(update.status)
  await db.$executeRawUnsafe(
    `UPDATE cgov_run SET status = $3,
       evaluation = COALESCE($4, evaluation), message = COALESCE($5, message), counts = COALESCE($6::jsonb, counts),
       started_at = CASE WHEN $3 = 'queued' THEN started_at ELSE COALESCE(started_at, $7::timestamptz, now()) END,
       finished_at = CASE WHEN $8::boolean THEN COALESCE($9::timestamptz, now()) ELSE finished_at END
     WHERE id = $1::uuid AND customer_id = $2::uuid`,
    id, customerId, update.status, update.evaluation ?? null, update.message ?? null,
    update.counts ? JSON.stringify(update.counts) : null, update.startedAt ?? null, terminal, update.finishedAt ?? null)
}

export async function markRunDispatched(db: PlatformDatabaseClient, id: string): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE cgov_run SET dispatched_at = now(), status = CASE WHEN status = 'queued' THEN 'running' ELSE status END
     WHERE id = $1::uuid AND status IN ('queued', 'running')`, id)
}

export async function addMatches(db: PlatformDatabaseClient, customerId: string, runId: string, resources: MatchedResource[]): Promise<number> {
  if (resources.length === 0) return 0
  const batch = resources.map(r => ({
    resource_id: r.resourceId, resource_type: r.resourceType, arn: r.arn ?? null, region: r.region,
    name: r.name ?? null, tags: r.tags ?? {}, owner: r.owner ?? null,
  }))
  return db.$executeRawUnsafe(
    `INSERT INTO cgov_run_match (customer_id, run_id, resource_id, resource_type, arn, region, name, tags, owner)
     SELECT $1::uuid, $2::uuid, m.resource_id, m.resource_type, m.arn, m.region, m.name, COALESCE(m.tags, '{}'::jsonb), m.owner
     FROM jsonb_to_recordset($3::jsonb) AS m(resource_id text, resource_type text, arn text, region text, name text, tags jsonb, owner text)
     ON CONFLICT (run_id, resource_id) DO NOTHING`,
    customerId, runId, JSON.stringify(batch))
}

export async function addAction(db: PlatformDatabaseClient, customerId: string, action: RunActionPayload): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO cgov_run_action (customer_id, run_id, resource_id, action, outcome, message, prior_state, at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, COALESCE($8::timestamptz, now()))
     ON CONFLICT (run_id, resource_id, action) DO UPDATE SET
       outcome = EXCLUDED.outcome, message = EXCLUDED.message,
       prior_state = COALESCE(EXCLUDED.prior_state, cgov_run_action.prior_state), at = EXCLUDED.at`,
    customerId, action.runId, action.resourceId, action.action, action.outcome, action.message ?? null,
    action.priorState ? JSON.stringify(action.priorState) : null, action.at ?? null)
}

export async function listMatches(db: PlatformDatabaseClient, customerId: string, runId: string): Promise<RunMatchDto[]> {
  const rows = await db.$queryRawUnsafe<any[]>(
    'SELECT * FROM cgov_run_match WHERE customer_id = $1::uuid AND run_id = $2::uuid ORDER BY region, resource_id', customerId, runId)
  return rows.map(mapMatch)
}

export async function listActions(db: PlatformDatabaseClient, customerId: string, runId: string): Promise<RunActionDto[]> {
  const rows = await db.$queryRawUnsafe<any[]>(
    'SELECT * FROM cgov_run_action WHERE customer_id = $1::uuid AND run_id = $2::uuid ORDER BY at, resource_id', customerId, runId)
  return rows.map(mapAction)
}
