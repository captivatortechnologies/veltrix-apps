import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { ersBase, buildErsResourceClient, readIseSettings, hasUsableCredential, type Sgt } from '../../lib/iseApi'
import { extractSpecs, AUTO_VALUE } from './_shared'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []
  if (!hasUsableCredential(ctx.credential)) return { hasDrift: false, diffs }
  const client = buildErsResourceClient<Sgt>(ersBase(ctx.component, ctx.connectivity, ctx.connectivityProvider), 'sgt', 'Sgt', ctx.credential, readIseSettings(ctx.settings))
  for (const spec of extractSpecs(ctx.canvas.items ?? ctx.canvas.sections ?? [])) {
    if (!spec.name) continue
    let summary
    try { summary = await client.findByName(spec.name) } catch { continue }
    if (!summary) { diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' }); continue }
    let live
    try { live = await client.getById(summary.id) } catch { continue }
    if (!live) continue
    const compare: Array<[string, unknown, unknown]> = [
      ['description', spec.description, String(live.description ?? '').trim()],
      ['propagate_to_apic', spec.propagateToApic, live.propogateToApic ?? false],
    ]
    if (spec.value !== AUTO_VALUE) compare.push(['value', spec.value, live.value])
    for (const [field, expected, actual] of compare) if (expected !== actual) diffs.push({ field: `${spec.name}.${field}`, expected, actual, severity: 'warning' })
  }
  return { hasDrift: diffs.length > 0, diffs }
}
