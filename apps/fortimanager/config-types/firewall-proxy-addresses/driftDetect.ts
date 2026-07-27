import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractProxyAddressSpecs, liveStringList, normalizeScalar, type LiveProxyAddress } from './validate'
import { proxyAddressUrl } from './deploy'

type Diffs = DriftResult['diffs']

function pushIfDiff(diffs: Diffs, field: string, want: unknown, actual: unknown, severity: 'warning' | 'critical' = 'warning'): void {
  if (String(want) !== String(actual)) diffs.push({ field, expected: want, actual, severity })
}

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildFmgClient(cred, settings)
  const url = proxyAddressUrl(settings.adom)

  const specs = extractProxyAddressSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveProxyAddress[]) : []
    const liveByName = new Map(live.filter((a) => a.name).map((a) => [a.name!.toLowerCase(), a]))

    for (const spec of specs) {
      const a = liveByName.get(spec.name.toLowerCase())
      if (!a) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      if (spec.type === 'host-regex') {
        pushIfDiff(diffs, `${spec.name}.host-regex`, spec.hostRegex, a['host-regex'] ?? '', 'critical')
      } else if (spec.type === 'url') {
        pushIfDiff(diffs, `${spec.name}.host`, spec.host, normalizeScalar(a.host), 'critical')
        pushIfDiff(diffs, `${spec.name}.path`, spec.path, a.path ?? '', 'critical')
      } else if (spec.type === 'method') {
        pushIfDiff(diffs, `${spec.name}.host`, spec.host, normalizeScalar(a.host), 'critical')
        const liveMethods = liveStringList(a.method)
        if (sortedJson(liveMethods) !== sortedJson(spec.methods)) {
          diffs.push({ field: `${spec.name}.method`, expected: [...spec.methods].sort(), actual: liveMethods.sort(), severity: 'warning' })
        }
      } else if (spec.type === 'ua') {
        pushIfDiff(diffs, `${spec.name}.host`, spec.host, normalizeScalar(a.host), 'critical')
        const liveUas = liveStringList(a.ua)
        if (sortedJson(liveUas) !== sortedJson(spec.userAgents)) {
          diffs.push({ field: `${spec.name}.ua`, expected: [...spec.userAgents].sort(), actual: liveUas.sort(), severity: 'warning' })
        }
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
