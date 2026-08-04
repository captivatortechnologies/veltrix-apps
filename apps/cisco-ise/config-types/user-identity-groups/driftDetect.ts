import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { ersBase, buildErsResourceClient, readIseSettings, hasUsableCredential, type IdentityGroup } from '../../lib/iseApi'
import { extractSpecs } from './_shared'

/**
 * Drift for identity groups: a declared group missing from ISE is critical
 * drift; a description or parent mismatch is a warning (`parentName` is
 * re-resolved to an id here the same way deploy.ts does, for an apples-to-
 * apples comparison against the live `parent` id). Read-only. Best-effort — a
 * group (or its parent) that can't be read is skipped rather than raising
 * false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasUsableCredential(credential)) return { hasDrift: false, diffs }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<IdentityGroup>(base, 'identitygroup', 'IdentityGroup', credential, settings)

  for (const item of items) {
    const spec = extractSpecs([item])[0]
    if (!spec.name) continue

    let existing
    try {
      existing = await client.findByName(spec.name)
    } catch {
      continue
    }

    if (!existing) {
      diffs.push({ field: `${spec.name}`, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    let live
    try {
      live = await client.getById(existing.id)
    } catch {
      continue
    }
    if (!live) continue

    const expectedDescription = spec.description
    const actualDescription = String(live.description ?? '').trim()
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${spec.name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'warning' })
    }

    let expectedParentId = ''
    if (spec.parentName) {
      try {
        const parent = await client.findByName(spec.parentName)
        expectedParentId = parent?.id ?? ''
      } catch {
        // Can't resolve the parent right now — skip the parent comparison only.
        continue
      }
    }
    const actualParentId = String(live.parent ?? '').trim()
    if (expectedParentId && expectedParentId !== actualParentId) {
      diffs.push({ field: `${spec.name}.parent`, expected: spec.parentName, actual: actualParentId, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
