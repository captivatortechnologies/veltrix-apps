import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractSslSshProfileSpecs, asBool, type LiveSslSshProfile, type SslSshProfileSpec } from './validate'
import { sslSshProfileUrl } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildFmgClient(cred, settings)
  const url = sslSshProfileUrl(settings.adom)

  const specs = extractSslSshProfileSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveSslSshProfile[]) : []
    const liveByName = new Map(live.filter((p) => p.name).map((p) => [p.name!.toLowerCase(), p]))

    // Only the first-class scalar fields are drift-compared; the nested JSON body
    // is intentionally excluded (FortiManager echoes many defaults).
    const bools: Array<[keyof SslSshProfileSpec, keyof LiveSslSshProfile]> = [
      ['allowlist', 'allowlist'],
      ['blockBlocklistedCertificates', 'block-blocklisted-certificates'],
      ['sslAnomaliesLog', 'ssl-anomalies-log'],
      ['sslExemptionsLog', 'ssl-exemptions-log'],
      ['useSslServer', 'use-ssl-server'],
    ]

    for (const spec of specs) {
      const p = liveByName.get(spec.name.toLowerCase())
      if (!p) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      for (const [specKey, liveKey] of bools) {
        const want = spec[specKey] as boolean
        if (asBool(p[liveKey]) !== want) {
          diffs.push({ field: `${spec.name}.${String(liveKey)}`, expected: want ? 'enable' : 'disable', actual: p[liveKey] ?? '', severity: 'warning' })
        }
      }
      // server-cert-mode can come back int-coded on get — only compare when live is a string.
      if (typeof p['server-cert-mode'] === 'string' && p['server-cert-mode'] !== spec.serverCertMode) {
        diffs.push({ field: `${spec.name}.server-cert-mode`, expected: spec.serverCertMode, actual: p['server-cert-mode'], severity: 'warning' })
      }
      if (spec.untrustedCaname || p['untrusted-caname']) {
        if ((p['untrusted-caname'] ?? '') !== spec.untrustedCaname) {
          diffs.push({ field: `${spec.name}.untrusted-caname`, expected: spec.untrustedCaname, actual: p['untrusted-caname'] ?? '', severity: 'warning' })
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
