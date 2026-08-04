import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, type HackerOneClient } from '../../lib/hackeroneApi'
import {
  buildExclusionAttributes,
  groupItemsByProgram,
  findProgramId,
  exclusionsByCategory,
  str,
  type LiveScopeExclusion,
  type ScopeExclusionAttributes,
} from './_shared'

/**
 * Drift for Scope Exclusions: for each declared exclusion, confirm it still
 * exists in its program and that `details` matches what we declare. Read-only:
 *   GET /me/programs                        → resolve handles → ids
 *   GET /programs/{id}/scope_exclusions     → live exclusions by category
 *
 * Best-effort — a program or exclusion that can't be resolved / read is
 * reported as missing rather than raising noisy false drift.
 */
async function listExclusions(client: HackerOneClient, programId: string): Promise<LiveScopeExclusion[]> {
  try {
    const res = await client.getAll<Partial<ScopeExclusionAttributes>>(`/programs/${encodeURIComponent(programId)}/scope_exclusions`)
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
      diffs.push({ field: handle, expected: 'program present', actual: 'not found', severity: 'warning' })
      continue
    }

    const live = exclusionsByCategory(await listExclusions(client, programId))

    for (const item of groupItems) {
      const category = str(item.fields.category)
      if (!category) continue
      const label = `${handle}/${category}`

      const match = live.get(category.toLowerCase())
      if (!match) {
        diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'warning' })
        continue
      }

      const desired = buildExclusionAttributes(item.fields)
      const actual = match.attributes ?? {}
      if (str(actual.details) !== desired.details) {
        diffs.push({ field: `${label}.details`, expected: desired.details, actual: str(actual.details), severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
