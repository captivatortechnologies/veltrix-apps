import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCbClient, parseJson, readCbSettings, resolveCbCredential } from '../../lib/carbonblack'
import { extractForwarderSpecs, type LiveForwarder } from './validate'
import { definitionEquals } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildCbClient(cred, settings)
  const base = client.dataForwardersPath()

  const specs = extractForwarderSpecs(ctx.deployedConfig).filter((s) => s.name)
  const res = await client.get(base)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const parsed = parseJson<{ results?: LiveForwarder[] } | LiveForwarder[]>(res.body)
  const forwarders = Array.isArray(parsed) ? parsed : parsed?.results ?? []
  const liveByName = new Map(forwarders.filter((f) => f.name).map((f) => [f.name!.toLowerCase(), f]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (definitionEquals(live, spec)) continue
    if ((live.type ?? '') !== spec.type) {
      diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: live.type ?? '', severity: 'warning' })
    }
    if ((live.destination ?? '') !== spec.destination) {
      diffs.push({ field: `${spec.name}.destination`, expected: spec.destination, actual: live.destination ?? '', severity: 'warning' })
    }
    if ((live.enabled ?? true) !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: spec.enabled, actual: live.enabled ?? true, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
