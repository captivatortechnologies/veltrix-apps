import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractFindingsRefinementSpecs } from './validate'
import { listRefinements } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const listed = await listRefinements(client, parent)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const byDisplayName = new Map(listed.refinements.map((r) => [r.displayName ?? '', r]))

  const specs = extractFindingsRefinementSpecs(ctx.deployedConfig).filter((s) => s.displayName && s.query)
  const diffs: Diffs = []
  for (const spec of specs) {
    const live = byDisplayName.get(spec.displayName)
    if (!live) {
      diffs.push({ field: spec.displayName, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.query ?? '') !== spec.query) {
      diffs.push({ field: `${spec.displayName}.query`, expected: spec.query, actual: live.query ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
