import type { AppEventPublisher, AppRouteContext, PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import * as store from './db'
import type { PolicyAccountDto, PolicyDto, RunDto } from './db'
import type { Enforcement } from './model/types'
import {
  RUN_ACTION, RUN_CANCEL_REQUESTED, RUN_MATCH, RUN_REQUESTED, RUN_STATUS,
  type RunActionPayload, type RunCancelPayload, type RunKind, type RunMatchPayload, type RunRequestedPayload, type RunStatusPayload,
} from './runner/contract'

export type LifecycleContext = Pick<AppRouteContext, 'db' | 'events' | 'appId'>

export const lifecycleError = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode })

export async function atomic<T>(db: PlatformDatabaseClient, work: (db: PlatformDatabaseClient) => Promise<T>): Promise<T> {
  if (!db.transaction) throw lifecycleError('Upgrade the platform before running governance policies.', 503)
  return db.transaction(work)
}

const DEFAULT_MAX_RESOURCES = 100
const ENFORCEMENT_RANK: Record<Enforcement, number> = { observe: 0, notify: 1, ask: 2, auto: 3 }
const ACTING: Enforcement[] = ['ask', 'auto']
const STALE_DISPATCH_SQL = "(dispatched_at IS NULL OR dispatched_at < now() - interval '5 minutes')"

export interface RequestRunInput {
  policyId: string
  componentId: string
  kind: RunKind
  enforcement?: Enforcement
  requestedBy?: string | null
}

export interface RunRequestResult {
  run: RunDto
  dispatchPending: boolean
}

async function lockPolicyAccount(db: PlatformDatabaseClient, customerId: string, policyId: string, componentId: string): Promise<any | null> {
  const rows = await db.$queryRawUnsafe<any[]>(
    'SELECT * FROM cgov_policy_account WHERE customer_id = $1::uuid AND policy_id = $2::uuid AND component_id = $3::uuid FOR UPDATE',
    customerId, policyId, componentId)
  return rows[0] ?? null
}

export function assertIdle(account: { active_run_id?: string | null }): void {
  if (account.active_run_id) throw lifecycleError('A run is already in progress for this policy and account. Follow its Activity before trying again.')
}

function resolveEnforcement(policy: PolicyDto, kind: RunKind, requested?: Enforcement): Enforcement {
  if (kind === 'preview') return 'observe'
  if (policy.actionClass === 'irreversible') throw lifecycleError('Irreversible actions cannot be enforced yet; preview only')
  if (!ACTING.includes(policy.enforcement)) throw lifecycleError('This policy is observe/notify only; raise its enforcement to ask or auto to enforce.', 400)
  const enforcement = requested ?? policy.enforcement
  if (!ACTING.includes(enforcement)) throw lifecycleError('An enforce run requires enforcement ask or auto.', 400)
  if (ENFORCEMENT_RANK[enforcement] > ENFORCEMENT_RANK[policy.enforcement]) {
    throw lifecycleError('A run cannot use stronger enforcement than the policy itself.', 400)
  }
  if (enforcement === 'ask') throw lifecycleError('Policies set to ask need the per-run approval gate, which is not available yet; run a preview or set enforcement to auto')
  return enforcement
}

function buildPayload(runId: string, customerId: string, policy: PolicyDto, account: PolicyAccountDto, input: RequestRunInput, enforcement: Enforcement): RunRequestedPayload {
  return {
    runId, customerId, policyId: policy.id, policyName: policy.name, componentId: input.componentId, provider: policy.model.provider,
    accountRef: account.accountRef, regions: policy.model.provider === 'azure' ? [] : account.regions, ownerTagKeys: policy.model.ownerTagKeys ?? [], kind: input.kind, enforcement, actionClass: policy.actionClass,
    compiledYaml: policy.compiledYaml as string, maxResources: policy.model.maxResources ?? DEFAULT_MAX_RESOURCES,
    requestedBy: input.requestedBy ?? null, requestedAt: new Date().toISOString(),
  }
}

export async function dispatchCommand(db: PlatformDatabaseClient, events: AppEventPublisher, runId: string): Promise<void> {
  const rows = await db.$queryRawUnsafe<any[]>(
    "SELECT id, command_payload FROM cgov_run WHERE id = $1::uuid AND status IN ('queued', 'running')", runId)
  const row = rows[0]
  if (!row?.command_payload) return
  await events.publish(RUN_REQUESTED, row.command_payload)
  await store.markRunDispatched(db, runId)
}

export async function requestRun(ctx: LifecycleContext, customerId: string, input: RequestRunInput): Promise<RunRequestResult> {
  const created = await atomic(ctx.db, async db => {
    const policy = await store.getPolicy(db, customerId, input.policyId)
    if (!policy) throw lifecycleError('Policy not found', 404)
    let locked = await lockPolicyAccount(db, customerId, policy.id, input.componentId)
    if (!locked) {
      await store.upsertPolicyAccount(db, customerId, { policyId: policy.id, componentId: input.componentId })
      locked = await lockPolicyAccount(db, customerId, policy.id, input.componentId)
    }
    if (!locked) throw lifecycleError('Policy account not found', 404)
    assertIdle(locked)
    if (!policy.compiledYaml) throw lifecycleError('This policy has no compiled definition. Fix its validation errors and save it first.', 400)
    const account = store.mapPolicyAccount(locked)
    const enforcement = resolveEnforcement(policy, input.kind, input.enforcement)
    const runId = globalThis.crypto.randomUUID()
    const run = await store.createRun(db, customerId, {
      id: runId, policyId: policy.id, policyAccountId: account.id, componentId: input.componentId, kind: input.kind,
      enforcement, actionClass: policy.actionClass, requestedBy: input.requestedBy,
      commandPayload: buildPayload(runId, customerId, policy, account, input, enforcement),
    })
    await db.$executeRawUnsafe('UPDATE cgov_policy_account SET active_run_id = $2::uuid WHERE id = $1::uuid', account.id, run.id)
    return run
  })
  let dispatchPending = false
  try { await dispatchCommand(ctx.db, ctx.events, created.id) }
  catch (error) {
    dispatchPending = true
    console.error('[cloud-governance] Run command persisted; dispatch will retry', { runId: created.id, error: error instanceof Error ? error.message : String(error) })
  }
  const run = (await store.getRun(ctx.db, customerId, created.id)) ?? created
  return { run, dispatchPending }
}

export async function cancelRun(ctx: LifecycleContext, customerId: string, runId: string): Promise<RunDto> {
  const outcome = await atomic(ctx.db, async db => {
    const run = await store.getRun(db, customerId, runId)
    if (!run) throw lifecycleError('Run not found', 404)
    if (store.isTerminalStatus(run.status)) throw lifecycleError('This run has already finished.')
    const account = await lockPolicyAccount(db, customerId, run.policyId, run.componentId)
    if (!account || account.active_run_id !== run.id) throw lifecycleError('This run is no longer active.')
    if (!run.dispatchedAt) {
      await store.setRunStatus(db, customerId, run.id, { status: 'cancelled', message: 'Cancelled before dispatch.' })
      await db.$executeRawUnsafe('UPDATE cgov_policy_account SET active_run_id = NULL WHERE id = $1::uuid', account.id)
      return { run: { ...run, status: 'cancelled' as const }, publish: false }
    }
    return { run, publish: true }
  })
  if (outcome.publish) {
    const payload: RunCancelPayload = { runId, customerId, policyId: outcome.run.policyId, requestedBy: null }
    await ctx.events.publish(RUN_CANCEL_REQUESTED, payload)
  }
  return outcome.run
}

type RunnerPayload = RunStatusPayload | RunMatchPayload | RunActionPayload

async function lockAccountOfRun(db: PlatformDatabaseClient, customerId: string, runId: string): Promise<any | null> {
  const rows = await db.$queryRawUnsafe<any[]>(
    `SELECT a.* FROM cgov_policy_account a JOIN cgov_run r ON r.policy_account_id = a.id
     WHERE r.id = $1::uuid AND r.customer_id = $2::uuid FOR UPDATE OF a`, runId, customerId)
  return rows[0] ?? null
}

async function applyStatus(db: PlatformDatabaseClient, customerId: string, account: any, run: RunDto, payload: RunStatusPayload): Promise<void> {
  if (payload.status === 'running') {
    await store.setRunStatus(db, customerId, run.id, { status: 'running', startedAt: payload.startedAt })
    return
  }
  if (!store.isTerminalStatus(payload.status)) return
  await store.setRunStatus(db, customerId, run.id, {
    status: payload.status, evaluation: payload.evaluation, message: payload.message, counts: payload.counts,
    startedAt: payload.startedAt, finishedAt: payload.finishedAt,
  })
  await db.$executeRawUnsafe(
    'UPDATE cgov_policy_account SET active_run_id = NULL, applied_at = CASE WHEN $2::boolean THEN now() ELSE applied_at END WHERE id = $1::uuid',
    account.id, payload.status === 'succeeded')
}

export async function handleRunnerEvent(ctx: LifecycleContext & { customerId: string }, topic: string, payload: RunnerPayload): Promise<void> {
  const runId = payload?.runId
  if (!runId || ![RUN_STATUS, RUN_MATCH, RUN_ACTION].includes(topic)) return
  const { customerId } = ctx
  await atomic(ctx.db, async db => {
    const account = await lockAccountOfRun(db, customerId, runId)
    if (!account || account.active_run_id !== runId) return
    const run = await store.getRun(db, customerId, runId)
    if (!run || run.policyId !== payload.policyId || store.isTerminalStatus(run.status)) return
    if (topic === RUN_MATCH) await store.addMatches(db, customerId, runId, (payload as RunMatchPayload).resources ?? [])
    else if (topic === RUN_ACTION) await store.addAction(db, customerId, payload as RunActionPayload)
    else await applyStatus(db, customerId, account, run, payload as RunStatusPayload)
  })
}

export async function reconcile(ctx: LifecycleContext, customerId: string): Promise<number> {
  const pending = await ctx.db.$queryRawUnsafe<any[]>(
    `SELECT id FROM cgov_run WHERE customer_id = $1::uuid AND command_payload IS NOT NULL AND started_at IS NULL
       AND status IN ('queued', 'running') AND ${STALE_DISPATCH_SQL} ORDER BY created_at LIMIT 50`, customerId)
  let redispatched = 0
  for (const row of pending) {
    try { await dispatchCommand(ctx.db, ctx.events, row.id); redispatched++ }
    catch (error) { console.error('[cloud-governance] Reconcile dispatch failed', { runId: row.id, error: error instanceof Error ? error.message : String(error) }) }
  }
  return redispatched
}
