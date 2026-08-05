import { buildBody, formatPermissionGrantPolicyAssignment } from '../deploy'
import type { AuthorizationPolicySpec } from '../validate'

function baseSpec(overrides: Partial<AuthorizationPolicySpec> = {}): AuthorizationPolicySpec {
  return {
    itemId: 'i1',
    allowInvitesFrom: '',
    allowedToUseSSPR: false,
    allowUserConsentForRiskyApps: false,
    blockMsolPowerShell: false,
    allowEmailVerifiedUsersToJoinOrganization: false,
    allowedToSignUpEmailBasedSubscriptions: false,
    guestUserRoleId: '',
    defaultUserRolePermissions: '',
    permissionGrantPoliciesAssigned: [],
    ...overrides,
  }
}

describe('formatPermissionGrantPolicyAssignment', () => {
  it('prefixes a policy id with "managePermissionGrantsForSelf."', () => {
    expect(formatPermissionGrantPolicyAssignment('microsoft-user-default-legacy')).toBe(
      'managePermissionGrantsForSelf.microsoft-user-default-legacy',
    )
  })
})

describe('buildBody permissionGrantPoliciesAssigned precedence', () => {
  it('omits defaultUserRolePermissions entirely when neither the picker nor the JSON field is set', () => {
    const body = buildBody(baseSpec(), [])
    expect('defaultUserRolePermissions' in body).toBe(false)
  })

  it('formats resolved picker ids into defaultUserRolePermissions.permissionGrantPoliciesAssigned', () => {
    const body = buildBody(baseSpec(), ['microsoft-user-default-legacy', 'custom-policy'])
    expect(body.defaultUserRolePermissions).toEqual({
      permissionGrantPoliciesAssigned: [
        'managePermissionGrantsForSelf.microsoft-user-default-legacy',
        'managePermissionGrantsForSelf.custom-policy',
      ],
    })
  })

  it('the picker OVERRIDES a permissionGrantPoliciesAssigned key hand-authored in the JSON field', () => {
    const spec = baseSpec({
      defaultUserRolePermissions: JSON.stringify({
        allowedToCreateApps: false,
        permissionGrantPoliciesAssigned: ['managePermissionGrantsForSelf.stale-policy'],
      }),
    })
    const body = buildBody(spec, ['fresh-policy'])
    expect(body.defaultUserRolePermissions).toEqual({
      allowedToCreateApps: false,
      permissionGrantPoliciesAssigned: ['managePermissionGrantsForSelf.fresh-policy'],
    })
  })

  it('leaves a JSON-authored permissionGrantPoliciesAssigned (including an explicit empty list) untouched when the picker resolves nothing', () => {
    const spec = baseSpec({
      defaultUserRolePermissions: JSON.stringify({ permissionGrantPoliciesAssigned: [] }),
    })
    const body = buildBody(spec, [])
    expect(body.defaultUserRolePermissions).toEqual({ permissionGrantPoliciesAssigned: [] })
  })

  it('merges other defaultUserRolePermissions keys alongside the picker-resolved assignment', () => {
    const spec = baseSpec({ defaultUserRolePermissions: JSON.stringify({ allowedToCreateSecurityGroups: true }) })
    const body = buildBody(spec, ['p1'])
    expect(body.defaultUserRolePermissions).toEqual({
      allowedToCreateSecurityGroups: true,
      permissionGrantPoliciesAssigned: ['managePermissionGrantsForSelf.p1'],
    })
  })
})
