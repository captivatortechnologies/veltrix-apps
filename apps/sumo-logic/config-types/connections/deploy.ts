import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, listPaged, sendJson } from '../../lib/sumoLogicApi'
import { buildConnectionBody, definitionTypeToConnectionType, findConnection, type Connection } from './_shared'

/**
 * Deploy Sumo Logic connections over the Management API (HTTPS):
 *   read (upsert/rollback): GET  /connections            → { data: [...], next } (paged)
 *   create:                 POST /connections            with a *Definition body
 *   update:                 PUT  /connections/<id>        with a *Definition body (id lives in the path)
 *
 * The connection NAME is the stable identity used to upsert. Only Webhook and
 * ServiceNow connections accept full CRUD via this API (see _shared.ts).
 * rollbackData records, per connection, a SECRET-SAFE prior snapshot (see
 * buildConnectionRestoreBody — authorization headers / ServiceNow password are
 * never echoed back by Sumo Logic) AND the connection id — so rollback can
 * restore the prior non-secret body or delete the one we created.
 *
 * API: https://www.sumologic.com/help/docs/api/connection-management/
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for connection deployment' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  const previous: Array<{ name: string; connectionId: string | null; connectionType: string; connection: Connection | null }> = []
  const applied: string[] = []

  let live: Connection[] = []
  try {
    live = await listPaged<Connection>(base, 'connections', headers)
  } catch {
    live = []
  }

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findConnection(live, name)
      const body = buildConnectionBody(item.fields)
      const connectionType = definitionTypeToConnectionType(String(body.type))

      if (existing && existing.id != null) {
        await sendJson('PUT', `${base}/connections/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ name, connectionId: String(existing.id), connectionType, connection: existing })
      } else {
        const created = await sendJson<Connection>('POST', `${base}/connections`, headers, body)
        previous.push({ name, connectionId: created?.id != null ? String(created.id) : null, connectionType, connection: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} connection(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Connection deploy failed after ${applied.length} connection(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
