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

const PATH = '/policies/authorizationPolicy'
const SELECT =
  '?$select=id,allowInvitesFrom,allowedToUseSSPR,allowUserConsentForRiskyApps,blockMsolPowerShell,' +
  'allowEmailVerifiedUsersToJoinOrganization,allowedToSignUpEmailBasedSubscriptions,guestUserRoleId,defaultUserRolePermissions'

export interface RollbackEntry {
  existed: boolean
  prior?: Record<string, unknown>
}

/** PATCH body: the always-managed booleans plus the optional keys the spec sets. */
export function buildBody(spec: AuthorizationPolicySpec): Record<string, unknown> {
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
  if (perms) body.defaultUserRolePermissions = perms
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

  const getResp = await client.get(`${PATH}${SELECT}`)
  if (!getResp.ok) {
    return { success: false, message: `Failed to read authorization policy: ${graphErrorMessage(getResp)}` }
  }
  const live = parseJson<LiveAuthorizationPolicy>(getResp.body) ?? {}

  const resp = await client.patch(PATH, buildBody(spec))
  if (!resp.ok) {
    return { success: false, message: `Failed to update authorization policy: ${graphErrorMessage(resp)}` }
  }

  const entries: RollbackEntry[] = [{ existed: true, prior: snapshotLive(live) }]
  return { success: true, message: 'Updated the tenant authorization policy', rollbackData: { entries } }
}
