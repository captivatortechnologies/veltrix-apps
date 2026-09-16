import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  deployContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  resource,
  routeFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy, { buildBody, formatPermissionGrantPolicyAssignment } from '../deploy'
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

// ============================================================================
// deploy, end to end against a fake Microsoft Graph.
//
// Everything above tests `buildBody` in isolation. What follows drives the
// DEFAULT export — the handler that actually PATCHes a customer's tenant
// authorization policy. This singleton decides who may invite guests, what a
// guest can read, whether users may consent to apps and whether legacy MSOL
// PowerShell still works, so the assertions are about the bytes on the wire:
// which fields are sent, which are deliberately NOT sent, and that the prior
// values rollback depends on are the tenant's own, not the canvas's.
// ============================================================================

/** GET /policies/permissionGrantPolicies?$select=id,displayName — the consent-policy map. */
const PGP_LIST = /\/policies\/permissionGrantPolicies\?/
/** GET /policies/authorizationPolicy?$select=... — the live singleton. */
const AUTHZ_READ = /\/policies\/authorizationPolicy\?/
/** PATCH /policies/authorizationPolicy — the single write this handler makes. */
const AUTHZ_WRITE = /\/policies\/authorizationPolicy$/

const RESTRICTED_GUEST = '2af84b1e-32c8-42b7-82bc-daa82404023b'

/** A live policy at its loosest — everything this app manages is switched on. */
const LIVE_LOOSE = {
  id: 'authorizationPolicy',
  allowInvitesFrom: 'everyone',
  allowedToUseSSPR: true,
  allowUserConsentForRiskyApps: true,
  blockMsolPowerShell: false,
  allowEmailVerifiedUsersToJoinOrganization: true,
  allowedToSignUpEmailBasedSubscriptions: true,
  guestUserRoleId: 'a0b1b346-4d3e-4e8b-98f8-753987be4970',
  defaultUserRolePermissions: { allowedToCreateApps: true },
}

/** The canvas item, defaulting to defaults.yaml's "manage nothing" values. */
function authzItem(fields: Record<string, unknown> = {}) {
  return item('Authorization Policy', {
    allowInvitesFrom: '',
    guestUserRoleId: '',
    allowedToUseSSPR: false,
    allowUserConsentForRiskyApps: false,
    blockMsolPowerShell: false,
    allowEmailVerifiedUsersToJoinOrganization: false,
    allowedToSignUpEmailBasedSubscriptions: false,
    ...fields,
  })
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([authzItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  // Client-credentials has no token endpoint without the directory (tenant) id,
  // so this must fail closed BEFORE any network call, not half way through.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([authzItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('an empty canvas leaves the tenant policy alone entirely', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
    assert.deepEqual(result.rollbackData, { entries: [] })
  } finally {
    restore()
  }
})

test('a failed read of the live policy stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: PGP_LIST, respond: collection([]) },
    { url: AUTHZ_READ, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await deploy(deployContext([authzItem({ blockMsolPowerShell: true })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to read authorization policy/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot read the prior values must not overwrite them — rollback would have nothing to restore',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first and PATCHes exactly the values the canvas declares', async () => {
  const { calls, restore } = routeFetch([
    { url: PGP_LIST, respond: collection([]) },
    { url: AUTHZ_READ, respond: resource(LIVE_LOOSE) },
    { url: AUTHZ_WRITE, method: 'PATCH', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(
      deployContext([
        authzItem({
          allowInvitesFrom: 'adminsAndGuestInviters',
          guestUserRoleId: RESTRICTED_GUEST,
          blockMsolPowerShell: true,
        }),
      ]),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls[0].method, 'GET', 'the consent-policy map is read before anything is written')

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'the whole policy is one PATCH — never a field at a time')
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith('/policies/authorizationPolicy'))
    assert.deepEqual(bodyOf(writes[0]), {
      allowedToUseSSPR: false,
      allowUserConsentForRiskyApps: false,
      blockMsolPowerShell: true,
      allowEmailVerifiedUsersToJoinOrganization: false,
      allowedToSignUpEmailBasedSubscriptions: false,
      allowInvitesFrom: 'adminsAndGuestInviters',
      guestUserRoleId: RESTRICTED_GUEST,
    })
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'the access token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('the two "do not manage" fields are omitted from the body, never sent empty', async () => {
  const { calls, restore } = routeFetch([
    { url: PGP_LIST, respond: collection([]) },
    { url: AUTHZ_READ, respond: resource(LIVE_LOOSE) },
    { url: AUTHZ_WRITE, method: 'PATCH', respond: NO_CONTENT },
  ])
  try {
    await deploy(deployContext([authzItem()]))

    const body = bodyOf(writeCalls(calls)[0])
    assert.ok(body)
    // Sending "" here would either 400 or reset a tenant setting this canvas
    // never claimed to manage — absence is the only safe encoding of "unset".
    assert.equal('allowInvitesFrom' in body, false)
    assert.equal('guestUserRoleId' in body, false)
    assert.equal('defaultUserRolePermissions' in body, false)
  } finally {
    restore()
  }
})

test('deploy records the LIVE prior policy, not the values it just sent', async () => {
  const { calls, restore } = routeFetch([
    { url: PGP_LIST, respond: collection([]) },
    { url: AUTHZ_READ, respond: resource(LIVE_LOOSE) },
    { url: AUTHZ_WRITE, method: 'PATCH', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(
      deployContext([authzItem({ allowInvitesFrom: 'none', blockMsolPowerShell: true })]),
    )

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, true, 'the singleton always pre-exists — it is never created')
    // Rollback has to put back what the tenant HAD, not what the canvas wanted.
    assert.deepEqual(entries[0].prior, {
      allowInvitesFrom: 'everyone',
      allowedToUseSSPR: true,
      allowUserConsentForRiskyApps: true,
      blockMsolPowerShell: false,
      allowEmailVerifiedUsersToJoinOrganization: true,
      allowedToSignUpEmailBasedSubscriptions: true,
      guestUserRoleId: 'a0b1b346-4d3e-4e8b-98f8-753987be4970',
      defaultUserRolePermissions: { allowedToCreateApps: true },
    })
    assert.notDeepEqual(entries[0].prior, bodyOf(writeCalls(calls)[0]))
  } finally {
    restore()
  }
})

test('a live policy missing the managed keys is snapshotted as off, never as undefined', async () => {
  const { restore } = routeFetch([
    { url: PGP_LIST, respond: collection([]) },
    { url: AUTHZ_READ, respond: resource({ id: 'authorizationPolicy' }) },
    { url: AUTHZ_WRITE, method: 'PATCH', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(deployContext([authzItem({ allowedToUseSSPR: true })]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    // Every managed boolean falls back to a concrete `false` rather than
    // undefined: JSON.stringify drops an undefined value, so an undefined prior
    // would make rollback a silent no-op for that field. allowInvitesFrom is
    // the deliberate exception — the tenant had none, so there is none to put
    // back.
    assert.deepEqual(entries[0].prior, {
      allowInvitesFrom: undefined,
      allowedToUseSSPR: false,
      allowUserConsentForRiskyApps: false,
      blockMsolPowerShell: false,
      allowEmailVerifiedUsersToJoinOrganization: false,
      allowedToSignUpEmailBasedSubscriptions: false,
      guestUserRoleId: null,
      defaultUserRolePermissions: null,
    })
  } finally {
    restore()
  }
})

test('a hand-typed consent policy name resolves to its live id and is formatted for Graph', async () => {
  const { calls, restore } = routeFetch([
    {
      url: PGP_LIST,
      respond: collection([
        { id: 'microsoft-user-default-low', displayName: 'Low risk consent' },
        { id: 'microsoft-user-default-legacy', displayName: 'Legacy consent' },
      ]),
    },
    { url: AUTHZ_READ, respond: resource(LIVE_LOOSE) },
    { url: AUTHZ_WRITE, method: 'PATCH', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(
      deployContext([authzItem({ permissionGrantPoliciesAssigned: ['Legacy consent'] })]),
    )

    const body = bodyOf(writeCalls(calls)[0])
    assert.ok(body)
    assert.deepEqual(body.defaultUserRolePermissions, {
      permissionGrantPoliciesAssigned: ['managePermissionGrantsForSelf.microsoft-user-default-legacy'],
    })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an unresolvable consent policy aborts the whole deploy without reading or writing the policy', async () => {
  const { calls, restore } = routeFetch([
    { url: PGP_LIST, respond: collection([{ id: 'microsoft-user-default-low', displayName: 'Low risk consent' }]) },
    { url: AUTHZ_READ, respond: resource(LIVE_LOOSE) },
    { url: AUTHZ_WRITE, method: 'PATCH', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(
      deployContext([authzItem({ permissionGrantPoliciesAssigned: ['ghost-consent-policy'] })]),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Unknown permission grant policy\(ies\): ghost-consent-policy/)
    assert.equal(writeCalls(calls).length, 0, 'one bad reference must not half-apply the rest of the same PATCH')
    assert.deepEqual(
      vendorCalls(calls).map((c) => c.method),
      ['GET'],
      'the abort happens before the live policy is even read',
    )
  } finally {
    restore()
  }
})

test('deploy reports a rejected write rather than throwing, and leaks no secret', async () => {
  const { restore } = routeFetch([
    { url: PGP_LIST, respond: collection([]) },
    { url: AUTHZ_READ, respond: resource(LIVE_LOOSE) },
    {
      url: AUTHZ_WRITE,
      method: 'PATCH',
      respond: graphError(400, 'Invalid value specified for property guestUserRoleId.', 'Request_BadRequest'),
    },
  ])
  try {
    const result = await deploy(deployContext([authzItem({ guestUserRoleId: RESTRICTED_GUEST })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to update authorization policy/)
    assert.match(String(result.message), /guestUserRoleId/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
