import type { AppWebhookContext } from '@veltrixsecops/app-sdk'
import * as store from '../lib/db'

/**
 * GitHub deployment status → BYOL infrastructure status. This mapping (and the
 * decision to act on it at all) used to live in the platform's webhook/rabbitmq
 * services; it is Splunk provisioning semantics and now belongs to the app.
 */
const STATUS_MAP: Record<string, string> = {
  pending: 'provisioning',
  in_progress: 'provisioning',
  queued: 'provisioning',
  success: 'running',
  completed: 'running',
  failure: 'error',
  error: 'error',
  inactive: 'stopped',
  stopped: 'stopped',
}

/**
 * Inbound webhook handler. The platform routes ALL webhooks here; this app only
 * acts on GitHub deployment-status events that carry a known BYOL infrastructure
 * id, mapping the deployment status onto the infrastructure's status. Anything
 * else is ignored.
 */
export default async function onWebhook({ db, source, event, payload }: AppWebhookContext): Promise<void> {
  if (source !== 'github' || event !== 'deployment') return

  const infrastructureId = payload?.infrastructureId
  const rawStatus = payload?.status
  if (!infrastructureId || !rawStatus) return

  const mapped = STATUS_MAP[String(rawStatus).toLowerCase()] ?? 'running'
  const updated = await store.setByolStatusIfExists(db, infrastructureId, mapped)
  if (!updated) {
    console.warn(`[splunk-enterprise] onWebhook: no BYOL infrastructure ${infrastructureId}; skipped`)
    return
  }

  // A GitHub deployment status is coarse (one terminal signal), so reconcile the
  // persisted resource plan + latest run to match: success → everything ready,
  // failure → mark the run failed.
  if (mapped === 'running') {
    await store.reconcileTerminal(db, infrastructureId, 'succeeded')
  } else if (mapped === 'error') {
    await store.reconcileTerminal(db, infrastructureId, 'failed')
  }
}
