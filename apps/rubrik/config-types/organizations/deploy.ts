import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { rubrikConnect, getJson, sendJson, MISSING_CREDENTIAL_MESSAGE, resolveServiceAccount } from '../../lib/rubrikApi'
import { buildOrganizationBody, organizationsFromList, findOrganizationByName, normalizeName, type RubrikOrganization } from './_shared'

/**
 * Deploy Rubrik Organizations over the CDM internal REST API:
 *   read:   GET  /api/internal/organization  -> find the live org by name
 *   create: POST /api/internal/organization    { name }
 *
 * The organization NAME is the stable identity used to upsert. There is no
 * verified rename/update endpoint (see _shared.ts), so an organization that
 * already exists is left untouched — only newly-declared names are created.
 * rollbackData records, per organization, whether it existed and its id, so
 * rollback can delete only the organizations this deploy created.
 */
interface RollbackEntry {
  name: string
  existed: boolean
  id: string | null
}

/** Read every live organization (best-effort) for identity matching + snapshots. */
async function listOrganizations(conn: Awaited<ReturnType<typeof rubrikConnect>>): Promise<RubrikOrganization[]> {
  try {
    return organizationsFromList(await getJson<unknown>(conn, '/api/internal/organization'))
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
    const live = await listOrganizations(conn)

    for (const item of items) {
      const name = normalizeName(item.fields.name)
      if (!name) continue

      const existing = findOrganizationByName(live, name)

      if (existing && existing.id) {
        previous.push({ name, existed: true, id: existing.id })
      } else {
        const created = await sendJson<RubrikOrganization>(conn, 'POST', '/api/internal/organization', buildOrganizationBody(item.fields))
        previous.push({ name, existed: false, id: created?.id ?? null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} organization(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { base: conn.base, applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Organization deploy failed after ${applied.length} of ${items.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { base: conn.base, applied },
      rollbackData: { previous },
    }
  }
}
