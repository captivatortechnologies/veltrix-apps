import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { addressUrl, buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { cidrToIpMask, extractAddressSpecs, type LiveAddress } from './validate'

type Diffs = DriftResult['diffs']

/** Normalize a subnet (array ["ip","mask"], "ip mask", or "ip/mask") to "ip mask". */
function normalizeSubnet(v: unknown): string {
  if (Array.isArray(v)) return `${v[0] ?? ''} ${v[1] ?? ''}`.trim()
  if (typeof v === 'string') return v.replace('/', ' ').replace(/\s+/g, ' ').trim()
  return ''
}

function pushIfDiff(diffs: Diffs, field: string, want: unknown, actual: unknown, severity: 'warning' | 'critical' = 'warning'): void {
  if (String(want) !== String(actual)) diffs.push({ field, expected: want, actual, severity })
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildFmgClient(cred, settings)
  const url = addressUrl(settings.adom)

  const specs = extractAddressSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveAddress[]) : []
    const liveByName = new Map(live.filter((a) => a.name).map((a) => [a.name!.toLowerCase(), a]))

    for (const spec of specs) {
      const l = liveByName.get(spec.name.toLowerCase())
      if (!l) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      // type — only compare when the tool reports a string enum.
      if (typeof l.type === 'string' && l.type !== spec.type) {
        diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: l.type, severity: 'critical' })
      }
      if (spec.type === 'ipmask') {
        pushIfDiff(diffs, `${spec.name}.subnet`, normalizeSubnet(cidrToIpMask(spec.subnetCidr)), normalizeSubnet(l.subnet))
      } else if (spec.type === 'iprange') {
        pushIfDiff(diffs, `${spec.name}.start-ip`, spec.startIp, l['start-ip'] ?? '')
        pushIfDiff(diffs, `${spec.name}.end-ip`, spec.endIp, l['end-ip'] ?? '')
      } else if (spec.type === 'fqdn') {
        pushIfDiff(diffs, `${spec.name}.fqdn`, spec.fqdn, l.fqdn ?? '')
      } else if (spec.type === 'geography') {
        pushIfDiff(diffs, `${spec.name}.country`, spec.country, (l.country ?? '').toUpperCase())
      }
      if (spec.comment || l.comment) {
        pushIfDiff(diffs, `${spec.name}.comment`, spec.comment, l.comment ?? '', 'warning')
      }
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
