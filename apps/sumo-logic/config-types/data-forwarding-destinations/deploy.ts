import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, listPaged, sendJson } from '../../lib/sumoLogicApi'
import { buildDestinationCreateBody, buildDestinationUpdateBody, findDestination, type DataForwardingDestination } from './_shared'

/**
 * Deploy Sumo Logic data forwarding destinations over the Management API
 * (HTTPS):
 *   read (upsert/rollback): GET  /logsDataForwarding/destinations            → { data: [...], nextToken } (paged)
 *   create:                 POST /logsDataForwarding/destinations            with the full definition incl. bucketName
 *   update:                 PUT  /logsDataForwarding/destinations/<id>        with the mutable subset (bucketName is create-only)
 *
 * The destination NAME is the stable identity used to upsert. rollbackData
 * records, per destination, a SECRET-SAFE prior snapshot (see
 * buildDestinationRestoreBody — AWS credentials are never echoed back by Sumo
 * Logic, so they cannot be captured or restored) AND the destination id — so
 * rollback can restore the prior non-secret body or delete the one we created.
 *
 * API: https://help.sumologic.com/docs/api/data-forwarding/
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for data forwarding destination deployment' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  const previous: Array<{ destinationName: string; destinationId: string | null; destination: DataForwardingDestination | null }> = []
  const applied: string[] = []
  const immutableDrift: string[] = []

  let live: DataForwardingDestination[] = []
  try {
    live = await listPaged<DataForwardingDestination>(base, 'logsDataForwarding/destinations', headers, { nextTokenField: 'nextToken' })
  } catch {
    live = []
  }

  try {
    for (const item of items) {
      const destinationName = String(item.fields.destinationName ?? '').trim()
      if (!destinationName) continue

      const existing = findDestination(live, destinationName)

      if (existing && existing.id != null) {
        const declaredBucket = String(item.fields.bucketName ?? '').trim()
        if (declaredBucket && existing.bucketName && declaredBucket !== existing.bucketName.trim()) {
          immutableDrift.push(destinationName)
        }
        const body = buildDestinationUpdateBody(item.fields)
        await sendJson('PUT', `${base}/logsDataForwarding/destinations/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ destinationName, destinationId: String(existing.id), destination: existing })
      } else {
        const body = buildDestinationCreateBody(item.fields)
        const created = await sendJson<DataForwardingDestination>('POST', `${base}/logsDataForwarding/destinations`, headers, body)
        previous.push({ destinationName, destinationId: created?.id != null ? String(created.id) : null, destination: null })
      }
      applied.push(destinationName)
    }

    const driftNote = immutableDrift.length
      ? ` (note: bucket name differs from the live destination for ${immutableDrift.join(', ')} — Sumo Logic does not accept bucket changes on an existing destination; the live bucket was left unchanged)`
      : ''
    return {
      success: true,
      message: `Applied ${applied.length} data forwarding destination(s): ${applied.join(', ') || '(none)'}${driftNote}`,
      artifacts: { applied, immutableDrift },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Data forwarding destination deploy failed after ${applied.length} destination(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
