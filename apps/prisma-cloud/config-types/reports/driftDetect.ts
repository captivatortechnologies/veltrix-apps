import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractReportSpecs, type LiveReport } from './validate'

const BASE = '/report'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractReportSpecs(ctx.deployedConfig).filter((s) => s.name && !s.targetError)
  const res = await client.get(BASE)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveReport[]>(res.body) ?? []
  const liveByName = new Map(live.filter((r) => r.name).map((r) => [r.name!.toLowerCase(), r]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const r = liveByName.get(spec.name.toLowerCase())
    if (!r) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((r.reportType ?? '') !== spec.reportType) {
      diffs.push({ field: `${spec.name}.reportType`, expected: spec.reportType, actual: r.reportType ?? '', severity: 'warning' })
    }
    if (spec.cloudType && (r.cloudType ?? '') !== spec.cloudType) {
      diffs.push({ field: `${spec.name}.cloudType`, expected: spec.cloudType, actual: r.cloudType ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
