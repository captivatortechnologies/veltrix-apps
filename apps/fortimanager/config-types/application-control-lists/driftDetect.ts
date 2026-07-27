import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractAppControlSpecs, type LiveAppControl } from './validate'
import { appControlUrl } from './deploy'

type Diffs = DriftResult['diffs']

function pushStr(diffs: Diffs, field: string, want: string, live: unknown, severity: 'warning' | 'critical' = 'warning'): void {
  if (!want) return
  if (typeof live !== 'string') return
  if (want !== live) diffs.push({ field, expected: want, actual: live, severity })
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildFmgClient(cred, settings)
  const url = appControlUrl(settings.adom)

  const specs = extractAppControlSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveAppControl[]) : []
    const liveByName = new Map(live.filter((p) => p.name).map((p) => [p.name!.toLowerCase(), p]))

    for (const spec of specs) {
      const p = liveByName.get(spec.name.toLowerCase())
      if (!p) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      pushStr(diffs, `${spec.name}.other-application-action`, spec.otherApplicationAction, p['other-application-action'])
      pushStr(diffs, `${spec.name}.unknown-application-action`, spec.unknownApplicationAction, p['unknown-application-action'])
      pushStr(diffs, `${spec.name}.deep-app-inspection`, spec.deepAppInspection, p['deep-app-inspection'])
      pushStr(diffs, `${spec.name}.enforce-default-app-port`, spec.enforceDefaultAppPort, p['enforce-default-app-port'])
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
