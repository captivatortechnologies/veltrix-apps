import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { rubrikConnect, getJson, sendJson, MISSING_CREDENTIAL_MESSAGE, resolveServiceAccount } from '../../lib/rubrikApi'
import { buildSlaBody, slaDomainsFromList, findSlaByName, normalizeName, type RubrikSlaDomain } from './_shared'

/**
 * Deploy Rubrik SLA Domains over the CDM v2 REST API:
 *   read (rollback): GET   /api/v2/sla_domain          -> find the live SLA by name
 *   create:          POST  /api/v2/sla_domain           with the SLA body
 *   update:          PATCH /api/v2/sla_domain/{id}       with the SLA body (SLA exists)
 *
 * The SLA Domain name is the stable identity used to upsert. rollbackData records,
 * per SLA, whether it existed, its id, and the prior body — so rollback can restore
 * the prior policy or delete the one we created.
 *
 * NOTE: verify /api/v2/sla_domain create/patch shapes against a live Rubrik CDM.
 */
interface RollbackEntry {
  name: string
  existed: boolean
  id: string | null
  prior: RubrikSlaDomain | null
}

/** Read every live SLA Domain (best-effort) for identity matching + snapshots. */
async function listSlaDomains(conn: Awaited<ReturnType<typeof rubrikConnect>>): Promise<RubrikSlaDomain[]> {
  try {
    return slaDomainsFromList(await getJson<unknown>(conn, '/api/v2/sla_domain'))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!resolveServiceAccount(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch (error) {
    return { success: false, message: `Rubrik connection failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  try {
    const live = await listSlaDomains(conn)

    for (const item of items) {
      const name = normalizeName(item.fields.name)
      if (!name) continue

      const existing = findSlaByName(live, name)
      const body = buildSlaBody(item.fields)

      if (existing && existing.id) {
        await sendJson(conn, 'PATCH', `/api/v2/sla_domain/${encodeURIComponent(existing.id)}`, body)
        previous.push({ name, existed: true, id: existing.id, prior: existing })
      } else {
        const created = await sendJson<RubrikSlaDomain>(conn, 'POST', '/api/v2/sla_domain', body)
        previous.push({ name, existed: false, id: created?.id ?? null, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} SLA Domain(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { base: conn.base, applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `SLA Domain deploy failed after ${applied.length} of ${items.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { base: conn.base, applied },
      rollbackData: { previous },
    }
  }
}
