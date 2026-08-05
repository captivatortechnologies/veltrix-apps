import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCbClient, parseJson, readCbSettings, resolveCbCredential } from '../../lib/carbonblack'
import { extractGrantSpecs, type LiveGrant, type LiveUser } from './validate'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildCbClient(cred, settings)
  const grantsBase = client.grantsPath()

  const specs = extractGrantSpecs(ctx.deployedConfig).filter((s) => s.principalEmail && s.roles.length)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const usersRes = await client.get(client.usersPath())
  if (!usersRes.ok) return { hasDrift: false, diffs: [] }
  const usersParsed = parseJson<{ users?: LiveUser[] } | LiveUser[]>(usersRes.body)
  const users = Array.isArray(usersParsed) ? usersParsed : usersParsed?.users ?? []
  const loginIdByEmail = new Map<string, string>()
  for (const u of users) if (u.email && u.login_id !== undefined && u.login_id !== null) loginIdByEmail.set(u.email.toLowerCase(), String(u.login_id))

  const diffs: Diffs = []
  for (const spec of specs) {
    const loginId = loginIdByEmail.get(spec.principalEmail)
    if (!loginId) {
      diffs.push({ field: spec.principalEmail, expected: 'user present', actual: 'user not found', severity: 'critical' })
      continue
    }
    const principalUrn = `psc:user:${cred.orgKey}:${loginId}`
    const res = await client.get(`${grantsBase}/${encodeURIComponent(principalUrn)}`)
    if (res.status === 404) {
      diffs.push({ field: spec.principalEmail, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!res.ok) continue
    const grant = parseJson<LiveGrant>(res.body)
    if (grant?.profiles) {
      diffs.push({ field: `${spec.principalEmail}.roles`, expected: 'roles-based grant', actual: 'profiles-based grant (unmanaged)', severity: 'warning' })
      continue
    }
    const liveRoles = new Set(grant?.roles ?? [])
    // Additive-only: report a declared role that's missing, never an extra live one.
    const missing = spec.roles.filter((r) => !liveRoles.has(r))
    if (missing.length) {
      diffs.push({ field: `${spec.principalEmail}.roles`, expected: missing.join(', '), actual: 'missing', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
