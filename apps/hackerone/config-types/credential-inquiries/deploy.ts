import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, hackeroneWriteError, type HackerOneClient } from '../../lib/hackeroneApi'
import {
  groupItemsByProgram,
  findProgramId,
  scopesByIdentifier,
  normalizeIdentifier,
  str,
  type IdentifiableResource,
} from '../../lib/programScopes'
import {
  buildInquiryDescription,
  inquiryWriteBody,
  inquiryCreateBody,
  inquiriesByScopeId,
  type LiveInquiry,
} from './_shared'

/**
 * Deploy HackerOne Credential Inquiries over the HackerOne API (v1).
 *
 *   resolve program: GET  /me/programs                            → handle → id
 *   resolve scope:   GET  /programs/{id}/structured_scopes        → asset_identifier → scope id
 *   read (upsert):   GET  /programs/{id}/credential_inquiries     → inquiries by scope id
 *   create:          POST /programs/{id}/credential_inquiries     { structured_scope_id, data: {...} }
 *   update:          PUT  /programs/{id}/credential_inquiries/{iid} { data: {...} }
 *
 * A credential inquiry attaches to exactly ONE structured scope, so inquiries are
 * upserted by the scope they attach to (resolved from the asset identifier).
 * rollbackData records, per inquiry, whether it already existed, its id and scope,
 * and the prior description — so rollback restores the prior text or deletes what
 * this deploy created.
 *
 * FLAGGED — the credential-inquiry endpoints require the Team Management
 * permission on the API token; and the linkage between a listed inquiry and its
 * structured scope (attribute vs. relationship) should be verified against live
 * HackerOne — see _shared.inquiryScopeId.
 *   Confirmed: https://api.hackerone.com/customer-resources/ (Credential Inquiries)
 */
interface RollbackEntry {
  programHandle: string
  programId: string | null
  assetIdentifier: string
  structuredScopeId: string | null
  inquiryId: string | null
  existed: boolean
  previousDescription: string | null
}

/** Read every live structured scope for a program (best-effort). */
async function listScopes(client: HackerOneClient, programId: string): Promise<IdentifiableResource[]> {
  try {
    const res = await client.getAll<{ asset_identifier?: string }>(`/programs/${encodeURIComponent(programId)}/structured_scopes`)
    return res.ok ? res.items : []
  } catch {
    return []
  }
}

/** Read every live credential inquiry for a program (best-effort). */
async function listInquiries(client: HackerOneClient, programId: string): Promise<LiveInquiry[]> {
  try {
    const res = await client.getAll<Record<string, unknown>>(`/programs/${encodeURIComponent(programId)}/credential_inquiries`)
    return res.ok ? (res.items as LiveInquiry[]) : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for credential-inquiry deployment' }
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
          assetIdentifier: str(item.fields.asset_identifier),
          structuredScopeId: null,
          inquiryId: null,
          existed: false,
          previousDescription: null,
        })
      }
      continue
    }

    const scopes = scopesByIdentifier(await listScopes(client, programId))
    const inquiries = inquiriesByScopeId(await listInquiries(client, programId))

    for (const item of groupItems) {
      const assetIdentifier = str(item.fields.asset_identifier)
      if (!assetIdentifier) continue
      const label = `${handle}/${assetIdentifier}`

      const scope = scopes.get(normalizeIdentifier(assetIdentifier))
      const structuredScopeId = scope?.id != null ? String(scope.id) : null
      if (!structuredScopeId) {
        failures.push(`inquiry "${label}": asset is not a structured scope of the program (GET /programs/${programId}/structured_scopes)`)
        previous.push({
          programHandle: handle,
          programId,
          assetIdentifier,
          structuredScopeId: null,
          inquiryId: null,
          existed: false,
          previousDescription: null,
        })
        continue
      }

      const description = buildInquiryDescription(item.fields)
      const existing = inquiries.get(structuredScopeId)
      const entry: RollbackEntry = {
        programHandle: handle,
        programId,
        assetIdentifier,
        structuredScopeId,
        inquiryId: existing?.id != null ? String(existing.id) : null,
        existed: Boolean(existing),
        previousDescription: existing?.attributes?.description != null ? String(existing.attributes.description) : null,
      }

      try {
        if (existing?.id != null) {
          const res = await client.put(
            `/programs/${encodeURIComponent(programId)}/credential_inquiries/${encodeURIComponent(String(existing.id))}`,
            inquiryWriteBody(description),
          )
          const error = hackeroneWriteError(res)
          if (error) {
            failures.push(`update "${label}": ${error}`)
            previous.push(entry)
            continue
          }
        } else {
          const res = await client.post(
            `/programs/${encodeURIComponent(programId)}/credential_inquiries`,
            inquiryCreateBody(structuredScopeId, description),
          )
          const error = hackeroneWriteError(res)
          if (error) {
            failures.push(`create "${label}": ${error}`)
            previous.push(entry)
            continue
          }
          const created = res.json as { data?: { id?: string } } | null
          entry.inquiryId = created?.data?.id != null ? String(created.data.id) : null
        }
        previous.push(entry)
        applied.push(label)
      } catch (error) {
        failures.push(`"${label}": ${error instanceof Error ? error.message : 'Unknown error'}`)
        previous.push(entry)
      }
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: `Credential-inquiry deploy applied ${applied.length} inquiry(ies); ${failures.length} error(s): ${failures.join('; ')}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }

  return {
    success: true,
    message: `Applied ${applied.length} credential inquiry(ies): ${applied.join(', ') || '(none)'}`,
    artifacts: { applied },
    rollbackData: { previous },
  }
}
