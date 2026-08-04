import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, getJson, sendJson, withSession } from '../../lib/beyondtrustApi'
import {
  buildCreateBody,
  findManagedSystem,
  findWorkgroupByName,
  listFrom,
  str,
  workgroupIdOf,
  type ManagedSystem,
  type WorkgroupRef,
} from './_shared'

/**
 * Deploy Password Safe managed systems over the BeyondInsight REST API inside a
 * PS-Auth session, scoped to an EXISTING workgroup (resolved by name):
 *   resolve parent: GET  /Workgroups                              → match by name
 *   read (identity): GET  /ManagedSystems                         → match by (workgroup, system name)
 *   create:          POST /Workgroups/{workgroupId}/ManagedSystems with the system body
 *
 * Password Safe has NO confirmed update (PUT) endpoint for a managed system
 * created this way, so this is a create-if-absent upsert: a system already
 * present on its (workgroup, system name) identity is left untouched and
 * reported.
 *
 * rollbackData records, per system, the resolved workgroup id and whether WE
 * created it, so rollback can report exactly what it cannot safely undo (see
 * rollback.ts — there is no confirmed delete endpoint for a managed system).
 *
 * NOTE: verify /Workgroups/{id}/ManagedSystems create + /ManagedSystems list
 * against a live BeyondTrust instance. Some platforms require fields beyond
 * what this config type models — verify against your target platform.
 */
interface RollbackEntry {
  workgroupName: string
  systemName: string
  managedSystemId: number | string | null
  action: 'created' | 'existing'
}

async function listWorkgroups(base: string, cookie: string): Promise<WorkgroupRef[]> {
  try {
    return listFrom<WorkgroupRef>(await getJson<unknown>(base, '/Workgroups', cookie))
  } catch {
    return []
  }
}

async function listManagedSystems(base: string, cookie: string): Promise<ManagedSystem[]> {
  try {
    return listFrom<ManagedSystem>(await getJson<unknown>(base, '/ManagedSystems', cookie))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for managed system deployment' }
  }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)
  const previous: RollbackEntry[] = []
  const created: string[] = []
  const existing: string[] = []

  try {
    await withSession(base, credential, async (cookie) => {
      const workgroups = await listWorkgroups(base, cookie)
      const liveSystems = await listManagedSystems(base, cookie)

      for (const item of items) {
        const workgroupName = str(item.fields.workgroupName)
        const systemName = str(item.fields.systemName)
        if (!workgroupName || !systemName) continue

        const workgroup = findWorkgroupByName(workgroups, workgroupName)
        if (!workgroup) {
          throw new Error(
            `Workgroup "${workgroupName}" was not found — create it first via the Workgroups config type, or verify the name.`,
          )
        }
        const workgroupId = workgroupIdOf(workgroup)
        if (workgroupId == null) {
          throw new Error(`Workgroup "${workgroupName}" has no id in the API response.`)
        }

        const label = `${workgroupName}/${systemName}`
        const match = findManagedSystem(liveSystems, workgroupId, systemName)

        if (match && match.ManagedSystemID != null) {
          existing.push(label)
          previous.push({ workgroupName, systemName, managedSystemId: match.ManagedSystemID, action: 'existing' })
          continue
        }

        const body = buildCreateBody(item.fields)
        const res = await sendJson<ManagedSystem>(
          'POST',
          base,
          `/Workgroups/${encodeURIComponent(String(workgroupId))}/ManagedSystems`,
          cookie,
          body,
        )
        created.push(label)
        previous.push({ workgroupName, systemName, managedSystemId: res?.ManagedSystemID ?? null, action: 'created' })
      }
    })

    const parts: string[] = []
    if (created.length) parts.push(`${created.length} created`)
    if (existing.length) parts.push(`${existing.length} already present (no update endpoint — delete & recreate to change)`)
    return {
      success: true,
      message: `Managed systems: ${parts.join(', ') || '(none)'}`,
      artifacts: { created, existing },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Managed system deploy failed after ${created.length} created: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { created, existing },
      rollbackData: { previous },
    }
  }
}
