import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { extractBandwidthConfigSpecs } from './validate'
import { listBandwidthConfigs } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [], checked: false }
  const client = buildQRadarClient(cred, settings)

  const specs = extractBandwidthConfigSpecs(ctx.deployedConfig).filter((s) => s.name)
  const live = await listBandwidthConfigs(client)
  // An unreadable console is not an empty one. Reporting every declared
  // object as critically absent because one read failed pages somebody for
  // deletions that never happened.
  if (live === null) return { hasDrift: false, diffs: [], checked: false }
  const byName = new Map(live.filter((c) => c.name).map((c) => [String(c.name).toLowerCase(), c]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const cfg = byName.get(spec.name.toLowerCase())
    if (!cfg) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.kbLimit !== undefined && (cfg.kb_limit ?? undefined) !== spec.kbLimit) {
      diffs.push({ field: `${spec.name}.kbLimit`, expected: String(spec.kbLimit), actual: String(cfg.kb_limit ?? ''), severity: 'warning' })
    }
    if ((cfg.host_id ?? -1) !== spec.hostId) {
      diffs.push({ field: `${spec.name}.hostId`, expected: String(spec.hostId), actual: String(cfg.host_id ?? ''), severity: 'warning' })
    }
    if ((cfg.hostname ?? '') !== spec.hostname) {
      diffs.push({ field: `${spec.name}.hostname`, expected: spec.hostname, actual: cfg.hostname ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
