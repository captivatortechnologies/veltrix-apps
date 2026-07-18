// =============================================================================
// BYOL provisioning state — raw-SQL access to the app-owned resource plan
// (`splunk_byol_resource`), deployment runs (`splunk_byol_deployment`) and their
// ordered steps (`splunk_byol_deployment_step`).
//
// The resource plan is SEEDED from `buildByolResourcePlan()` when a deploy is
// requested and then advanced by provisioning workers via the app's onEvent /
// onWebhook hooks. `customerId` references a PLATFORM entity as a plain UUID
// column; the app never foreign-keys across the boundary (same as byol.ts).
// =============================================================================

import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import type { ByolResourcePlanItemWithOrder } from '../byolTopology'
import type { Row } from './mappers'

// --- Resource statuses ------------------------------------------------------

export const RESOURCE_STATUSES = ['not_started', 'provisioning', 'ready', 'attention', 'failed'] as const
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number]

const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)))
const toDateOrNull = (v: unknown): Date | null => (v == null ? null : toDate(v))
const toInt = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10)
  return Number.isFinite(n) ? n : 0
}

// --- Resource DTO + mapper --------------------------------------------------

export interface ByolResourceDto {
  id: string
  infrastructureId: string
  tier: string
  kind: string
  name: string
  role: string | null
  region: string | null
  /** Availability zone within `region` for a multi-AZ-placed node; null otherwise. */
  zone: string | null
  /** Management roles a consolidated control-plane instance runs; null otherwise. */
  roles: string[] | null
  status: string
  externalRef: string | null
  message: string | null
  planKey: string
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

/** Parse a JSONB roles value (object from the driver, or a JSON string). */
function parseRoles(value: unknown): string[] | null {
  if (value == null) return null
  let arr: any = value
  if (typeof value === 'string') {
    try {
      arr = JSON.parse(value)
    } catch {
      return null
    }
  }
  return Array.isArray(arr) ? arr.filter((r) => typeof r === 'string') : null
}

export function mapResource(r: Row): ByolResourceDto {
  return {
    id: r.id,
    infrastructureId: r.infrastructure_id,
    tier: r.tier,
    kind: r.kind,
    name: r.name,
    role: r.role ?? null,
    region: r.region ?? null,
    zone: r.zone ?? null,
    roles: parseRoles(r.roles),
    status: r.status,
    externalRef: r.external_ref ?? null,
    message: r.message ?? null,
    planKey: r.plan_key,
    sortOrder: toInt(r.sort_order),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  }
}

/** All resources for an infrastructure, in plan order. */
export async function listResources(
  db: PlatformDatabaseClient,
  infrastructureId: string,
): Promise<ByolResourceDto[]> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM splunk_byol_resource WHERE infrastructure_id = $1::uuid ORDER BY sort_order ASC',
    infrastructureId,
  )
  return rows.map(mapResource)
}

/**
 * Persist a resource plan for an infrastructure, idempotently. Rows are keyed by
 * (infrastructure_id, plan_key): existing rows are updated and moved to
 * 'provisioning' (a re-deploy re-provisions), new rows are inserted, and any row
 * no longer in the plan (topology shrank) is removed.
 */
export async function seedResources(
  db: PlatformDatabaseClient,
  infrastructureId: string,
  customerId: string,
  plan: ByolResourcePlanItemWithOrder[],
): Promise<ByolResourceDto[]> {
  const keys = plan.map((p) => p.planKey)
  // Drop resources that are no longer part of the plan.
  await db.$executeRawUnsafe(
    'DELETE FROM splunk_byol_resource WHERE infrastructure_id = $1::uuid AND NOT (plan_key = ANY($2::text[]))',
    infrastructureId,
    keys,
  )
  for (const item of plan) {
    await db.$executeRawUnsafe(
      `INSERT INTO splunk_byol_resource
         (infrastructure_id, tier, kind, name, role, region, zone, roles, status, plan_key, sort_order, customer_id)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, 'provisioning', $9, $10, $11::uuid)
       ON CONFLICT (infrastructure_id, plan_key)
       DO UPDATE SET tier = EXCLUDED.tier, kind = EXCLUDED.kind, name = EXCLUDED.name,
                     role = EXCLUDED.role, region = EXCLUDED.region, zone = EXCLUDED.zone,
                     roles = EXCLUDED.roles, status = 'provisioning',
                     sort_order = EXCLUDED.sort_order, updated_at = now()`,
      infrastructureId,
      item.tier,
      item.kind,
      item.name,
      item.role,
      item.region,
      item.zone ?? null,
      item.roles && item.roles.length ? JSON.stringify(item.roles) : null,
      item.planKey,
      item.sortOrder,
      customerId,
    )
  }
  return listResources(db, infrastructureId)
}

/** Update one resource's status (and optional external ref / message) by plan key. */
export async function setResourceStatus(
  db: PlatformDatabaseClient,
  infrastructureId: string,
  planKey: string,
  status: string,
  extra: { externalRef?: string | null; message?: string | null } = {},
): Promise<boolean> {
  const affected = await db.$executeRawUnsafe(
    `UPDATE splunk_byol_resource
       SET status = $3,
           external_ref = COALESCE($4, external_ref),
           message = COALESCE($5, message),
           updated_at = now()
     WHERE infrastructure_id = $1::uuid AND plan_key = $2`,
    infrastructureId,
    planKey,
    status,
    extra.externalRef ?? null,
    extra.message ?? null,
  )
  return affected > 0
}

/**
 * Stamp a resource's external ref (e.g. the allocated subnet CIDR on the
 * foundation/network row) by plan key, WITHOUT touching its status. Overwrites
 * any prior ref. Returns whether a row matched.
 */
export async function setResourceExternalRef(
  db: PlatformDatabaseClient,
  infrastructureId: string,
  planKey: string,
  externalRef: string,
): Promise<boolean> {
  const affected = await db.$executeRawUnsafe(
    `UPDATE splunk_byol_resource
       SET external_ref = $3, updated_at = now()
     WHERE infrastructure_id = $1::uuid AND plan_key = $2`,
    infrastructureId,
    planKey,
    externalRef,
  )
  return affected > 0
}

/** Move every resource for an infrastructure to a status (terminal reconciliation). */
export async function setAllResourceStatuses(
  db: PlatformDatabaseClient,
  infrastructureId: string,
  status: string,
): Promise<void> {
  await db.$executeRawUnsafe(
    'UPDATE splunk_byol_resource SET status = $2, updated_at = now() WHERE infrastructure_id = $1::uuid',
    infrastructureId,
    status,
  )
}

// --- Deployment step DTO + mapper -------------------------------------------

export interface ByolDeploymentStepDto {
  id: string
  deploymentId: string
  stepOrder: number
  key: string
  title: string
  status: string
  detail: string | null
  logs: string | null
  startedAt: Date | null
  completedAt: Date | null
}

export function mapStep(r: Row): ByolDeploymentStepDto {
  return {
    id: r.id,
    deploymentId: r.deployment_id,
    stepOrder: toInt(r.step_order),
    key: r.step_key,
    title: r.title,
    status: r.status,
    detail: r.detail ?? null,
    logs: r.logs ?? null,
    startedAt: toDateOrNull(r.started_at),
    completedAt: toDateOrNull(r.completed_at),
  }
}

// --- Deployment DTO + mapper ------------------------------------------------

export interface ByolDeploymentDto {
  id: string
  infrastructureId: string
  action: string
  status: string
  message: string | null
  startedAt: Date
  completedAt: Date | null
  steps: ByolDeploymentStepDto[]
}

export function mapDeployment(r: Row): ByolDeploymentDto {
  return {
    id: r.id,
    infrastructureId: r.infrastructure_id,
    action: r.action,
    status: r.status,
    message: r.message ?? null,
    startedAt: toDate(r.started_at),
    completedAt: toDateOrNull(r.completed_at),
    steps: [],
  }
}

export interface DeploymentStepSeed {
  key: string
  title: string
  detail?: string
}

/**
 * Open a new deployment run and seed its steps. The first step ("plan created")
 * is recorded as done and the second as running — the rest start pending, to be
 * advanced by provisioning workers.
 */
export async function createDeployment(
  db: PlatformDatabaseClient,
  infrastructureId: string,
  action: 'deploy' | 'destroy',
  steps: DeploymentStepSeed[],
  initiatedByUserId?: string | null,
): Promise<ByolDeploymentDto> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    `INSERT INTO splunk_byol_deployment (infrastructure_id, action, status, initiated_by_user_id)
     VALUES ($1::uuid, $2, 'running', $3::uuid)
     RETURNING *`,
    infrastructureId,
    action,
    initiatedByUserId ?? null,
  )
  const deployment = mapDeployment(rows[0])

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const status = i === 0 ? 'done' : i === 1 ? 'running' : 'pending'
    const startedAt = i <= 1 ? 'now()' : 'NULL'
    const completedAt = i === 0 ? 'now()' : 'NULL'
    await db.$executeRawUnsafe(
      `INSERT INTO splunk_byol_deployment_step
         (deployment_id, step_order, step_key, title, status, detail, started_at, completed_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, ${startedAt}, ${completedAt})
       ON CONFLICT (deployment_id, step_key) DO NOTHING`,
      deployment.id,
      i,
      step.key,
      step.title,
      status,
      step.detail ?? null,
    )
  }
  return attachSteps(db, deployment)
}

async function attachSteps(db: PlatformDatabaseClient, deployment: ByolDeploymentDto): Promise<ByolDeploymentDto> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM splunk_byol_deployment_step WHERE deployment_id = $1::uuid ORDER BY step_order ASC',
    deployment.id,
  )
  deployment.steps = rows.map(mapStep)
  return deployment
}

/** All deployment runs for an infrastructure (newest first), each with its steps. */
export async function listDeployments(
  db: PlatformDatabaseClient,
  infrastructureId: string,
): Promise<ByolDeploymentDto[]> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM splunk_byol_deployment WHERE infrastructure_id = $1::uuid ORDER BY started_at DESC',
    infrastructureId,
  )
  return Promise.all(rows.map((r) => attachSteps(db, mapDeployment(r))))
}

/** The most recent deployment run for an infrastructure (with steps), or null. */
export async function getLatestDeployment(
  db: PlatformDatabaseClient,
  infrastructureId: string,
): Promise<ByolDeploymentDto | null> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM splunk_byol_deployment WHERE infrastructure_id = $1::uuid ORDER BY started_at DESC LIMIT 1',
    infrastructureId,
  )
  return rows[0] ? attachSteps(db, mapDeployment(rows[0])) : null
}

/** Advance one step of a deployment run by key. Terminal states stamp completed_at. */
export async function advanceStep(
  db: PlatformDatabaseClient,
  deploymentId: string,
  stepKey: string,
  status: 'pending' | 'running' | 'done' | 'failed',
  logs?: string | null,
): Promise<boolean> {
  const setStarted = status === 'running' ? ', started_at = COALESCE(started_at, now())' : ''
  const setCompleted = status === 'done' || status === 'failed' ? ', completed_at = now()' : ''
  const affected = await db.$executeRawUnsafe(
    `UPDATE splunk_byol_deployment_step
       SET status = $3, logs = COALESCE($4, logs), updated_at = now()${setStarted}${setCompleted}
     WHERE deployment_id = $1::uuid AND step_key = $2`,
    deploymentId,
    stepKey,
    status,
    logs ?? null,
  )
  return affected > 0
}

/** Close out a deployment run. Terminal states stamp completed_at. */
export async function setDeploymentStatus(
  db: PlatformDatabaseClient,
  deploymentId: string,
  status: 'running' | 'succeeded' | 'failed' | 'cancelled',
  message?: string | null,
): Promise<void> {
  const setCompleted = status === 'running' ? '' : ', completed_at = now()'
  await db.$executeRawUnsafe(
    `UPDATE splunk_byol_deployment SET status = $2, message = COALESCE($3, message), updated_at = now()${setCompleted}
     WHERE id = $1::uuid`,
    deploymentId,
    status,
    message ?? null,
  )
}

/**
 * Reconcile the persisted plan + latest run to a terminal outcome from a coarse
 * worker signal: on success every resource is ready and every step done; on
 * failure the latest run is marked failed. Best-effort, no-op if nothing exists.
 */
export async function reconcileTerminal(
  db: PlatformDatabaseClient,
  infrastructureId: string,
  outcome: 'succeeded' | 'failed' | 'destroyed',
): Promise<void> {
  const latest = await getLatestDeployment(db, infrastructureId)
  if (outcome === 'succeeded') {
    await setAllResourceStatuses(db, infrastructureId, 'ready')
    if (latest) {
      for (const step of latest.steps) {
        if (step.status !== 'done') await advanceStep(db, latest.id, step.key, 'done')
      }
      await setDeploymentStatus(db, latest.id, 'succeeded')
    }
  } else if (outcome === 'destroyed') {
    // A successful teardown: the run + its steps are done, but the resources no
    // longer exist. Reset them to 'not_started' so a later re-deploy re-provisions
    // from scratch (they must NOT read as 'ready' — that's a live-infra signal).
    await setAllResourceStatuses(db, infrastructureId, 'not_started')
    if (latest) {
      for (const step of latest.steps) {
        if (step.status !== 'done') await advanceStep(db, latest.id, step.key, 'done')
      }
      await setDeploymentStatus(db, latest.id, 'succeeded')
    }
  } else {
    // Mark every resource that did not reach 'ready' as 'failed' so the plan diff
    // treats them as needing re-provision (needsReplan) — otherwise they stay in
    // 'provisioning' and a retry sees "no changes" and can't re-apply.
    await db.$executeRawUnsafe(
      "UPDATE splunk_byol_resource SET status = 'failed', updated_at = now() WHERE infrastructure_id = $1::uuid AND status <> 'ready'",
      infrastructureId,
    )
    if (latest) {
      const running = latest.steps.find((s) => s.status === 'running')
      if (running) await advanceStep(db, latest.id, running.key, 'failed')
      await setDeploymentStatus(db, latest.id, 'failed')
    }
  }
}
