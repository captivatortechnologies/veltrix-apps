import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson, sendJson } from '../../lib/mispApi'
import { buildOrganisationFields, organisationsFromList, findOrganisation, type MispOrganisation } from './_shared'

/**
 * Deploy MISP organisations over the REST API (443):
 *   read (rollback): GET  /organisations                → find the live org by name
 *   create:          POST /admin/organisations/add       with { Organisation: {...} }
 *   update:          POST /admin/organisations/edit/<id>  with { Organisation: {...} } (org exists)
 *
 * The name is the stable identity used to upsert. rollbackData records, per org,
 * the prior organisation body (null when it did not exist) AND the org id — so
 * rollback can restore the prior body, or leave a newly created org in place (org
 * creation over this seam has no simple delete).
 *
 * NOTE: verify /organisations + /admin/organisations/add + /admin/organisations/edit/<id>
 * against a live MISP 2.4 instance.
 */
interface OrganisationMutationResponse {
  Organisation?: MispOrganisation
}

async function listOrganisations(base: string, headers: Record<string, string>): Promise<MispOrganisation[]> {
  try {
    return organisationsFromList(await getJson<unknown>(`${base}/organisations`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for organisation deployment' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; orgId: number | string | null; org: MispOrganisation | null }> = []
  const applied: string[] = []

  try {
    const live = await listOrganisations(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findOrganisation(live, name)
      const body = { Organisation: buildOrganisationFields(item.fields) }

      if (existing && existing.id != null) {
        await sendJson('POST', `${base}/admin/organisations/edit/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ name, orgId: existing.id, org: existing })
      } else {
        const created = await sendJson<OrganisationMutationResponse>('POST', `${base}/admin/organisations/add`, headers, body)
        const newId = created?.Organisation?.id ?? null
        previous.push({ name, orgId: newId, org: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} organisation(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Organisation deploy failed after ${applied.length} org(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
