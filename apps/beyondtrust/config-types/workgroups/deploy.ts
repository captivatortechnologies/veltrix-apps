import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, getJson, sendJson, withSession } from '../../lib/beyondtrustApi'
import { buildCreateBody, findWorkgroup, str, workgroupsFromList, type Workgroup } from './_shared'

/**
 * Deploy BeyondInsight workgroups over the BeyondInsight REST API inside a
 * PS-Auth session:
 *   read (identity): GET  /Workgroups   → match by (case-insensitive) name
 *   create:          POST /Workgroups   with { Name, OrganizationID? }
 *
 * Password Safe has NO update (PUT) and NO delete (DELETE) endpoint for a
 * workgroup, so this is a create-if-absent upsert: a workgroup already present on
 * its name is left untouched and reported.
 *
 * rollbackData records, per workgroup, whether WE created it. Because there is no
 * delete endpoint, rollback cannot remove a created workgroup — it reports which
 * ones remain (see rollback.ts).
 *
 * NOTE: verify /Workgroups create + list against a live BeyondTrust instance.
 */
interface RollbackEntry {
  name: string
  action: 'created' | 'existing'
}

async function listWorkgroups(base: string, cookie: string): Promise<Workgroup[]> {
  try {
    return workgroupsFromList(await getJson<unknown>(base, '/Workgroups', cookie))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for workgroup deployment' }
  }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)
  const previous: RollbackEntry[] = []
  const created: string[] = []
  const existing: string[] = []

  try {
    await withSession(base, credential, async (cookie) => {
      const live = await listWorkgroups(base, cookie)

      for (const item of items) {
        const name = str(item.fields.name)
        if (!name) continue

        const match = findWorkgroup(live, name)
        if (match) {
          existing.push(name)
          previous.push({ name, action: 'existing' })
          continue
        }

        await sendJson<Workgroup>('POST', base, '/Workgroups', cookie, buildCreateBody(item.fields))
        created.push(name)
        previous.push({ name, action: 'created' })
      }
    })

    const parts: string[] = []
    if (created.length) parts.push(`${created.length} created`)
    if (existing.length) parts.push(`${existing.length} already present`)
    return {
      success: true,
      message: `Workgroups: ${parts.join(', ') || '(none)'}`,
      artifacts: { created, existing },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Workgroup deploy failed after ${created.length} created: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { created, existing },
      rollbackData: { previous },
    }
  }
}
