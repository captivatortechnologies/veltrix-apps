import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, parseJson, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import {
  canonicalObject,
  extractAuthorizationPolicySpecs,
  parseObject,
  type LiveAuthorizationPolicy,
} from './validate'
import { buildIdNameMap, resolveByIdOrNameMany } from '../lib/nameMaps'
import { formatPermissionGrantPolicyAssignment } from './deploy'

const PATH = '/policies/authorizationPolicy'
const SELECT =
  '?$select=id,allowInvitesFrom,allowedToUseSSPR,allowUserConsentForRiskyApps,blockMsolPowerShell,' +
  'allowEmailVerifiedUsersToJoinOrganization,allowedToSignUpEmailBasedSubscriptions,guestUserRoleId,defaultUserRolePermissions'

type Diffs = DriftResult['diffs']

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

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
  // Compare the JSON blob only on keys it doesn't share with the dedicated
  // picker below, to avoid double-reporting the same drift two different ways.
  if (wantPerms) {
    const { permissionGrantPoliciesAssigned: _ignored, ...rest } = wantPerms
    const liveRest = { ...(live.defaultUserRolePermissions ?? {}) } as Record<string, unknown>
    delete liveRest.permissionGrantPoliciesAssigned
    const want = canonicalObject(rest)
    const actual = canonicalObject(liveRest)
    if (want !== actual) {
      diffs.push({ field: 'defaultUserRolePermissions', expected: want, actual, severity: 'warning' })
    }
  }

  if (spec.permissionGrantPoliciesAssigned.length) {
    const permissionGrantPolicyMap = await buildIdNameMap(client, '/policies/permissionGrantPolicies?$select=id,displayName')
    const resolution = resolveByIdOrNameMany(spec.permissionGrantPoliciesAssigned, permissionGrantPolicyMap)
    if (resolution.missing.length) {
      diffs.push({
        field: 'permissionGrantPoliciesAssigned',
        expected: 'resolvable',
        actual: `unknown policy(ies): ${resolution.missing.join(', ')}`,
        severity: 'critical',
      })
    } else {
      const want = sortedJson(resolution.ids.map(formatPermissionGrantPolicyAssignment))
      const actual = sortedJson(
        Array.isArray(live.defaultUserRolePermissions?.permissionGrantPoliciesAssigned)
          ? (live.defaultUserRolePermissions!.permissionGrantPoliciesAssigned as string[])
          : []
      )
      if (want !== actual) {
        diffs.push({ field: 'permissionGrantPoliciesAssigned', expected: want, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
