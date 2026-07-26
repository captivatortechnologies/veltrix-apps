import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDuoClient, readDuoSettings, resolveDuoCredential } from '../../lib/duo'
import { extractIntegrationSpecs, type LiveIntegration } from './validate'

const BASE = '/admin/v1/integrations'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildDuoClient(cred, settings)

  const specs = extractIntegrationSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveIntegration>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((g) => g.name).map((g) => [g.name!.toLowerCase(), g]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.type && live.type && live.type !== spec.type) {
      diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: live.type, severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
