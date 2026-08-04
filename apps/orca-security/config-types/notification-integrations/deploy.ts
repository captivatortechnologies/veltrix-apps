import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import { dataFromEnvelope } from '../../lib/reconcile'
import {
  buildCreateBody,
  buildUpdateBody,
  SERVICES,
  type IntegrationEnvelope,
  type IntegrationRollbackData,
  type IntegrationRollbackEntry,
  type IntegrationService,
} from './_shared'

/**
 * Deploy Orca notification integrations over the REST API:
 *   read (identity + restore snapshot): GET  /api/external_service/config?service_name=&template_name=
 *   create:                             POST /api/external_service/config              -> { data: { id } }
 *   update:                             PUT  /api/external_service/config/{service}?template={templateName}
 *
 * UNLIKE every other config type in this app, identity is resolved LIVE by
 * (service, template_name) on every deploy — Orca's own lookup key — rather
 * than only from this app's rollbackData, because the API genuinely supports
 * that lookup for this resource (see _shared.ts). rollbackData still records
 * the server id + prior envelope so rollback can restore/delete directly.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const previous: IntegrationRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const itemId = item.id ?? ''
      const templateName = String(item.fields.templateName ?? '').trim()
      const service = String(item.fields.service ?? '').trim() as IntegrationService
      if (!templateName || !SERVICES.has(service)) continue

      const live = await findIntegration(client, service, templateName)

      if (live?.id) {
        const body = buildUpdateBody(service, item.fields)
        const res = await client.request<unknown>(
          'PUT',
          `/api/external_service/config/${encodeURIComponent(service)}?template=${encodeURIComponent(templateName)}`,
          body,
        )
        if (res.error) throw new Error(`update integration "${templateName}" (${service}) failed: ${res.error}`)
        previous.push({ itemId, name: templateName, service, serverId: live.id, existed: true, prior: live })
      } else {
        const body = buildCreateBody(service, templateName, item.fields)
        const res = await client.request<unknown>('POST', '/api/external_service/config', body)
        if (res.error) throw new Error(`create integration "${templateName}" (${service}) failed: ${res.error}`)
        const created = dataFromEnvelope<IntegrationEnvelope>(res.data)
        const newId = created?.id ?? null
        previous.push({ itemId, name: templateName, service, serverId: newId, existed: false, prior: null })
      }
      applied.push(`${templateName} (${service})`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} notification integration(s) to ${baseUrl}: ${applied.join(', ') || '(none)'}`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies IntegrationRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Notification integration deploy failed after ${applied.length} of ${items.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies IntegrationRollbackData,
    }
  }
}

/** GET the live integration by (service, template_name), or null when none matches. */
export async function findIntegration(
  client: OrcaClient,
  service: IntegrationService,
  templateName: string,
): Promise<IntegrationEnvelope | null> {
  const res = await client.request<{ data?: IntegrationEnvelope[] }>(
    'GET',
    `/api/external_service/config?service_name=${encodeURIComponent(service)}&template_name=${encodeURIComponent(templateName)}`,
  )
  if (res.error || !res.data) return null
  const list = Array.isArray(res.data.data) ? res.data.data : []
  return list[0] ?? null
}
