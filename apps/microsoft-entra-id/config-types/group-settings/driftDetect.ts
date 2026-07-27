import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { canonicalValues, extractGroupSettingSpecs, parseValues, type LiveGroupSetting } from './validate'

const BASE = '/groupSettings'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractGroupSettingSpecs(ctx.deployedConfig).filter((s) => s.templateId)
  const listed = await client.getAll<LiveGroupSetting>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByTemplate = new Map(
    listed.items.filter((s) => s.templateId).map((s) => [s.templateId!.toLowerCase(), s]),
  )

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByTemplate.get(spec.templateId)
    if (!live) {
      diffs.push({ field: spec.templateId, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const want = canonicalValues(parseValues(spec.values) ?? [])
    const actual = canonicalValues(live.values)
    if (want !== actual) {
      diffs.push({ field: `${spec.templateId}.values`, expected: want, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
