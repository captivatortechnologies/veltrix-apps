import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { extractClosingReasonSpecs } from './validate'
import { listClosingReasons } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractClosingReasonSpecs(ctx.deployedConfig).filter((s) => s.text)
  const live = await listClosingReasons(client)
  const byText = new Set(live.filter((r) => r.text).map((r) => String(r.text).toLowerCase()))

  const diffs: Diffs = []
  for (const spec of specs) {
    if (!byText.has(spec.text.toLowerCase())) {
      diffs.push({ field: spec.text, expected: 'present', actual: 'absent', severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
