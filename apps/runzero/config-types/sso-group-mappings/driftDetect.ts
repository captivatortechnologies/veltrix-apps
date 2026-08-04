import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, coerceList } from '../../lib/runzeroApi'
import { resolveGroupId, findMapping, text, type RunzeroGroupMapping, type RunzeroGroupLite } from './_shared'

/**
 * Drift for SSO group mappings: compare the target group and description we declare against the
 * live mapping in runZero, matched by (sso_attribute, sso_value). A declared mapping that is
 * missing entirely is critical drift. Best-effort — if the mapping list can't be read (transient
 * error, or an Organization key without account scope) no drift is asserted rather than raising a
 * false positive. Read-only: GET /account/groups + GET /account/sso/groups.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig, settings } = ctx
  const items = deployedConfig.items ?? deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveRunzeroToken(credential)) return { hasDrift: false, diffs }

  const base = buildRunzeroUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const rawTimeout = settings?.request_timeout_seconds
  const timeoutMs = typeof rawTimeout === 'number' && rawTimeout > 0 ? rawTimeout * 1000 : undefined

  let groups: RunzeroGroupLite[]
  let mappings: RunzeroGroupMapping[]
  try {
    groups = coerceList<RunzeroGroupLite>(await getJson<unknown>(`${base}/account/groups`, headers, timeoutMs))
    mappings = coerceList<RunzeroGroupMapping>(await getJson<unknown>(`${base}/account/sso/groups`, headers, timeoutMs))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read mappings, no drift asserted
  }

  for (const item of items) {
    const ssoAttribute = text(item.fields.ssoAttribute)
    const ssoValue = text(item.fields.ssoValue)
    if (!ssoAttribute || !ssoValue) continue
    const label = `${ssoAttribute}=${ssoValue}`

    const match = findMapping(mappings, ssoAttribute, ssoValue)
    if (!match) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedGroupId = resolveGroupId(groups, item.fields.group)
    const actualGroupId = text(match.group_id)
    if (expectedGroupId && expectedGroupId !== actualGroupId) {
      diffs.push({ field: `${label}.group`, expected: expectedGroupId, actual: actualGroupId, severity: 'critical' })
    }

    const expectedDescription = text(item.fields.description)
    const actualDescription = text(match.description)
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${label}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
