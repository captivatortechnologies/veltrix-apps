import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractRuleSpecs, normalizeRuleText } from './validate'
import { listRules } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const listed = await listRules(client, parent)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const byDisplayName = new Map(listed.rules.map((r) => [r.displayName ?? '', r]))

  const specs = extractRuleSpecs(ctx.deployedConfig).filter((s) => s.ruleName)
  const diffs: Diffs = []
  for (const spec of specs) {
    const live = byDisplayName.get(spec.ruleName)
    if (!live) {
      diffs.push({ field: spec.ruleName, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (normalizeRuleText(live.text ?? '') !== normalizeRuleText(spec.text)) {
      diffs.push({ field: `${spec.ruleName}.text`, expected: 'declared rule text', actual: 'differs from live rule text', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
