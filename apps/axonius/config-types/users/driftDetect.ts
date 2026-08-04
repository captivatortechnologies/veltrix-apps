import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, getJson, verifyTls } from '../../lib/axoniusApi'
import { USERS_LIST_RESOURCE, usersFromResponse, findUser, parseText, parseBool } from './_shared'

/**
 * Drift for users: compare role_name (by resolving the live role_id back to a
 * name is skipped — instead we resolve OUR declared role_name to an id and
 * compare ids, avoiding a second round trip's ordering complexity), email,
 * names, title, department and the role-assignment-rules flag against the
 * live user. Read-only: GET api/settings/users + GET api/settings/roles.
 * Best-effort.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }
  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) return { hasDrift: false, diffs }

  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)

  let live
  try {
    live = usersFromResponse(await getJson<unknown>(apiUrl(base, settings, USERS_LIST_RESOURCE), headers, { verifyTls: verifyTls(settings) }))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read users, no drift asserted
  }

  for (const item of items) {
    const userName = parseText(item.fields.user_name)
    if (!userName) continue
    const match = findUser(live, userName)

    if (!match) {
      diffs.push({ field: `${userName}.exists`, expected: true, actual: false, severity: 'critical' })
      continue
    }

    const expectedRoleName = parseText(item.fields.role_name)
    const actualRoleName = String(match.role_name ?? '').trim()
    if (expectedRoleName && actualRoleName && expectedRoleName !== actualRoleName) {
      diffs.push({ field: `${userName}.role_name`, expected: expectedRoleName, actual: actualRoleName, severity: 'warning' })
    }

    const scalarChecks: Array<[string, string, string]> = [
      ['email', parseText(item.fields.email), String(match.email ?? '').trim()],
      ['first_name', parseText(item.fields.first_name), String(match.first_name ?? '').trim()],
      ['last_name', parseText(item.fields.last_name), String(match.last_name ?? '').trim()],
      ['title', parseText(item.fields.title), String(match.title ?? '').trim()],
      ['department', parseText(item.fields.department), String(match.department ?? '').trim()],
    ]
    for (const [field, expected, actual] of scalarChecks) {
      if (expected !== actual) {
        diffs.push({ field: `${userName}.${field}`, expected, actual, severity: 'info' })
      }
    }

    const expectedIgnore = parseBool(item.fields.ignore_role_assignment_rules)
    const actualIgnore = match.ignore_role_assignment_rules === true
    if (expectedIgnore !== actualIgnore) {
      diffs.push({ field: `${userName}.ignore_role_assignment_rules`, expected: expectedIgnore, actual: actualIgnore, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
