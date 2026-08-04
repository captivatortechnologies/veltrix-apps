import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, sendJson, listOrganisations, PRIMARY } from '../../lib/thehiveApi'
import {
  buildOrganisationCreateBody,
  buildOrganisationUpdateBody,
  findOrganisation,
  organisationId,
  organisationsFromList,
  type Organisation,
} from './_shared'

/**
 * Deploy TheHive organisations over the REST API:
 *   read (rollback): list organisations         → find the live one by name
 *   create:          POST  /api/v1/organisation   with InputOrganisation
 *   update:          PATCH /api/v1/organisation/<id> with InputUpdateOrganisation (no name)
 *
 * The name is the stable identity used to upsert. rollbackData records, per
 * organisation, the prior body (null when it did not exist) AND the id — so
 * rollback can restore the prior description/rules, or — for one it created —
 * LOCK it (TheHive has no delete endpoint for organisations; see _shared.ts).
 *
 * The same /api/v1/organisation path is used on both TheHive versions (see
 * lib/thehiveApi.ts). Verify against a live TheHive (see README, v4 vs v5).
 */
async function listAll(base: string, headers: Record<string, string>): Promise<Organisation[]> {
  try {
    return organisationsFromList(await listOrganisations<Organisation>(base, headers))
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

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; orgId: string | null; org: Organisation | null }> = []
  const applied: string[] = []

  try {
    const live = await listAll(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findOrganisation(live, name)
      const existingId = organisationId(existing)

      if (existing && existingId) {
        await sendJson('PATCH', `${base}${PRIMARY.organisationById(existingId)}`, headers, buildOrganisationUpdateBody(item.fields))
        previous.push({ name, orgId: existingId, org: existing })
      } else {
        const created = await sendJson<Organisation>('POST', `${base}${PRIMARY.organisation}`, headers, buildOrganisationCreateBody(item.fields))
        previous.push({ name, orgId: organisationId(created), org: null })
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
      message: `Organisation deploy failed after ${applied.length} organisation(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
