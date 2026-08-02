import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, type HackerOneClient } from '../../lib/hackeroneApi'
import {
  buildScopeAttributes,
  groupItemsByProgram,
  findProgramId,
  scopesByIdentifier,
  normalizeIdentifier,
  str,
  toBool,
  type LiveScope,
  type ScopeAttributes,
} from './_shared'

/**
 * Drift for Structured Scopes: for each declared scope, confirm it still exists in
 * its program and that its key attributes (asset_type, eligible_for_bounty,
 * eligible_for_submission, max_severity) match what we declare. Read-only:
 *   GET /me/programs                              → resolve handles → ids
 *   GET /programs/{id}/structured_scopes          → live scopes by identifier
 *
 * Best-effort — a program or scope that can't be resolved / read is reported as
 * missing or skipped rather than raising noisy false drift.
 */
async function listScopes(client: HackerOneClient, programId: string): Promise<LiveScope[]> {
  try {
    const res = await client.getAll<Partial<ScopeAttributes>>(`/programs/${encodeURIComponent(programId)}/structured_scopes`)
    return res.ok ? res.items : []
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

    const live = scopesByIdentifier(await listScopes(client, programId))

    for (const item of groupItems) {
      const assetIdentifier = str(item.fields.asset_identifier)
      if (!assetIdentifier) continue
      const label = `${handle}/${assetIdentifier}`

      const match = live.get(normalizeIdentifier(assetIdentifier))
      if (!match) {
        diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'warning' })
        continue
      }

      const desired = buildScopeAttributes(item.fields)
      const actual = match.attributes ?? {}

      if (str(actual.asset_type) && str(actual.asset_type) !== desired.asset_type) {
        diffs.push({ field: `${label}.asset_type`, expected: desired.asset_type, actual: str(actual.asset_type), severity: 'warning' })
      }
      if (actual.eligible_for_bounty !== undefined && toBool(actual.eligible_for_bounty) !== desired.eligible_for_bounty) {
        diffs.push({ field: `${label}.eligible_for_bounty`, expected: desired.eligible_for_bounty, actual: toBool(actual.eligible_for_bounty), severity: 'warning' })
      }
      if (actual.eligible_for_submission !== undefined && toBool(actual.eligible_for_submission) !== desired.eligible_for_submission) {
        diffs.push({ field: `${label}.eligible_for_submission`, expected: desired.eligible_for_submission, actual: toBool(actual.eligible_for_submission), severity: 'warning' })
      }
      if (str(actual.max_severity) && str(actual.max_severity) !== desired.max_severity) {
        diffs.push({ field: `${label}.max_severity`, expected: desired.max_severity, actual: str(actual.max_severity), severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
