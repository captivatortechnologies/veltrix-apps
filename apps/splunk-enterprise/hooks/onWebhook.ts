import type { AppWebhookContext } from '@veltrixsecops/app-sdk'

/** Cloud provisioning is reconciled only through host-authored run identities.
 * GitHub deployment notifications do not prove cloud deletion or Splunk health. */
export default async function onWebhook({ source, event, payload }: AppWebhookContext): Promise<void> {
  if (source === 'github' && event === 'deployment' && payload?.infrastructureId) {
    console.warn('[splunk-enterprise] Ignoring legacy deployment webhook; use the provisioning worker status channel', {
      infrastructureId: payload.infrastructureId, status: payload.status,
    })
  }
}
