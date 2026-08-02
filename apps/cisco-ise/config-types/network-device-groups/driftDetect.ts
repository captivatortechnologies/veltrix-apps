import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { ersBase, buildErsResourceClient, readIseSettings, hasUsableCredential, ndgRootFromName, type NetworkDeviceGroup } from '../../lib/iseApi'
import { extractSpecs } from './_shared'

/**
 * Drift for network device groups: a declared group missing from ISE is
 * critical drift (deleted outside Veltrix); a description or root-category
 * (`othername`) mismatch is a warning. Read-only. Best-effort — a group that
 * can't be read (transient error) is skipped rather than raising false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasUsableCredential(credential)) return { hasDrift: false, diffs }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<NetworkDeviceGroup>(base, 'networkdevicegroup', 'NetworkDeviceGroup', credential, settings)

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

    const expectedRoot = ndgRootFromName(spec.name)
    const actualRoot = String(live.othername ?? '').trim()
    if (expectedRoot !== actualRoot) {
      diffs.push({ field: `${spec.name}.othername`, expected: expectedRoot, actual: actualRoot, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
