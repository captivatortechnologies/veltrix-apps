import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractAlertRuleSpecs, type LiveAlertRule } from './validate'

const BASE = '/v2/alert/rule'

type Diffs = DriftResult['diffs']

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractAlertRuleSpecs(ctx.deployedConfig).filter((s) => s.name)
  const res = await client.get(BASE)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveAlertRule[]>(res.body) ?? []
  const liveByName = new Map(live.filter((r) => r.name).map((r) => [r.name!.toLowerCase(), r]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const r = liveByName.get(spec.name.toLowerCase())
    if (!r) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((r.enabled ?? true) !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(r.enabled ?? true), severity: 'warning' })
    }
    if ((r.scanAll ?? true) !== spec.scanAll) {
      diffs.push({ field: `${spec.name}.scanAll`, expected: String(spec.scanAll), actual: String(r.scanAll ?? true), severity: 'warning' })
    }
    if (((r.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: (r.description ?? '') as string, severity: 'warning' })
    }
    if (!spec.scanAll && sortedJson(r.policies ?? []) !== sortedJson(spec.policies)) {
      diffs.push({ field: `${spec.name}.policies`, expected: [...spec.policies].sort(), actual: [...(r.policies ?? [])].sort(), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
