import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractLdapServerSpecs, type LiveLdapServer } from './validate'
import { ldapServerUrl } from './deploy'

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
  const url = ldapServerUrl(settings.adom)

  const specs = extractLdapServerSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveLdapServer[]) : []
    const liveByName = new Map(live.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))

    for (const spec of specs) {
      const s = liveByName.get(spec.name.toLowerCase())
      if (!s) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      // The write-only password is never returned — it is deliberately not compared.
      pushIfStr(diffs, `${spec.name}.server`, spec.server, s.server)
      pushIfStr(diffs, `${spec.name}.type`, spec.type, s.type)
      pushIfStr(diffs, `${spec.name}.secure`, spec.secure, s.secure)
      if (spec.secondaryServer || s['secondary-server']) pushIfStr(diffs, `${spec.name}.secondary-server`, spec.secondaryServer, s['secondary-server'] ?? '')
      if (spec.dn || s.dn) pushIfStr(diffs, `${spec.name}.dn`, spec.dn, s.dn ?? '')
      if (spec.groupMemberCheck) pushIfStr(diffs, `${spec.name}.group-member-check`, spec.groupMemberCheck, s['group-member-check'])
      if (spec.port && String(s.port ?? '') !== spec.port) {
        diffs.push({ field: `${spec.name}.port`, expected: spec.port, actual: s.port ?? '', severity: 'warning' })
      }
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
