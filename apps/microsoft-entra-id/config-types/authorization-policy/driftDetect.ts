import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, parseJson, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import {
  canonicalObject,
  extractAuthorizationPolicySpecs,
  parseObject,
  type LiveAuthorizationPolicy,
} from './validate'

const PATH = '/policies/authorizationPolicy'
const SELECT =
  '?$select=id,allowInvitesFrom,allowedToUseSSPR,allowUserConsentForRiskyApps,blockMsolPowerShell,' +
  'allowEmailVerifiedUsersToJoinOrganization,allowedToSignUpEmailBasedSubscriptions,guestUserRoleId,defaultUserRolePermissions'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const spec = extractAuthorizationPolicySpecs(ctx.deployedConfig)[0]
  if (!spec) return { hasDrift: false, diffs: [] }

  const resp = await client.get(`${PATH}${SELECT}`)
  if (!resp.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveAuthorizationPolicy>(resp.body) ?? {}

  const diffs: Diffs = []
  const bool = (field: string, want: boolean, actual: boolean | undefined) => {
    if (want !== (actual === true)) {
      diffs.push({ field, expected: String(want), actual: String(actual === true), severity: 'warning' })
    }
  }

  bool('allowedToUseSSPR', spec.allowedToUseSSPR, live.allowedToUseSSPR)
  bool('allowUserConsentForRiskyApps', spec.allowUserConsentForRiskyApps, live.allowUserConsentForRiskyApps)
  bool('blockMsolPowerShell', spec.blockMsolPowerShell, live.blockMsolPowerShell)
  bool(
    'allowEmailVerifiedUsersToJoinOrganization',
    spec.allowEmailVerifiedUsersToJoinOrganization,
    live.allowEmailVerifiedUsersToJoinOrganization,
  )
  bool(
    'allowedToSignUpEmailBasedSubscriptions',
    spec.allowedToSignUpEmailBasedSubscriptions,
    live.allowedToSignUpEmailBasedSubscriptions,
  )

  if (spec.allowInvitesFrom && spec.allowInvitesFrom !== (live.allowInvitesFrom ?? '')) {
    diffs.push({
      field: 'allowInvitesFrom',
      expected: spec.allowInvitesFrom,
      actual: live.allowInvitesFrom ?? '',
      severity: 'warning',
    })
  }
  if (spec.guestUserRoleId && spec.guestUserRoleId !== (live.guestUserRoleId ?? '')) {
    diffs.push({
      field: 'guestUserRoleId',
      expected: spec.guestUserRoleId,
      actual: live.guestUserRoleId ?? '',
      severity: 'warning',
    })
  }
  const wantPerms = spec.defaultUserRolePermissions ? parseObject(spec.defaultUserRolePermissions) : null
  if (wantPerms) {
    const want = canonicalObject(wantPerms)
    const actual = canonicalObject(live.defaultUserRolePermissions ?? {})
    if (want !== actual) {
      diffs.push({ field: 'defaultUserRolePermissions', expected: want, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
