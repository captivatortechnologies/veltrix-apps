import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, getJson, sendJson, withSession } from '../../lib/beyondtrustApi'
import {
  buildDirectoryBody,
  findDirectory,
  findWorkgroupByName,
  listFrom,
  str,
  workgroupIdOf,
  type Directory,
  type WorkgroupRef,
} from './_shared'

/**
 * Deploy Password Safe directories over the BeyondInsight REST API inside a
 * PS-Auth session, scoped to an EXISTING workgroup (resolved by name):
 *   resolve parent:  GET  /Workgroups                            → match by name
 *   read (identity): GET  /Directories                           → match by (workgroup, domain)
 *   create:          POST /Workgroups/{workgroupId}/Directories  with the directory body
 *   update:          PUT  /Directories/{id}                      with the directory body
 *
 * Password Safe DOES expose an update endpoint for a directory — this is a REAL
 * upsert. rollbackData records, per directory, the id and the FULL prior
 * representation for one we updated (so rollback can restore it), or null for
 * one we created (so rollback deletes it) — same shape as managed-accounts
 * (this app).
 *
 * NOTE: verify /Workgroups/{id}/Directories create + /Directories update
 * against a live BeyondTrust instance.
 */
interface RollbackEntry {
  workgroupName: string
  domainName: string
  directoryId: number | string | null
  previous: Directory | null
}

async function listWorkgroups(base: string, cookie: string): Promise<WorkgroupRef[]> {
  try {
    return listFrom<WorkgroupRef>(await getJson<unknown>(base, '/Workgroups', cookie))
  } catch {
    return []
  }
}

async function listDirectories(base: string, cookie: string): Promise<Directory[]> {
  try {
    return listFrom<Directory>(await getJson<unknown>(base, '/Directories', cookie))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for directory deployment' }
  }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)
  const previous: RollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    await withSession(base, credential, async (cookie) => {
      const workgroups = await listWorkgroups(base, cookie)
      const liveDirectories = await listDirectories(base, cookie)

      for (const item of items) {
        const workgroupName = str(item.fields.workgroupName)
        const domainName = str(item.fields.domainName)
        if (!workgroupName || !domainName) continue

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

        const label = `${workgroupName}/${domainName}`
        const match = findDirectory(liveDirectories, workgroupId, domainName)
        const body = buildDirectoryBody(item.fields)

        if (match?.DirectoryID != null) {
          const res = await sendJson<Directory>('PUT', base, `/Directories/${encodeURIComponent(String(match.DirectoryID))}`, cookie, body)
          updated.push(label)
          previous.push({ workgroupName, domainName, directoryId: res?.DirectoryID ?? match.DirectoryID, previous: match })
        } else {
          const res = await sendJson<Directory>(
            'POST',
            base,
            `/Workgroups/${encodeURIComponent(String(workgroupId))}/Directories`,
            cookie,
            body,
          )
          created.push(label)
          previous.push({ workgroupName, domainName, directoryId: res?.DirectoryID ?? null, previous: null })
        }
      }
    })

    const parts: string[] = []
    if (created.length) parts.push(`${created.length} created`)
    if (updated.length) parts.push(`${updated.length} updated`)
    return {
      success: true,
      message: `Directories: ${parts.join(', ') || '(none)'}`,
      artifacts: { created, updated },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Directory deploy failed after ${created.length} created, ${updated.length} updated: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { created, updated },
      rollbackData: { previous },
    }
  }
}
