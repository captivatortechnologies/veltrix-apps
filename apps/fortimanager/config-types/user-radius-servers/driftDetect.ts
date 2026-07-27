import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractRadiusServerSpecs, type LiveRadiusServer } from './validate'
import { radiusServerUrl } from './deploy'

type Diffs = DriftResult['diffs']

function pushIfStr(diffs: Diffs, field: string, want: string, actual: unknown): void {
  // Enum-ish fields can come back int-coded on get — only compare when live is a string.
  if (typeof actual === 'string' && actual !== want) diffs.push({ field, expected: want, actual, severity: 'warning' })
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildFmgClient(cred, settings)
  const url = radiusServerUrl(settings.adom)

  const specs = extractRadiusServerSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveRadiusServer[]) : []
    const liveByName = new Map(live.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))

    for (const spec of specs) {
      const s = liveByName.get(spec.name.toLowerCase())
      if (!s) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      // The write-only secret / secondary-secret are never returned — not compared.
      pushIfStr(diffs, `${spec.name}.server`, spec.server, s.server)
      pushIfStr(diffs, `${spec.name}.auth-type`, spec.authType, s['auth-type'])
      if (spec.secondaryServer || s['secondary-server']) pushIfStr(diffs, `${spec.name}.secondary-server`, spec.secondaryServer, s['secondary-server'] ?? '')
      if (spec.nasIp || s['nas-ip']) pushIfStr(diffs, `${spec.name}.nas-ip`, spec.nasIp, s['nas-ip'] ?? '')
      if (spec.radiusPort && String(s['radius-port'] ?? '') !== spec.radiusPort) {
        diffs.push({ field: `${spec.name}.radius-port`, expected: spec.radiusPort, actual: s['radius-port'] ?? '', severity: 'warning' })
      }
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
