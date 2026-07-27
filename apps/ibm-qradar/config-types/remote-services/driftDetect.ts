import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { extractRemoteServiceSpecs } from './validate'
import { listRemoteServices } from './deploy'

type Diffs = DriftResult['diffs']

function sameCidrs(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sb = new Set(b)
  return a.every((x) => sb.has(x))
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractRemoteServiceSpecs(ctx.deployedConfig).filter((s) => s.name)
  const live = await listRemoteServices(client)
  const byName = new Map(live.filter((n) => n.name).map((n) => [String(n.name).toLowerCase(), n]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const svc = byName.get(spec.name.toLowerCase())
    if (!svc) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((svc.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: svc.description ?? '', severity: 'warning' })
    }
    if ((svc.group ?? '') !== spec.group) {
      diffs.push({ field: `${spec.name}.group`, expected: spec.group, actual: svc.group ?? '', severity: 'warning' })
    }
    if (!sameCidrs(svc.cidrs ?? [], spec.cidrs)) {
      diffs.push({ field: `${spec.name}.cidrs`, expected: spec.cidrs.join(', '), actual: (svc.cidrs ?? []).join(', '), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
