import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractRateLimitSpecs, type LiveRateLimit } from './validate'

const BASE = '/aig/ratelimits'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractRateLimitSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveRateLimit>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((r) => r.name).map((r) => [r.name!.toLowerCase(), r]))

  // criteria/limit are re-sent (and thus self-heal) every deploy; drift compares
  // the stable scalar/list fields.
  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.response ?? '') !== spec.response) {
      diffs.push({ field: `${spec.name}.response`, expected: spec.response, actual: live.response ?? '', severity: 'warning' })
    }
    const expectedIds = [...spec.applianceIds].sort().join(',')
    const actualIds = (live.appliance_ids ?? []).map((v) => String(v)).sort().join(',')
    if (expectedIds !== actualIds) {
      diffs.push({ field: `${spec.name}.appliance_ids`, expected: expectedIds, actual: actualIds, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
