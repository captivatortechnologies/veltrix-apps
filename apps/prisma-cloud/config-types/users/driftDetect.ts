import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractUserSpecs, type LiveUser } from './validate'

const V2 = '/v2/user'

type Diffs = DriftResult['diffs']

/**
 * Drift is scoped to what Prisma's read model actually returns. The full
 * `roleIds` multi-role assignment is write-only from this app's point of view
 * (GET only ever returns the single active roleId), so it is intentionally NOT
 * compared here — only the default/active role is.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractUserSpecs(ctx.deployedConfig).filter((s) => s.email)
  const res = await client.get(V2)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveUser[]>(res.body) ?? []
  const liveByEmail = new Map(live.filter((u) => u.email).map((u) => [u.email!.toLowerCase(), u]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const u = liveByEmail.get(spec.email.toLowerCase())
    if (!u) {
      diffs.push({ field: spec.email, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((u.firstName ?? '') !== spec.firstName) {
      diffs.push({ field: `${spec.email}.firstName`, expected: spec.firstName, actual: u.firstName ?? '', severity: 'warning' })
    }
    if ((u.lastName ?? '') !== spec.lastName) {
      diffs.push({ field: `${spec.email}.lastName`, expected: spec.lastName, actual: u.lastName ?? '', severity: 'warning' })
    }
    if ((u.timeZone ?? '') !== spec.timeZone) {
      diffs.push({ field: `${spec.email}.timeZone`, expected: spec.timeZone, actual: u.timeZone ?? '', severity: 'warning' })
    }
    if ((u.roleId ?? '') !== spec.defaultRoleId) {
      diffs.push({ field: `${spec.email}.defaultRoleId`, expected: spec.defaultRoleId, actual: u.roleId ?? '', severity: 'warning' })
    }
    if ((u.accessKeysAllowed ?? false) !== spec.accessKeysAllowed) {
      diffs.push({
        field: `${spec.email}.accessKeysAllowed`,
        expected: String(spec.accessKeysAllowed),
        actual: String(u.accessKeysAllowed ?? false),
        severity: 'warning',
      })
    }
    if ((u.enabled ?? true) !== spec.enabled) {
      diffs.push({ field: `${spec.email}.enabled`, expected: String(spec.enabled), actual: String(u.enabled ?? true), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
