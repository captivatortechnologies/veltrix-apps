import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGithubClient, parseJson } from '../../lib/githubApi'
import { desiredFromItem, type CustomRepositoryRole } from './_shared'

/**
 * Drift for custom repository roles: compare each declared role's settings
 * against its live state. Read-only — GET the org's custom repository roles
 * and match by name. Best-effort: an org whose roles can't be listed is
 * skipped rather than raising false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const listCache = new Map<string, CustomRepositoryRole[] | null>()

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    if (!desired.org || !desired.name) continue
    const fullName = `${desired.org}/${desired.name}`

    if (!listCache.has(desired.org)) {
      const res = await client.listCustomRepositoryRoles(desired.org)
      listCache.set(desired.org, res.ok ? parseJson<CustomRepositoryRole[]>(res.body) ?? [] : null)
    }
    const roles = listCache.get(desired.org)
    if (roles == null) continue // can't list — assert no drift

    const live = roles.find((r) => (r.name ?? '') === desired.name)
    if (!live) {
      diffs.push({ field: `${fullName}.exists`, expected: true, actual: false, severity: 'warning' })
      continue
    }

    if ((live.description ?? '') !== desired.description) {
      diffs.push({ field: `${fullName}.description`, expected: desired.description, actual: live.description ?? '', severity: 'warning' })
    }
    if ((live.base_role ?? '') !== desired.baseRole) {
      diffs.push({ field: `${fullName}.base_role`, expected: desired.baseRole, actual: live.base_role ?? '', severity: 'warning' })
    }
    const livePerms = [...(live.permissions ?? [])].sort()
    const desiredPerms = [...desired.permissions].sort()
    if (JSON.stringify(livePerms) !== JSON.stringify(desiredPerms)) {
      diffs.push({ field: `${fullName}.permissions`, expected: desiredPerms, actual: livePerms, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
