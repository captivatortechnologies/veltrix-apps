import type { AppEventContext } from '@veltrixsecops/app-sdk'
import * as store from '../lib/db'
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
export default async function onEvent({ db, topic, payload }: AppEventContext): Promise<void> {
  const infrastructureId = payload?.infrastructureId
  if (!infrastructureId) return

  if (topic === 'resource.status') {
    const planKey = payload?.planKey
    const rawStatus = payload?.status
    if (!planKey || !rawStatus) return
    const mapped = RESOURCE_STATUS_MAP[String(rawStatus).toLowerCase()] ?? String(rawStatus)
    await store.setResourceStatus(db, infrastructureId, planKey, mapped, {
      externalRef: payload?.externalRef ?? null,
      message: payload?.message ?? null,
    })
    return
  }

  if (topic === 'deployment.step') {
    const stepKey = payload?.stepKey
    const rawStatus = payload?.status
    if (!stepKey || !rawStatus) return
    const latest = await store.getLatestDeployment(db, infrastructureId)
    if (!latest) return
    const status = String(rawStatus).toLowerCase()
    if (status === 'pending' || status === 'running' || status === 'done' || status === 'failed') {
      await store.advanceStep(db, latest.id, stepKey, status, payload?.logs ?? null)
    }
    return
  }

  if (topic !== 'deployment.status') return

  const rawStatus = payload?.status
  if (!rawStatus) return

  const mapped = DEPLOY_STATUS_MAP[String(rawStatus).toLowerCase()] ?? String(rawStatus)
  const updated = await store.setByolStatusIfExists(db, infrastructureId, mapped)
  if (!updated) {
    console.warn(`[splunk-enterprise] onEvent: no BYOL infrastructure ${infrastructureId}; skipped`)
    return
  }

  // Reconcile the persisted plan + run on terminal outcomes so the detail view
  // stays coherent even from a single coarse worker signal.
  if (mapped === 'active' || mapped === 'running') {
    await store.reconcileTerminal(db, infrastructureId, 'succeeded')
    // Environment is ready → hand the admin credential off via a one-time link.
    await tryIssueActivation(db, infrastructureId, payload)
  } else if (mapped === 'error' || mapped === 'failed') {
    await store.reconcileTerminal(db, infrastructureId, 'failed')
  }
}
