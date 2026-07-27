import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractPolicySpecs, type LivePolicy } from './validate'

const LIST = '/v2/policy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name)
  const res = await client.get(LIST)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LivePolicy[]>(res.body) ?? []
  const liveByName = new Map(live.filter((p) => !p.systemDefault && p.name).map((p) => [p.name!.toLowerCase(), p]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const p = liveByName.get(spec.name.toLowerCase())
    if (!p) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((p.severity ?? '') !== spec.severity) {
      diffs.push({ field: `${spec.name}.severity`, expected: spec.severity, actual: p.severity ?? '', severity: 'warning' })
    }
    if ((p.enabled ?? true) !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(p.enabled ?? true), severity: 'warning' })
    }
    if (((p.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: (p.description ?? '') as string, severity: 'warning' })
    }
    const liveCriteria = typeof p.rule?.criteria === 'string' ? (p.rule.criteria as string) : ''
    if (spec.criteria && liveCriteria !== spec.criteria) {
      diffs.push({ field: `${spec.name}.rule.criteria`, expected: spec.criteria, actual: liveCriteria, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
