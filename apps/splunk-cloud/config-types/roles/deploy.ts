import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  REST_TOKEN_MISSING,
  buildAuthHeader,
  buildRestUrl,
  getEntityContent,
  postForm,
  readRestSettings,
  resolveRestToken,
  resolveStackHost,
} from '../../lib/splunkRest'
import { ROLE_QUOTA_FIELDS, extractRoleSpecs, normalizeLiveList, type RoleSpec } from './validate'

/**
 * Deploy role configuration to a Splunk Cloud stack over the Splunk Cloud
 * Platform REST API — NOT ACS, which cannot manage identity:
 *
 *   read:    GET  /services/authorization/roles/<role>
 *   create:  POST /services/authorization/roles              (name=<role>)
 *   update:  POST /services/authorization/roles/<role>
 *
 * on https://<stack>.splunkcloud.com:8089, authenticated with a Splunk
 * authentication token (Bearer). Requires that Splunk Support has opened port
 * 8089 and that this caller's IP is on the stack's `search-api` allow list —
 * both are named in every failure message (see lib/splunkRest.ts).
 *
 * Canvas → Splunk REST parameter mapping:
 *   importedRoles             → imported_roles              (multi-value)
 *   capabilities              → capabilities                (multi-value)
 *   srchIndexesAllowed        → srchIndexesAllowed          (multi-value)
 *   srchIndexesDefault        → srchIndexesDefault          (multi-value)
 *   srchFilter                → srchFilter
 *   srchTimeWin               → srchTimeWin
 *   defaultApp                → defaultApp
 *   srchJobsQuota             → srchJobsQuota
 *   rtSrchJobsQuota           → rtSrchJobsQuota
 *   srchDiskQuota             → srchDiskQuota
 *   cumulativeSrchJobsQuota   → cumulativeSrchJobsQuota
 *   cumulativeRTSrchJobsQuota → cumulativeRTSrchJobsQuota
 *
 * A field left blank on the canvas is NOT sent, so the role keeps whatever it
 * inherits or already has — this app only manages what the canvas declares.
 */

export const ROLES_BASE_PATH = '/services/authorization/roles'

/** REST parameters snapshotted from the live role for rollback. */
const ROLLBACK_KEYS = [
  'imported_roles',
  'capabilities',
  'srchIndexesAllowed',
  'srchIndexesDefault',
  'srchFilter',
  'srchTimeWin',
  'defaultApp',
  ...ROLE_QUOTA_FIELDS,
] as const

export interface RoleRollbackEntry {
  name: string
  existed: boolean
  /** Prior REST parameter values, captured only when the role already existed. */
  prior?: Record<string, unknown>
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const token = resolveRestToken(ctx.credential)
  if (!token) {
    return { success: false, message: REST_TOKEN_MISSING }
  }

  const { timeoutMs } = readRestSettings(ctx.settings)
  const stack = resolveStackHost(ctx.component.hostname)
  const baseUrl = buildRestUrl(ctx.component)
  const auth = buildAuthHeader(token)

  const specs = extractRoleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: RoleRollbackEntry[] = []
  const createdRoles: string[] = []
  const deployedRoles: string[] = []

  try {
    for (const spec of specs) {
      const rolePath = `${ROLES_BASE_PATH}/${encodeURIComponent(spec.name)}`

      // Capture prior state for rollback. A connection/auth failure throws here
      // rather than being mistaken for "role does not exist".
      const existing = await getEntityContent(baseUrl, auth, rolePath, timeoutMs)

      if (existing) {
        const prior: Record<string, unknown> = {}
        for (const key of ROLLBACK_KEYS) {
          if (existing[key] !== undefined) prior[key] = existing[key]
        }
        rollbackState.push({ name: spec.name, existed: true, prior })
        await postForm(baseUrl, auth, rolePath, buildRolePayload(spec), timeoutMs)
      } else {
        await postForm(
          baseUrl,
          auth,
          ROLES_BASE_PATH,
          { name: spec.name, ...buildRolePayload(spec) },
          timeoutMs,
        )
        rollbackState.push({ name: spec.name, existed: false })
        createdRoles.push(spec.name)
      }

      deployedRoles.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployedRoles.length} role(s) to stack "${stack}": ${deployedRoles.join(', ')}`,
      artifacts: { stack, endpoint: `${baseUrl}${ROLES_BASE_PATH}`, deployedRoles, createdRoles },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Role deployment to stack "${stack}" failed after ${deployedRoles.length} of ${specs.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: {
        stack,
        deployedRoles,
        createdRoles,
        failedAt: specs[deployedRoles.length]?.name,
      },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

/**
 * Map canvas fields to Splunk REST parameters. Only fields the canvas actually
 * declares are included — an omitted field is left untouched on the role.
 */
export function buildRolePayload(
  spec: RoleSpec,
): Record<string, string | number | string[] | undefined> {
  const payload: Record<string, string | number | string[] | undefined> = {}

  if (spec.importedRoles) payload.imported_roles = spec.importedRoles
  if (spec.capabilities) payload.capabilities = spec.capabilities
  if (spec.srchIndexesAllowed) payload.srchIndexesAllowed = spec.srchIndexesAllowed
  if (spec.srchIndexesDefault) payload.srchIndexesDefault = spec.srchIndexesDefault
  if (spec.srchFilter !== undefined) payload.srchFilter = spec.srchFilter
  if (spec.srchTimeWin !== undefined) payload.srchTimeWin = spec.srchTimeWin
  if (spec.defaultApp !== undefined) payload.defaultApp = spec.defaultApp

  for (const key of ROLE_QUOTA_FIELDS) {
    const value = spec.quotas[key]
    if (value !== undefined) payload[key] = value
  }

  return payload
}

/**
 * Rebuild a REST payload from a rollback snapshot. Splunk replaces a
 * multi-value parameter with whatever is posted, so a list that was previously
 * EMPTY must be sent as an empty string to clear it — omitting the key would
 * leave the deploy's values in place.
 */
export function buildRestorePayload(
  prior: Record<string, unknown>,
): Record<string, string | number | string[] | undefined> {
  const payload: Record<string, string | number | string[] | undefined> = {}

  for (const key of ['imported_roles', 'capabilities', 'srchIndexesAllowed', 'srchIndexesDefault'] as const) {
    if (!(key in prior)) continue
    const list = normalizeLiveList(prior[key])
    payload[key] = list.length > 0 ? list : ''
  }

  for (const key of ['srchFilter', 'defaultApp', 'srchTimeWin', ...ROLE_QUOTA_FIELDS] as const) {
    const value = prior[key]
    if (value === undefined || value === null) continue
    payload[key] = String(value)
  }

  return payload
}
