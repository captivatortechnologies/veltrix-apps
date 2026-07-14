import type { AppEventContext } from '@veltrixsecops/app-sdk'
import * as store from '../lib/db'

/**
 * Deployment status from the provisioning pipeline → BYOL infrastructure status.
 * Preserves the mapping that used to live in the platform's rabbitmq.service:
 * completed → active, failed → error, everything else passes through unchanged.
 */
const DEPLOY_STATUS_MAP: Record<string, string> = {
  completed: 'active',
  failed: 'error',
}

/**
 * Inbound message-bus event handler. The platform routes bus events here; this
 * app acts only on 'deployment.status' events carrying a known BYOL
 * infrastructure id, mapping the deployment status onto the infrastructure's
 * status. Anything else is ignored.
 */
export default async function onEvent({ db, topic, payload }: AppEventContext): Promise<void> {
  if (topic !== 'deployment.status') return

  const infrastructureId = payload?.infrastructureId
  const rawStatus = payload?.status
  if (!infrastructureId || !rawStatus) return

  const mapped = DEPLOY_STATUS_MAP[String(rawStatus).toLowerCase()] ?? String(rawStatus)
  const updated = await store.setByolStatusIfExists(db, infrastructureId, mapped)
  if (!updated) {
    console.warn(`[splunk-enterprise] onEvent: no BYOL infrastructure ${infrastructureId}; skipped`)
  }
}
