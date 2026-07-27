import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { cidrToIpMask, extractMulticastAddressSpecs, normalizeScalar, normalizeSubnet, type LiveMulticastAddress } from './validate'
import { multicastAddressUrl } from './deploy'

type Diffs = DriftResult['diffs']

function pushIfDiff(diffs: Diffs, field: string, want: unknown, actual: unknown, severity: 'warning' | 'critical' = 'warning'): void {
  if (String(want) !== String(actual)) diffs.push({ field, expected: want, actual, severity })
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildFmgClient(cred, settings)
  const url = multicastAddressUrl(settings.adom)

  const specs = extractMulticastAddressSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveMulticastAddress[]) : []
    const liveByName = new Map(live.filter((a) => a.name).map((a) => [a.name!.toLowerCase(), a]))

    for (const spec of specs) {
      const a = liveByName.get(spec.name.toLowerCase())
      if (!a) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      if (typeof a.type === 'string' && a.type !== spec.type) {
        diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: a.type, severity: 'critical' })
      }
      if (spec.type === 'multicastrange') {
        pushIfDiff(diffs, `${spec.name}.start-ip`, spec.startIp, a['start-ip'] ?? '', 'critical')
        pushIfDiff(diffs, `${spec.name}.end-ip`, spec.endIp, a['end-ip'] ?? '', 'critical')
      } else if (spec.type === 'broadcastmask') {
        pushIfDiff(diffs, `${spec.name}.subnet`, cidrToIpMask(spec.subnetCidr).join(' '), normalizeSubnet(a.subnet), 'critical')
      }
      if (spec.associatedInterface) {
        pushIfDiff(diffs, `${spec.name}.associated-interface`, spec.associatedInterface, normalizeScalar(a['associated-interface']))
      }
      if (spec.comment || a.comment) {
        pushIfDiff(diffs, `${spec.name}.comment`, spec.comment, a.comment ?? '')
      }
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
