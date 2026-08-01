import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSemgrepClient, managedScanFromProject, projectFromResponse } from '../../lib/semgrepApi'
import { extractManagedScanSpecs } from './_shared'

/**
 * Drift for Managed Scans: compare the declared full_scan / diff_scan state
 * against the live project (GET .../projects/{name} → managed_scan_config).
 * Best-effort — a project that can't be read (transient error / not onboarded)
 * is skipped rather than raising false drift. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { credential, settings, canvas } = ctx
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildSemgrepClient(credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built
  if (!client.hasSlug) return { hasDrift: false, diffs }

  const specs = extractManagedScanSpecs(canvas).filter((s) => s.projectName)

  for (const spec of specs) {
    let res
    try {
      res = await client.getProject(spec.projectName)
    } catch {
      continue // best-effort: can't read, no drift asserted
    }
    if (!res.ok) continue

    const live = managedScanFromProject(projectFromResponse(res))

    if (spec.fullScanEnabled !== live.fullScan) {
      diffs.push({
        field: `${spec.projectName}.fullScanEnabled`,
        expected: String(spec.fullScanEnabled),
        actual: String(live.fullScan),
        severity: 'warning',
      })
    }

    if (spec.diffScanEnabled !== live.diffScan) {
      diffs.push({
        field: `${spec.projectName}.diffScanEnabled`,
        expected: String(spec.diffScanEnabled),
        actual: String(live.diffScan),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
