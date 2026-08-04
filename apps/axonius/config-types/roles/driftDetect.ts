import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, getJson, verifyTls } from '../../lib/axoniusApi'
import { ROLES_LIST_RESOURCE, rolesFromResponse, findRole, parseText, parseBool, parsePermissions } from './_shared'

/**
 * Drift for roles: compare the permissions object (deep JSON equality) and the
 * data-scope-restriction enabled flag against the live role. The data-scope
 * uuid itself is not re-resolved here (would need an extra read per role); only
 * the enabled flag is compared. Read-only: GET api/settings/roles. Best-effort.
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
    live = rolesFromResponse(await getJson<unknown>(apiUrl(base, settings, ROLES_LIST_RESOURCE), headers, { verifyTls: verifyTls(settings) }))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read roles, no drift asserted
  }

  for (const item of items) {
    const name = parseText(item.fields.name)
    if (!name) continue
    const match = findRole(live, name)

    if (!match) {
      diffs.push({ field: `${name}.exists`, expected: true, actual: false, severity: 'critical' })
      continue
    }

    const permissions = parsePermissions(item.fields.permissions)
    if (permissions.ok) {
      const actual = match.permissions ?? {}
      if (JSON.stringify(permissions.value) !== JSON.stringify(actual)) {
        diffs.push({ field: `${name}.permissions`, expected: permissions.value, actual, severity: 'warning' })
      }
    }

    const expectedEnabled = parseBool(item.fields.data_scope_enabled)
    const actualEnabled = match.data_scope_restriction?.enabled === true
    if (expectedEnabled !== actualEnabled) {
      diffs.push({ field: `${name}.data_scope_enabled`, expected: expectedEnabled, actual: actualEnabled, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
