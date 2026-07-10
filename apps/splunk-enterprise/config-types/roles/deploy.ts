import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, getEntityContent, postForm } from '../../lib/splunkApi'

/**
 * Deploy role configuration to a Splunk component via the REST API
 * (/services/authorization/roles).
 *
 * Canvas → Splunk REST parameter mapping:
 *   capabilities       → capabilities        (multi-value)
 *   importedRoles      → imported_roles      (multi-value)
 *   srchFilter         → srchFilter
 *   srchIndexesAllowed → srchIndexesAllowed  (multi-value)
 *   srchIndexesDefault → srchIndexesDefault  (multi-value)
 *   srchDiskQuota      → srchDiskQuota       (MB, 0 = unlimited)
 *   srchJobsQuota      → srchJobsQuota       (0 = unlimited)
 *   rtSrchJobsQuota    → rtSrchJobsQuota     (0 = unlimited)
 *   srchTimeWin        → srchTimeWin         (secs; -1 unset, 0 exempt)
 *   defaultApp         → defaultApp
 *
 * Multi-value parameters are appended once per element — a plain
 * key/value map would silently keep only the last entry.
 */

/** Role settings snapshotted for rollback. */
const ROLLBACK_KEYS = [
  'capabilities',
  'imported_roles',
  'srchFilter',
  'srchIndexesAllowed',
  'srchIndexesDefault',
  'srchDiskQuota',
  'srchJobsQuota',
  'rtSrchJobsQuota',
  'srchTimeWin',
  'defaultApp',
] as const

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx

  if (!credential || !connectivity) {
    return { success: false, message: 'Missing credential or connectivity for Splunk role deployment' }
  }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)
  const rollbackSnapshot: Record<string, unknown>[] = []
  const createdRoles: string[] = []
  const deployedRoles: string[] = []

  try {
    for (const section of canvas.sections) {
      const fields = section.fields
      const roleName = fields.name as string
      if (!roleName) continue

      const rolePath = `/services/authorization/roles/${encodeURIComponent(roleName)}`

      // Capture current state for rollback
      const existing = await getEntityContent(baseUrl, auth, rolePath)
      if (existing) {
        const snapshot: Record<string, unknown> = { name: roleName }
        for (const key of ROLLBACK_KEYS) {
          if (existing[key] !== undefined) snapshot[key] = existing[key]
        }
        rollbackSnapshot.push(snapshot)
      }

      const payload = buildRolePayload(fields)

      if (existing) {
        // Update — Splunk rejects the `name` argument on existing entities
        await postForm(baseUrl, auth, rolePath, payload)
      } else {
        await postForm(baseUrl, auth, '/services/authorization/roles', { name: roleName, ...payload })
        createdRoles.push(roleName)
      }

      deployedRoles.push(roleName)
    }

    return {
      success: true,
      message: `Deployed ${deployedRoles.length} role(s): ${deployedRoles.join(', ')}`,
      artifacts: { deployedRoles, createdRoles },
      rollbackData: { previousState: rollbackSnapshot, createdRoles },
    }
  } catch (error) {
    return {
      success: false,
      message: `Role deployment failed after ${deployedRoles.length} role(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { deployedRoles, createdRoles, failedAt: canvas.sections[deployedRoles.length]?.fields?.name },
      rollbackData: { previousState: rollbackSnapshot, createdRoles },
    }
  }
}

/** Map canvas fields to Splunk REST parameters (arrays become repeated params). */
function buildRolePayload(
  fields: Record<string, unknown>,
): Record<string, string | number | string[] | undefined> {
  return {
    capabilities: asStringArray(fields.capabilities),
    imported_roles: asStringArray(fields.importedRoles),
    srchIndexesAllowed: asStringArray(fields.srchIndexesAllowed),
    srchIndexesDefault: asStringArray(fields.srchIndexesDefault),
    srchFilter: typeof fields.srchFilter === 'string' && fields.srchFilter ? fields.srchFilter : undefined,
    srchDiskQuota: typeof fields.srchDiskQuota === 'number' ? fields.srchDiskQuota : undefined,
    srchJobsQuota: typeof fields.srchJobsQuota === 'number' ? fields.srchJobsQuota : undefined,
    rtSrchJobsQuota: typeof fields.rtSrchJobsQuota === 'number' ? fields.rtSrchJobsQuota : undefined,
    srchTimeWin: typeof fields.srchTimeWin === 'number' ? fields.srchTimeWin : undefined,
    defaultApp: typeof fields.defaultApp === 'string' && fields.defaultApp ? fields.defaultApp : undefined,
  }
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value.filter((v): v is string => typeof v === 'string')
}
