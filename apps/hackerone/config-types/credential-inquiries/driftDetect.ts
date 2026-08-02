import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, type HackerOneClient } from '../../lib/hackeroneApi'
import {
  groupItemsByProgram,
  findProgramId,
  scopesByIdentifier,
  normalizeIdentifier,
  str,
  type IdentifiableResource,
} from '../../lib/programScopes'
import { buildInquiryDescription, inquiriesByScopeId, type LiveInquiry } from './_shared'

/**
 * Drift for Credential Inquiries: for each declared inquiry, confirm its scope
 * still exists, that an inquiry is attached to that scope, and that the inquiry's
 * description matches what we declare. Read-only:
 *   GET /me/programs                            → resolve handles → ids
 *   GET /programs/{id}/structured_scopes        → resolve asset identifier → scope id
 *   GET /programs/{id}/credential_inquiries     → live inquiries by scope id
 *
 * Best-effort — a program, scope or inquiry that can't be resolved / read is
 * reported as missing or skipped rather than raising noisy false drift.
 */
async function listScopes(client: HackerOneClient, programId: string): Promise<IdentifiableResource[]> {
  try {
    const res = await client.getAll<{ asset_identifier?: string }>(`/programs/${encodeURIComponent(programId)}/structured_scopes`)
    return res.ok ? res.items : []
  } catch {
    return []
  }
}

async function listInquiries(client: HackerOneClient, programId: string): Promise<LiveInquiry[]> {
  try {
    const res = await client.getAll<Record<string, unknown>>(`/programs/${encodeURIComponent(programId)}/credential_inquiries`)
    return res.ok ? (res.items as LiveInquiry[]) : []
  } catch {
    return []
  }
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildHackeroneClient(credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let programs
  try {
    const res = await client.listPrograms()
    if (!res.ok) return { hasDrift: false, diffs }
    programs = res.items
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const [handle, groupItems] of groupItemsByProgram(items)) {
    const programId = findProgramId(programs, handle)
    if (!programId) {
      diffs.push({ field: `${handle}`, expected: 'program present', actual: 'not found', severity: 'warning' })
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
        diffs.push({ field: label, expected: 'scope present', actual: 'scope missing', severity: 'warning' })
        continue
      }

      const match = inquiries.get(structuredScopeId)
      if (!match) {
        diffs.push({ field: label, expected: 'inquiry present', actual: 'missing', severity: 'warning' })
        continue
      }

      const desired = buildInquiryDescription(item.fields)
      const actual = str(match.attributes?.description)
      if (actual !== desired) {
        diffs.push({ field: `${label}.description`, expected: desired, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
