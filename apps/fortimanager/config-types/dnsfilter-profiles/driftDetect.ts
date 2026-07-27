import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractDnsFilterProfileSpecs, asBool, type LiveDnsFilterProfile, type DnsFilterProfileSpec } from './validate'
import { dnsfilterProfileUrl } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildFmgClient(cred, settings)
  const url = dnsfilterProfileUrl(settings.adom)

  const specs = extractDnsFilterProfileSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveDnsFilterProfile[]) : []
    const liveByName = new Map(live.filter((p) => p.name).map((p) => [p.name!.toLowerCase(), p]))

    // Only the first-class scalar fields are drift-compared; the nested JSON body
    // is intentionally excluded (FortiManager echoes many defaults).
    const bools: Array<[keyof DnsFilterProfileSpec, keyof LiveDnsFilterProfile]> = [
      ['blockBotnet', 'block-botnet'],
      ['logAllDomain', 'log-all-domain'],
      ['safeSearch', 'safe-search'],
      ['sdnsFtgdErrLog', 'sdns-ftgd-err-log'],
      ['sdnsDomainLog', 'sdns-domain-log'],
    ]

    for (const spec of specs) {
      const p = liveByName.get(spec.name.toLowerCase())
      if (!p) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      // block-action can come back int-coded on get — only compare when live is a string.
      if (typeof p['block-action'] === 'string' && p['block-action'] !== spec.blockAction) {
        diffs.push({ field: `${spec.name}.block-action`, expected: spec.blockAction, actual: p['block-action'], severity: 'warning' })
      }
      for (const [specKey, liveKey] of bools) {
        const want = spec[specKey] as boolean
        if (asBool(p[liveKey]) !== want) {
          diffs.push({ field: `${spec.name}.${String(liveKey)}`, expected: want ? 'enable' : 'disable', actual: p[liveKey] ?? '', severity: 'warning' })
        }
      }
      if (spec.redirectPortal || p['redirect-portal']) {
        if ((p['redirect-portal'] ?? '') !== spec.redirectPortal) {
          diffs.push({ field: `${spec.name}.redirect-portal`, expected: spec.redirectPortal, actual: p['redirect-portal'] ?? '', severity: 'warning' })
        }
      }
      if (spec.comment || p.comment) {
        if ((p.comment ?? '') !== spec.comment) diffs.push({ field: `${spec.name}.comment`, expected: spec.comment, actual: p.comment ?? '', severity: 'warning' })
      }
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
