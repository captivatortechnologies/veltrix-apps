import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listUsers } from './deploy'
import { extractUserSpecs, userKey, type LiveUser } from './validate'

/**
 * Detect drift between the deployed user configuration and the live console.
 * Re-finds each declared user by login and diffs the managed non-secret fields
 * (name, email, enabled, role id, all-sites/all-asset-groups, superuser); a
 * missing user is critical drift. The password can never be diffed — the API
 * masks it on read — so it is intentionally excluded from drift detection.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractUserSpecs(ctx.deployedConfig).filter((s) => s.login && s.name && s.roleId)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listUsers(client)
    const byKey = new Map<string, LiveUser>(
      live.filter((u) => u.login).map((u) => [userKey({ login: u.login as string }), u]),
    )

    for (const spec of specs) {
      const found = byKey.get(userKey(spec))
      if (!found) {
        diffs.push({ field: spec.login, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.name ?? '') !== spec.name) {
        diffs.push({ field: `${spec.login}.name`, expected: spec.name, actual: found.name ?? 'not set', severity: 'warning' })
      }
      if (spec.email && (found.email ?? '') !== spec.email) {
        diffs.push({ field: `${spec.login}.email`, expected: spec.email, actual: found.email ?? 'not set', severity: 'info' })
      }
      if (Boolean(found.enabled) !== spec.enabled) {
        diffs.push({ field: `${spec.login}.enabled`, expected: String(spec.enabled), actual: String(Boolean(found.enabled)), severity: 'critical' })
      }
      if ((found.role?.id ?? '') !== spec.roleId) {
        diffs.push({ field: `${spec.login}.role`, expected: spec.roleId, actual: found.role?.id ?? 'not set', severity: 'critical' })
      }
      if (Boolean(found.role?.allSites) !== spec.allSites) {
        diffs.push({
          field: `${spec.login}.all_sites`,
          expected: String(spec.allSites),
          actual: String(Boolean(found.role?.allSites)),
          severity: 'warning',
        })
      }
      if (Boolean(found.role?.allAssetGroups) !== spec.allAssetGroups) {
        diffs.push({
          field: `${spec.login}.all_asset_groups`,
          expected: String(spec.allAssetGroups),
          actual: String(Boolean(found.role?.allAssetGroups)),
          severity: 'warning',
        })
      }
      if (Boolean(found.role?.superuser) !== spec.superuser) {
        diffs.push({
          field: `${spec.login}.superuser`,
          expected: String(spec.superuser),
          actual: String(Boolean(found.role?.superuser)),
          severity: 'critical',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'insightvm',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
