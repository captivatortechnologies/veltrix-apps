import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractFssoAgentSpecs, type LiveFssoAgent } from './validate'
import { fssoAgentUrl } from './deploy'

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
  const url = fssoAgentUrl(settings.adom)

  const specs = extractFssoAgentSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveFssoAgent[]) : []
    const liveByName = new Map(live.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))

    for (const spec of specs) {
      const s = liveByName.get(spec.name.toLowerCase())
      if (!s) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      // The write-only password is never returned — it is deliberately not compared.
      pushIfStr(diffs, `${spec.name}.server`, spec.server, s.server)
      if (spec.server2 || s.server2) pushIfStr(diffs, `${spec.name}.server2`, spec.server2, s.server2 ?? '')
      if (spec.ldapServer || s['ldap-server']) pushIfStr(diffs, `${spec.name}.ldap-server`, spec.ldapServer, s['ldap-server'] ?? '')
      if (spec.port && String(s.port ?? '') !== spec.port) {
        diffs.push({ field: `${spec.name}.port`, expected: spec.port, actual: s.port ?? '', severity: 'warning' })
      }
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
