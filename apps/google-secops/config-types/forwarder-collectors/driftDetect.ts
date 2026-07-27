import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractCollectorSpecs } from './validate'
import { listForwarders, forwarderIdOf, resolveForwarder } from '../forwarders/deploy'
import { listCollectors } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const listedFwd = await listForwarders(client, parent)
  if (!listedFwd.ok) return { hasDrift: false, diffs: [] }

  const specs = extractCollectorSpecs(ctx.deployedConfig).filter((s) => s.forwarderName && s.displayName && s.config)
  const collectorsByFwd = new Map<string, Awaited<ReturnType<typeof listCollectors>>['collectors']>()
  const diffs: Diffs = []

  for (const spec of specs) {
    const forwarder = resolveForwarder(listedFwd.forwarders, spec.forwarderName)
    if (!forwarder) {
      diffs.push({ field: `${spec.forwarderName}/${spec.displayName}`, expected: 'present', actual: 'forwarder absent', severity: 'critical' })
      continue
    }
    const forwarderId = forwarderIdOf(forwarder.name ?? '')
    if (!collectorsByFwd.has(forwarderId)) {
      const listed = await listCollectors(client, parent, forwarderId)
      if (!listed.ok) continue
      collectorsByFwd.set(forwarderId, listed.collectors)
    }
    const live = collectorsByFwd.get(forwarderId)!.find((c) => (c.displayName ?? '') === spec.displayName)
    if (!live) {
      diffs.push({ field: `${spec.forwarderName}/${spec.displayName}`, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    // Settings can carry write-only secrets, so drift is limited to the log type.
    if ((live.config?.logType ?? '') !== spec.logType) {
      diffs.push({ field: `${spec.forwarderName}/${spec.displayName}.logType`, expected: spec.logType, actual: live.config?.logType ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
