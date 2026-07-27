import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractConnectorRuleSpecs, type LiveConnectorRule } from './validate'

const BASE = '/beta/connector-rules'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractConnectorRuleSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveConnectorRule>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((r) => r.name).map((r) => [r.name!.toLowerCase(), r]))

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
    if (((live.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: live.description ?? '', severity: 'warning' })
    }
    if ((live.sourceCode?.script ?? '') !== spec.script) {
      diffs.push({ field: `${spec.name}.script`, expected: 'declared source', actual: 'differs', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
