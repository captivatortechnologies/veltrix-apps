import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, getJson, withSession } from '../../lib/beyondtrustApi'
import { findUserGroup, groupsFromList, str, toBool } from './_shared'

/**
 * Drift for user groups: compare what we declare against the live group in
 * BeyondInsight. A declared group that is MISSING is a warning; a present group
 * whose description / active flag differ is info (Password Safe has no update
 * endpoint, so these can only be corrected by delete + recreate). Best-effort and
 * read-only: GET /UserGroups inside a PS-Auth session. Verify against a live
 * BeyondTrust instance.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)

  let live
  try {
    live = await withSession(base, credential, async (cookie) =>
      groupsFromList(await getJson<unknown>(base, '/UserGroups', cookie)),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read groups, no drift asserted
  }

  for (const item of items) {
    const groupName = str(item.fields.groupName)
    if (!groupName) continue

    const match = findUserGroup(live, groupName)
    if (!match) {
      diffs.push({ field: groupName, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    const desiredDescription = str(item.fields.description)
    if (desiredDescription && str(match.Description) !== desiredDescription) {
      diffs.push({ field: `${groupName}.description`, expected: desiredDescription, actual: match.Description ?? '', severity: 'info' })
    }

    if (typeof match.IsActive === 'boolean') {
      const desiredActive = toBool(item.fields.isActive, true)
      if (match.IsActive !== desiredActive) {
        diffs.push({ field: `${groupName}.isActive`, expected: String(desiredActive), actual: String(match.IsActive), severity: 'info' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
