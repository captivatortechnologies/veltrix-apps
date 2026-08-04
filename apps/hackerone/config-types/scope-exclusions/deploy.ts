import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, hackeroneWriteError, type HackerOneClient } from '../../lib/hackeroneApi'
import {
  buildExclusionAttributes,
  exclusionWriteBody,
  exclusionsByCategory,
  groupItemsByProgram,
  findProgramId,
  str,
  type LiveScopeExclusion,
  type ScopeExclusionAttributes,
} from './_shared'

/**
 * Deploy HackerOne Scope Exclusions over the HackerOne API (v1).
 *
 *   resolve program: GET  /me/programs                            → handle → id
 *   read (upsert):   GET  /programs/{id}/scope_exclusions         → exclusions by category
 *   create:          POST /programs/{id}/scope_exclusions         { data: { type, attributes } }
 *   update:          PUT  /programs/{id}/scope_exclusions/{id}    { data: { type, attributes } }
 *
 * Exclusions are grouped by program_handle, each handle resolved to its program
 * id, and each exclusion upserted by `category` (case-insensitive) WITHIN that
 * program. rollbackData records, per exclusion, whether it already existed, its
 * id, and the prior attributes — so rollback can restore the prior state or
 * delete what this deploy created.
 *   Confirmed: https://api.hackerone.com/customer-resources/ (Scope Exclusions)
 *   Required permission: Program Management.
 */
interface RollbackEntry {
  programHandle: string
  programId: string | null
  category: string
  exclusionId: string | null
  existed: boolean
  previousAttributes: Partial<ScopeExclusionAttributes> | null
}

/** Read every live scope exclusion for a program (best-effort). */
async function listExclusions(client: HackerOneClient, programId: string): Promise<LiveScopeExclusion[]> {
  try {
    const res = await client.getAll<Partial<ScopeExclusionAttributes>>(`/programs/${encodeURIComponent(programId)}/scope_exclusions`)
    return res.ok ? res.items : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for scope-exclusion deployment' }
  }

  const built = buildHackeroneClient(credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: RollbackEntry[] = []
  const applied: string[] = []
  const failures: string[] = []

  const programsRes = await client.listPrograms()
  if (!programsRes.ok) {
    return {
      success: false,
      message: `Could not list HackerOne programs (GET /me/programs → HTTP ${programsRes.status}). Check the API credential.`,
    }
  }
  const programs = programsRes.items

  for (const [handle, groupItems] of groupItemsByProgram(items)) {
    const programId = findProgramId(programs, handle)
    if (!programId) {
      failures.push(`program "${handle}": not found among the credential's programs (GET /me/programs)`)
      for (const item of groupItems) {
        previous.push({
          programHandle: handle,
          programId: null,
          category: str(item.fields.category),
          exclusionId: null,
          existed: false,
          previousAttributes: null,
        })
      }
      continue
    }

    const live = exclusionsByCategory(await listExclusions(client, programId))

    for (const item of groupItems) {
      const category = str(item.fields.category)
      if (!category) continue

      const attributes = buildExclusionAttributes(item.fields)
      const existing = live.get(category.toLowerCase())
      const entry: RollbackEntry = {
        programHandle: handle,
        programId,
        category,
        exclusionId: existing?.id != null ? String(existing.id) : null,
        existed: Boolean(existing),
        previousAttributes: existing?.attributes ?? null,
      }

      try {
        if (existing?.id != null) {
          const res = await client.put(
            `/programs/${encodeURIComponent(programId)}/scope_exclusions/${encodeURIComponent(String(existing.id))}`,
            exclusionWriteBody(attributes),
          )
          const error = hackeroneWriteError(res)
          if (error) {
            failures.push(`update "${category}" (${handle}): ${error}`)
            previous.push(entry)
            continue
          }
        } else {
          const res = await client.post(`/programs/${encodeURIComponent(programId)}/scope_exclusions`, exclusionWriteBody(attributes))
          const error = hackeroneWriteError(res)
          if (error) {
            failures.push(`create "${category}" (${handle}): ${error}`)
            previous.push(entry)
            continue
          }
          const created = res.json as { data?: { id?: string } } | null
          entry.exclusionId = created?.data?.id != null ? String(created.data.id) : null
        }
        previous.push(entry)
        applied.push(`${handle}/${category}`)
      } catch (error) {
        failures.push(`"${category}" (${handle}): ${error instanceof Error ? error.message : 'Unknown error'}`)
        previous.push(entry)
      }
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: `Scope-exclusion deploy applied ${applied.length} exclusion(s); ${failures.length} error(s): ${failures.join('; ')}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }

  return {
    success: true,
    message: `Applied ${applied.length} scope exclusion(s): ${applied.join(', ') || '(none)'}`,
    artifacts: { applied },
    rollbackData: { previous },
  }
}
