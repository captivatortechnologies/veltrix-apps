// ============================================================================
// driftDetect for the Entra tenant authorization policy.
//
// Every field here is a tenant-wide security control — who may invite guests,
// what a guest can read, whether users may consent to apps — so a portal edit
// that loosens one has to surface. The fiddly parts worth pinning down are the
// two-way comparison of the free-JSON defaultUserRolePermissions blob (compared
// MINUS the key the dedicated picker owns, so one drift is never reported
// twice) and the fact that an unresolvable consent policy is CRITICAL, not a
// silent pass.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collection,
  driftContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  resource,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

const PGP_LIST = /\/policies\/permissionGrantPolicies\?/
const AUTHZ_READ = /\/policies\/authorizationPolicy\?/

const LEGACY_CONSENT = 'microsoft-user-default-legacy'

/** A live policy matching the hardened canvas item below. */
function livePolicy(over: Record<string, unknown> = {}) {
  return resource({
    id: 'authorizationPolicy',
    allowInvitesFrom: 'adminsAndGuestInviters',
    allowedToUseSSPR: true,
    allowUserConsentForRiskyApps: false,
    blockMsolPowerShell: true,
    allowEmailVerifiedUsersToJoinOrganization: false,
    allowedToSignUpEmailBasedSubscriptions: false,
    guestUserRoleId: '2af84b1e-32c8-42b7-82bc-daa82404023b',
    defaultUserRolePermissions: null,
    ...over,
  })
}

/** The deployed canvas: guest invites restricted, MSOL PowerShell blocked. */
function authzItem(fields: Record<string, unknown> = {}) {
  return item('Authorization Policy', {
    allowInvitesFrom: 'adminsAndGuestInviters',
    guestUserRoleId: '2af84b1e-32c8-42b7-82bc-daa82404023b',
    allowedToUseSSPR: true,
    allowUserConsentForRiskyApps: false,
    blockMsolPowerShell: true,
    allowEmailVerifiedUsersToJoinOrganization: false,
    allowedToSignUpEmailBasedSubscriptions: false,
    ...fields,
  })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([authzItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('nothing deployed means nothing to compare — and no Graph call', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([], { deployedItems: [] }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed read reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([
    { url: AUTHZ_READ, respond: graphError(403, 'Insufficient privileges.') },
  ])
  try {
    const result = await driftDetect(driftContext([authzItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live policy matches the deployed canvas', async () => {
  const { calls, restore } = routeFetch([{ url: AUTHZ_READ, respond: livePolicy() }])
  try {
    const result = await driftDetect(driftContext([authzItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('guest invites reopened and MSOL PowerShell unblocked in the portal both surface', async () => {
  const { restore } = routeFetch([
    {
      url: AUTHZ_READ,
      respond: livePolicy({ allowInvitesFrom: 'everyone', blockMsolPowerShell: false }),
    },
  ])
  try {
    const result = await driftDetect(driftContext([authzItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.find((d) => d.field === 'blockMsolPowerShell'),
      { field: 'blockMsolPowerShell', expected: 'true', actual: 'false', severity: 'warning' },
    )
    assert.deepEqual(
      result.diffs.find((d) => d.field === 'allowInvitesFrom'),
      { field: 'allowInvitesFrom', expected: 'adminsAndGuestInviters', actual: 'everyone', severity: 'warning' },
    )
    assert.equal(leaksSecret(result), false, 'diffs are persisted by the platform — they must not carry the token')
  } finally {
    restore()
  }
})

test('a guest role widened from Restricted Guest to User surfaces with both ids', async () => {
  const { restore } = routeFetch([
    { url: AUTHZ_READ, respond: livePolicy({ guestUserRoleId: 'a0b1b346-4d3e-4e8b-98f8-753987be4970' }) },
  ])
  try {
    const result = await driftDetect(driftContext([authzItem()]))

    assert.deepEqual(
      result.diffs.find((d) => d.field === 'guestUserRoleId'),
      {
        field: 'guestUserRoleId',
        expected: '2af84b1e-32c8-42b7-82bc-daa82404023b',
        actual: 'a0b1b346-4d3e-4e8b-98f8-753987be4970',
        severity: 'warning',
      },
    )
  } finally {
    restore()
  }
})

test('a live policy that omits a managed boolean is read as off, not as "matches"', async () => {
  const { restore } = routeFetch([
    { url: AUTHZ_READ, respond: resource({ id: 'authorizationPolicy', allowInvitesFrom: 'adminsAndGuestInviters' }) },
  ])
  try {
    const result = await driftDetect(driftContext([authzItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.find((d) => d.field === 'allowedToUseSSPR'),
      { field: 'allowedToUseSSPR', expected: 'true', actual: 'false', severity: 'warning' },
    )
  } finally {
    restore()
  }
})

test('an unmanaged field ("" in the canvas) is never reported as drift', async () => {
  const { restore } = routeFetch([{ url: AUTHZ_READ, respond: livePolicy({ allowInvitesFrom: 'everyone' }) }])
  try {
    const result = await driftDetect(driftContext([authzItem({ allowInvitesFrom: '', guestUserRoleId: '' })]))

    assert.deepEqual(
      result.diffs.filter((d) => d.field === 'allowInvitesFrom' || d.field === 'guestUserRoleId'),
      [],
      'a field the canvas does not claim to manage cannot drift',
    )
  } finally {
    restore()
  }
})

test('the defaultUserRolePermissions blob is compared key-order-insensitively', async () => {
  const { restore } = routeFetch([
    {
      url: AUTHZ_READ,
      respond: livePolicy({
        defaultUserRolePermissions: { allowedToCreateSecurityGroups: false, allowedToCreateApps: false },
      }),
    },
  ])
  try {
    const result = await driftDetect(
      driftContext([
        authzItem({
          defaultUserRolePermissions: JSON.stringify({
            allowedToCreateApps: false,
            allowedToCreateSecurityGroups: false,
          }),
        }),
      ]),
    )

    assert.deepEqual(result.diffs, [], 'the same object written in another key order is not drift')
  } finally {
    restore()
  }
})

test('an app-creation permission re-enabled in the portal surfaces as a blob diff', async () => {
  const { restore } = routeFetch([
    { url: AUTHZ_READ, respond: livePolicy({ defaultUserRolePermissions: { allowedToCreateApps: true } }) },
  ])
  try {
    const result = await driftDetect(
      driftContext([authzItem({ defaultUserRolePermissions: JSON.stringify({ allowedToCreateApps: false }) })]),
    )

    assert.deepEqual(result.diffs, [
      {
        field: 'defaultUserRolePermissions',
        expected: '{"allowedToCreateApps":false}',
        actual: '{"allowedToCreateApps":true}',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('the picker-owned key is excluded from the blob comparison, so one drift is not reported twice', async () => {
  const { restore } = routeFetch([
    { url: PGP_LIST, respond: collection([{ id: LEGACY_CONSENT, displayName: 'Legacy consent' }]) },
    {
      url: AUTHZ_READ,
      respond: livePolicy({
        defaultUserRolePermissions: {
          allowedToCreateApps: false,
          permissionGrantPoliciesAssigned: [`managePermissionGrantsForSelf.${LEGACY_CONSENT}`],
        },
      }),
    },
  ])
  try {
    const result = await driftDetect(
      driftContext([
        authzItem({
          permissionGrantPoliciesAssigned: [LEGACY_CONSENT],
          defaultUserRolePermissions: JSON.stringify({
            allowedToCreateApps: false,
            permissionGrantPoliciesAssigned: ['managePermissionGrantsForSelf.stale'],
          }),
        }),
      ]),
    )

    // The picker wins at deploy time, so the stale JSON copy must not raise a
    // defaultUserRolePermissions diff of its own.
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('consent policies revoked in the portal surface as sorted expected/actual lists', async () => {
  const { restore } = routeFetch([
    { url: PGP_LIST, respond: collection([{ id: LEGACY_CONSENT, displayName: 'Legacy consent' }]) },
    { url: AUTHZ_READ, respond: livePolicy({ defaultUserRolePermissions: { permissionGrantPoliciesAssigned: [] } }) },
  ])
  try {
    const result = await driftDetect(driftContext([authzItem({ permissionGrantPoliciesAssigned: ['Legacy consent'] })]))

    assert.deepEqual(result.diffs, [
      {
        field: 'permissionGrantPoliciesAssigned',
        expected: `["managePermissionGrantsForSelf.${LEGACY_CONSENT}"]`,
        actual: '[]',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('a consent policy that no longer resolves is critical drift, not a silent pass', async () => {
  const { restore } = routeFetch([
    { url: PGP_LIST, respond: collection([]) },
    { url: AUTHZ_READ, respond: livePolicy() },
  ])
  try {
    const result = await driftDetect(
      driftContext([authzItem({ permissionGrantPoliciesAssigned: ['ghost-consent-policy'] })]),
    )

    assert.deepEqual(result.diffs, [
      {
        field: 'permissionGrantPoliciesAssigned',
        expected: 'resolvable',
        actual: 'unknown policy(ies): ghost-consent-policy',
        severity: 'critical',
      },
    ])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
