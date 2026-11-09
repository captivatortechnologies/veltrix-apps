import type { AppEventContext } from '@veltrixsecops/app-sdk'
import * as store from '../lib/db'
import { atomic, lockInfrastructure, dispatchCommand, requestOperation } from '../lib/byolLifecycle'
import { issueActivation } from '../lib/activationFlow'

/** Default platform console origin for activation links (overridable via the
 *  event payload or the VELTRIX_CONSOLE_URL env var). */
const DEFAULT_CONSOLE_URL = 'https://app.veltrixsecops.com'

/**
 * On a ready environment, mint a one-time activation link and enqueue the email
 * to the initiating admin. Never throws into the status handler — activation is
 * best-effort relative to the core status reconciliation. The initiating admin's
 * email must ride the deployment.status payload (adminEmail / initiatedByEmail);
 * without it we log and skip (no link can be addressed).
 */
async function tryIssueActivation(
  db: AppEventContext['db'],
  infrastructureId: string,
  payload: any,
): Promise<void> {
  try {
    const adminEmail: string | undefined = payload?.adminEmail ?? payload?.initiatedByEmail
    if (!adminEmail) {
      console.warn(
        `[splunk-enterprise] onEvent: ${infrastructureId} ready but no adminEmail in payload; activation link not sent`,
      )
      return
    }
    const infra = await store.getByolCore(db, infrastructureId)
    if (!infra) return
    await issueActivation(db, {
      customerId: infra.customerId,
      infrastructureId,
      environmentName: infra.name,
      adminUser: payload?.adminUser ?? 'admin',
      adminEmail,
      shUrl: payload?.shUrl ?? payload?.searchHeadUrl ?? null,
      consoleBaseUrl: payload?.consoleUrl ?? process.env.VELTRIX_CONSOLE_URL ?? DEFAULT_CONSOLE_URL,
      nowMs: Date.now(),
    })
  } catch (err) {
    console.error(`[splunk-enterprise] onEvent: activation issuance failed for ${infrastructureId}:`, err)
  }
}

/**
 * Deployment status from the provisioning pipeline → BYOL infrastructure status.
 * Preserves the mapping that used to live in the platform's rabbitmq.service:
 * completed → active, failed → error, everything else passes through unchanged.
 */
const DEPLOY_STATUS_MAP: Record<string, string> = {
  completed: 'active',
  failed: 'error',
}

/** Worker resource status → the app's resource status enum. */
const RESOURCE_STATUS_MAP: Record<string, string> = {
  completed: 'ready',
  success: 'ready',
  ready: 'ready',
  running: 'provisioning',
  provisioning: 'provisioning',
  pending: 'not_started',
  not_started: 'not_started',
  attention: 'attention',
  failed: 'failed',
  error: 'failed',
}

/**
 * Inbound message-bus event handler. The platform routes bus events here; this
 * app advances the app-owned BYOL provisioning state from worker signals:
 *
 *  • `deployment.status` — maps a coarse deploy status onto the infrastructure's
 *    status, and reconciles the persisted resources/run on terminal outcomes.
 *  • `resource.status`   — updates a single resource (by plan key).
 *  • `deployment.step`   — advances one step of the latest deployment run.
 *
 * Anything else is ignored.
 */
export default async function onEvent(ctx: AppEventContext): Promise<void> {
  const { db, topic, payload, customerId } = ctx
  if (!customerId) throw new Error('Provisioning events require a verified tenant')
  if (topic === 'provisioning.reconcile') {
    if (!ctx.events) throw new Error('Provisioning publisher unavailable')
    const pending = await db.$queryRawUnsafe<any[]>(
      "SELECT id FROM splunk_byol_deployment WHERE customer_id = $1::uuid AND status = 'running' AND command_payload IS NOT NULL AND (dispatched_at IS NULL OR dispatched_at < now() - interval '5 minutes') ORDER BY started_at LIMIT 50", customerId)
    for (const row of pending) await dispatchCommand(db, ctx.events, row.id)
    return
  }
  const infrastructureId = payload?.infrastructureId
  if (!infrastructureId) return
  if (topic === 'provisioning.destroy.requested') {
    // Only the host dispatches this scoped hook; it shares the API's atomic lifecycle.
    const existing = await store.getByol(db, infrastructureId, customerId)
    if (!existing || existing.status === 'deprovisioned' || existing.status === 'destroying') return
    if (existing.status === 'provisioning') throw new Error('Wait for the current run before billing teardown')
    if (!ctx.events) throw new Error('Provisioning publisher unavailable')
    await requestOperation({ ...ctx, events: ctx.events }, customerId, infrastructureId, 'destroy')
    return
  }
  if (!payload?.deploymentId) {
    console.warn('[splunk-enterprise] Ignoring uncorrelated provisioning status', { infrastructureId, topic })
    return
  }
  let activate = false
  let release = false
  let activationPayload: any
  await atomic(db, async tx => {
    const row = await lockInfrastructure(tx, infrastructureId, customerId)
    if (!row || row.active_deployment_id !== payload.deploymentId) return
    const runs = await tx.$queryRawUnsafe<any[]>(
      'SELECT * FROM splunk_byol_deployment WHERE id = $1::uuid AND infrastructure_id = $2::uuid', payload.deploymentId, infrastructureId)
    const run = runs[0]
    if (!run || (payload.action && payload.action !== run.action)) return
    // Retry cleanup even if the terminal status was already committed.
    if (run.status === 'succeeded' && run.action === 'destroy') { release = true; return }
    if (run.status !== 'running') return
    const raw = String(payload.status ?? '').toLowerCase()
    if (topic === 'resource.status') {
      const status = RESOURCE_STATUS_MAP[raw]
      if (payload.planKey && status) await store.setResourceStatus(tx, infrastructureId, payload.planKey, status, {
        externalRef: payload.externalRef, message: payload.message,
      })
      return
    }
    if (topic === 'deployment.step') {
      if (!payload.stepKey || !['pending', 'running', 'done', 'failed'].includes(raw)) return
      // Bring-up phases are discovered by the worker; persist them in the same run.
      await tx.$executeRawUnsafe(
        `INSERT INTO splunk_byol_deployment_step (deployment_id, step_order, step_key, title, customer_id)
         SELECT id, 100, $2, $2, customer_id FROM splunk_byol_deployment WHERE id = $1::uuid
         ON CONFLICT (deployment_id, step_key) DO NOTHING`, run.id, payload.stepKey)
      await store.advanceStep(tx, run.id, payload.stepKey, raw as any, payload.logs)
      return
    }
    if (topic !== 'deployment.status' || !['completed', 'deprovisioned', 'failed', 'error'].includes(raw)) return
    if (raw === 'deprovisioned' && run.action !== 'destroy') return
    const failed = raw === 'failed' || raw === 'error'
    const destroyed = !failed && run.action === 'destroy'
    await store.setByolStatusIfExists(tx, infrastructureId, failed ? 'error' : destroyed ? 'deprovisioned' : 'active')
    await store.reconcileTerminal(tx, infrastructureId, failed ? 'failed' : destroyed ? 'destroyed' : 'succeeded')
    await store.setDeploymentStatus(tx, run.id, failed ? 'failed' : 'succeeded', payload.message)
    if (!destroyed) await tx.$executeRawUnsafe(
      'UPDATE splunk_byol_infrastructure SET active_deployment_id = NULL WHERE id = $1::uuid', infrastructureId)
    if (!failed && !destroyed) {
      const configuration = run.command_payload ?? row.applied_configuration
      const keys = (configuration?.plan ?? []).map((r: any) => r.planKey)
      await tx.$executeRawUnsafe('DELETE FROM splunk_byol_resource WHERE infrastructure_id = $1::uuid AND NOT (plan_key = ANY($2::text[]))', infrastructureId, keys)
      activate = true
      activationPayload = { ...configuration, ...payload }
    }
    release = destroyed
  })
  if (release) {
    if (!ctx.provisioning) throw new Error('Network cleanup service unavailable')
    await ctx.provisioning.releaseNetwork(infrastructureId)
    await db.$executeRawUnsafe(
      'UPDATE splunk_byol_infrastructure SET active_deployment_id = NULL, applied_configuration = NULL WHERE id = $1::uuid AND active_deployment_id = $2::uuid', infrastructureId, payload.deploymentId)
  }
  if (activate) await tryIssueActivation(db, infrastructureId, activationPayload)
}
