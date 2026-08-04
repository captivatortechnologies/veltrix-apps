import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, listAffectedItems } from '../../lib/wazuhApi'
import { specFromItem } from './_shared'

/**
 * Drift for API users: compare the declared `allow_run_as` flag and role NAME
 * set against live. Best-effort — if the manager can't be listed at all, no
 * drift is raised. `password` can never be compared — Wazuh never returns it
 * (see deploy.ts's module doc) — so it is never part of this diff. Extra live
 * users not declared here are not flagged (same no-cross-resource-pruning
 * philosophy as the other config types).
 */
interface WazuhUser {
  id: number
  username: string
  allow_run_as: boolean
  roles: number[]
}
interface WazuhNamedResource {
  id: number
  name: string
}

function setDiff(declared: string[], live: string[]): { missing: string[]; extra: string[] } {
  const declaredSet = new Set(declared)
  const liveSet = new Set(live)
  return {
    missing: declared.filter((n) => !liveSet.has(n)),
    extra: live.filter((n) => !declaredSet.has(n)),
  }
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  let baseUrl: string
  let auth: Record<string, string>
  try {
    const resolved = await getToken(component, connectivity, connectivityProvider, credential)
    baseUrl = resolved.baseUrl
    auth = bearerHeader(resolved.token)
  } catch {
    return { hasDrift: false, diffs }
  }

  let users: WazuhUser[]
  let rolesById: Map<number, string>
  try {
    users = await listAffectedItems<WazuhUser>(baseUrl, auth, '/security/users')
    rolesById = new Map((await listAffectedItems<WazuhNamedResource>(baseUrl, auth, '/security/roles')).map((r) => [r.id, r.name]))
  } catch {
    return { hasDrift: false, diffs }
  }
  const byUsername = new Map(users.map((u) => [u.username, u]))

  for (const item of items) {
    const spec = specFromItem(item)
    if (!spec.username) continue

    const found = byUsername.get(spec.username)
    if (!found) {
      diffs.push({ field: `${spec.username}`, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    if (found.allow_run_as !== spec.allowRunAs) {
      diffs.push({ field: `${spec.username}.allow_run_as`, expected: spec.allowRunAs, actual: found.allow_run_as, severity: 'warning' })
    }

    const liveRoleNames = found.roles.map((id) => rolesById.get(id) ?? `#${id}`)
    const roleDiff = setDiff(spec.roleNames, liveRoleNames)
    if (roleDiff.missing.length || roleDiff.extra.length) {
      diffs.push({ field: `${spec.username}.roles`, expected: spec.roleNames, actual: liveRoleNames, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
