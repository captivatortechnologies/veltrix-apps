import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import {
  extractAuthorizationPolicySpecs,
  parseObject,
  type AuthorizationPolicySpec,
  type LiveAuthorizationPolicy,
} from './validate'
import { buildIdNameMap, resolveByIdOrNameMany } from '../lib/nameMaps'

const PATH = '/policies/authorizationPolicy'
const SELECT =
  '?$select=id,allowInvitesFrom,allowedToUseSSPR,allowUserConsentForRiskyApps,blockMsolPowerShell,' +
  'allowEmailVerifiedUsersToJoinOrganization,allowedToSignUpEmailBasedSubscriptions,guestUserRoleId,defaultUserRolePermissions'

/** The literal prefix Graph requires on each defaultUserRolePermissions.permissionGrantPoliciesAssigned
 *  entry — "Value should be in the format managePermissionGrantsForSelf.{id}"
 *  (https://learn.microsoft.com/graph/api/resources/defaultuserrolepermissions). */
const PERMISSION_GRANT_PREFIX = 'managePermissionGrantsForSelf.'

export function formatPermissionGrantPolicyAssignment(policyId: string): string {
  return `${PERMISSION_GRANT_PREFIX}${policyId}`
}

export interface RollbackEntry {
  existed: boolean
  prior?: Record<string, unknown>
}

/**
 * PATCH body: the always-managed booleans plus the optional keys the spec
 * sets. `resolvedPermissionGrantPolicyIds` — already resolved+missing-checked
 * by the caller — is formatted and merged into defaultUserRolePermissions,
 * TAKING PRECEDENCE over a same-named key hand-authored in the raw JSON field
 * (see canvas.yaml for the documented precedence rule). An empty resolved
 * list means "the picker isn't managing this" (not "clear it to empty") — the
 * JSON field is left as the only way to explicitly set an empty list.
 */
export function buildBody(spec: AuthorizationPolicySpec, resolvedPermissionGrantPolicyIds: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    allowedToUseSSPR: spec.allowedToUseSSPR,
    allowUserConsentForRiskyApps: spec.allowUserConsentForRiskyApps,
    blockMsolPowerShell: spec.blockMsolPowerShell,
    allowEmailVerifiedUsersToJoinOrganization: spec.allowEmailVerifiedUsersToJoinOrganization,
    allowedToSignUpEmailBasedSubscriptions: spec.allowedToSignUpEmailBasedSubscriptions,
  }
  if (spec.allowInvitesFrom) body.allowInvitesFrom = spec.allowInvitesFrom
  if (spec.guestUserRoleId) body.guestUserRoleId = spec.guestUserRoleId

  const perms = spec.defaultUserRolePermissions ? parseObject(spec.defaultUserRolePermissions) : null
  let permsBody: Record<string, unknown> | null = perms ? { ...perms } : null
  if (resolvedPermissionGrantPolicyIds.length) {
    permsBody = {
      ...(permsBody ?? {}),
      permissionGrantPoliciesAssigned: resolvedPermissionGrantPolicyIds.map(formatPermissionGrantPolicyAssignment),
    }
  }
  if (permsBody) body.defaultUserRolePermissions = permsBody
  return body
}

/** Snapshot the managed keys from the live policy so rollback can restore them. */
function snapshotLive(live: LiveAuthorizationPolicy): Record<string, unknown> {
  return {
    allowInvitesFrom: live.allowInvitesFrom,
    allowedToUseSSPR: live.allowedToUseSSPR ?? false,
    allowUserConsentForRiskyApps: live.allowUserConsentForRiskyApps ?? false,
    blockMsolPowerShell: live.blockMsolPowerShell ?? false,
    allowEmailVerifiedUsersToJoinOrganization: live.allowEmailVerifiedUsersToJoinOrganization ?? false,
    allowedToSignUpEmailBasedSubscriptions: live.allowedToSignUpEmailBasedSubscriptions ?? false,
    guestUserRoleId: live.guestUserRoleId ?? null,
    defaultUserRolePermissions: live.defaultUserRolePermissions ?? null,
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const spec = extractAuthorizationPolicySpecs(ctx.canvas)[0]
  if (!spec) return { success: true, message: 'No authorization policy configured', rollbackData: { entries: [] } }

  // permissionGrantPoliciesAssigned resolves against the live tenant — a
  // picker-selected id passes straight through; a hand-typed id or display
  // name also resolves (ids are client-supplied kebab strings, not GUIDs, so
  // this uses id-set-or-name resolution — see lib/nameMaps.ts's header). This
  // is checked BEFORE the single monolithic PATCH below: unlike a per-item
  // deploy loop elsewhere in this app, one bad reference here would otherwise
  // block every other field in the same PATCH, so resolution failures abort
  // the whole deploy rather than silently dropping the key.
  const permissionGrantPolicyMap = await buildIdNameMap(client, '/policies/permissionGrantPolicies?$select=id,displayName')
  const pgpResolution = resolveByIdOrNameMany(spec.permissionGrantPoliciesAssigned, permissionGrantPolicyMap)
  if (pgpResolution.missing.length) {
    return {
      success: false,
      message: `Unknown permission grant policy(ies): ${pgpResolution.missing.join(', ')} — create/verify them first or fix the id`,
    }
  }

  const getResp = await client.get(`${PATH}${SELECT}`)
  if (!getResp.ok) {
    return { success: false, message: `Failed to read authorization policy: ${graphErrorMessage(getResp)}` }
  }
  const live = parseJson<LiveAuthorizationPolicy>(getResp.body) ?? {}

  const resp = await client.patch(PATH, buildBody(spec, pgpResolution.ids))
  if (!resp.ok) {
    return { success: false, message: `Failed to update authorization policy: ${graphErrorMessage(resp)}` }
  }

  const entries: RollbackEntry[] = [{ existed: true, prior: snapshotLive(live) }]
  return { success: true, message: 'Updated the tenant authorization policy', rollbackData: { entries } }
}
