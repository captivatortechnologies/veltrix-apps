import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, hackeroneWriteError, type HackerOneClient } from '../../lib/hackeroneApi'
import {
  buildScopeAttributes,
  scopeWriteBody,
  groupItemsByProgram,
  findProgramId,
  scopesByIdentifier,
  normalizeIdentifier,
  str,
  type LiveScope,
  type ScopeAttributes,
} from './_shared'

/**
 * Deploy HackerOne Structured Scopes over the HackerOne API (v1).
 *
 *   resolve program: GET /me/programs                              → handle → id
 *   read (upsert):    GET  /programs/{id}/structured_scopes         → scopes by identifier
 *   create:           POST /programs/{id}/structured_scopes         { data: { type, attributes } }
 *   update:           PUT  /programs/{id}/structured_scopes/{sid}   { data: { type, attributes } }
 *
 * Scopes are grouped by program_handle, each handle resolved to its program id,
 * and each asset upserted by asset_identifier WITHIN that program. rollbackData
 * records, per scope, whether it already existed, its id, and the prior
 * attributes — so rollback can restore the prior state or archive what we created.
 *
 * FLAGGED — the program-level create/update/archive structured-scope endpoints
 * were removed from the HackerOne docs on 2026-04-07 (assets are now managed via
 * organization asset management endpoints). The GET (list) endpoint remains.
 * Verify the write path + request envelope against live HackerOne before use.
 *   Confirmed GET/PUT paths: github/hackerone-client (Program / StructuredScope).
 *   Doc note: https://api.hackerone.com/customer-resources/
 */
interface RollbackEntry {
  programHandle: string
  programId: string | null
  assetIdentifier: string
  scopeId: string | null
  existed: boolean
  previousAttributes: Partial<ScopeAttributes> | null
}

/** Read every live scope for a program (best-effort — read failures yield an empty list). */
async function listScopes(client: HackerOneClient, programId: string): Promise<LiveScope[]> {
  try {
    const res = await client.getAll<Partial<ScopeAttributes>>(`/programs/${encodeURIComponent(programId)}/structured_scopes`)
    return res.ok ? res.items : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for structured-scope deployment' }
  }

  const built = buildHackeroneClient(credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: RollbackEntry[] = []
  const applied: string[] = []
  const failures: string[] = []

  // Resolve the caller's programs once (handle → id).
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
          assetIdentifier: str(item.fields.asset_identifier),
          scopeId: null,
          existed: false,
          previousAttributes: null,
        })
      }
      continue
    }

    const live = scopesByIdentifier(await listScopes(client, programId))

    for (const item of groupItems) {
      const assetIdentifier = str(item.fields.asset_identifier)
      if (!assetIdentifier) continue

      const attributes = buildScopeAttributes(item.fields)
      const existing = live.get(normalizeIdentifier(assetIdentifier))
      const entry: RollbackEntry = {
        programHandle: handle,
        programId,
        assetIdentifier,
        scopeId: existing?.id != null ? String(existing.id) : null,
        existed: Boolean(existing),
        previousAttributes: existing?.attributes ?? null,
      }

      try {
        if (existing?.id != null) {
          const res = await client.put(
            `/programs/${encodeURIComponent(programId)}/structured_scopes/${encodeURIComponent(String(existing.id))}`,
            scopeWriteBody(attributes),
          )
          const error = hackeroneWriteError(res)
          if (error) {
            failures.push(`update "${assetIdentifier}" (${handle}): ${error}`)
            previous.push(entry)
            continue
          }
        } else {
          const res = await client.post(
            `/programs/${encodeURIComponent(programId)}/structured_scopes`,
            scopeWriteBody(attributes),
          )
          const error = hackeroneWriteError(res)
          if (error) {
            failures.push(`create "${assetIdentifier}" (${handle}): ${error}`)
            previous.push(entry)
            continue
          }
          const created = res.json as { data?: { id?: string } } | null
          entry.scopeId = created?.data?.id != null ? String(created.data.id) : null
        }
        previous.push(entry)
        applied.push(`${handle}/${assetIdentifier}`)
      } catch (error) {
        failures.push(`"${assetIdentifier}" (${handle}): ${error instanceof Error ? error.message : 'Unknown error'}`)
        previous.push(entry)
      }
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: `Structured-scope deploy applied ${applied.length} scope(s); ${failures.length} error(s): ${failures.join('; ')}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }

  return {
    success: true,
    message: `Applied ${applied.length} structured scope(s): ${applied.join(', ') || '(none)'}`,
    artifacts: { applied },
    rollbackData: { previous },
  }
}
