// =============================================================================
// Keycloak Realm Settings — deploy / rollback / healthCheck / driftDetect /
// getStatus driven end to end against the fake Keycloak.
//
// A realm-wide singleton over the FULL RealmRepresentation, which also carries
// smtpServer.password. _shared.ts states the rule explicitly: the full live
// representation is safe to send as the PUT body, but must NEVER be captured
// into rollbackData. That rule is asserted here, because nothing else catches
// a regression that starts persisting a customer's SMTP password.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import rollback from '../rollback'
import healthCheck from '../healthCheck'
import driftDetect from '../driftDetect'
import getStatus from '../getStatus'
import {
  ADMIN_BASE,
  TOKEN,
  adminPath,
  bodyOf,
  deployContext,
  driftContext,
  isTokenCall,
  item,
  kcError,
  leaksToken,
  noContent,
  ok,
  recordKeycloak,
  rollbackContext,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeKeycloak'
import { describeHealthCheckContract } from '../../../lib/__tests__/healthCheckContract'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

/** A secret RealmRepresentation carries but this config type does not author. */
const SMTP_PASSWORD = 'smtp-password-MUST-NOT-BE-PERSISTED'

const DESIRED = {
  accessTokenLifespan: 300,
  ssoSessionIdleTimeout: 1800,
  registrationAllowed: false,
  resetPasswordAllowed: true,
  rememberMe: false,
  verifyEmail: true,
  loginWithEmailAllowed: true,
  duplicateEmailsAllowed: false,
  bruteForceProtected: true,
  editUsernameAllowed: false,
  registrationEmailAsUsername: false,
  offlineSessionMaxLifespanEnabled: false,
  passwordPolicy: 'length(12) and notUsername',
}

function liveRealm(over: Record<string, unknown> = {}) {
  return {
    id: 'realm-uuid',
    realm: 'corp',
    accessTokenLifespan: 60,
    ssoSessionIdleTimeout: 1800,
    registrationAllowed: true,
    resetPasswordAllowed: true,
    rememberMe: false,
    verifyEmail: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    bruteForceProtected: false,
    editUsernameAllowed: false,
    registrationEmailAsUsername: false,
    offlineSessionMaxLifespanEnabled: false,
    passwordPolicy: 'length(8)',
    smtpServer: { host: 'smtp.example.com', user: 'noreply', password: SMTP_PASSWORD },
    ...over,
  }
}

// --- deploy -------------------------------------------------------------------

test('realm-settings deploy refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([item('settings', DESIRED)], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('realm-settings deploy refuses when the canvas declares nothing', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /No realm-settings configuration/)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('realm-settings deploy reads the live realm before it writes, and stops if that read fails', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await deploy(deployContext([item('settings', DESIRED)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /could not read the live realm representation/)
    assert.equal(writeCalls(calls).length, 0, 'a failed read must not be followed by a blind realm overwrite')
  } finally {
    restore()
  }
})

test('realm-settings deploy sends the full live realm with the declared fields overridden', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok(liveRealm()), noContent()])
  try {
    const result = await deploy(deployContext([item('settings', DESIRED)]))

    assert.ok(isTokenCall(calls[0]))
    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['GET ', 'PUT '],
    )
    assert.equal(vendor[0].path, ADMIN_BASE)

    const body = bodyOf(vendor[1]) as Record<string, unknown>
    assert.equal(body.accessTokenLifespan, 300, 'the declared value must win')
    assert.equal(body.registrationAllowed, false)
    assert.equal(body.verifyEmail, true)
    assert.equal(body.passwordPolicy, 'length(12) and notUsername')
    // Unauthored settings ride along unchanged, which is what stops the realm
    // update from resetting them.
    assert.deepEqual(body.smtpServer, { host: 'smtp.example.com', user: 'noreply', password: SMTP_PASSWORD })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('realm-settings deploy captures ONLY the narrow prior projection into rollbackData', async () => {
  const { restore } = recordKeycloak([TOKEN, ok(liveRealm()), noContent()])
  try {
    const result = await deploy(deployContext([item('settings', DESIRED)]))

    const prior = result.rollbackData as Record<string, unknown>
    assert.equal(prior.accessTokenLifespan, 60, 'the prior LIVE value, not the desired one')
    assert.equal(prior.registrationAllowed, true)
    assert.equal(prior.passwordPolicy, 'length(8)')

    // The platform persists rollbackData. A full realm representation in there
    // would put the customer's SMTP password into platform storage.
    assert.equal(prior.smtpServer, undefined)
    assert.equal(
      JSON.stringify(result).includes(SMTP_PASSWORD),
      false,
      'the realm SMTP password escaped into the deploy result',
    )
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('realm-settings deploy leaves an undeclared token lifespan out of the override entirely', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok(liveRealm({ accessCodeLifespan: 77 })), noContent()])
  try {
    await deploy(deployContext([item('settings', { ...DESIRED, accessTokenLifespan: '' })]))

    const body = bodyOf(vendorCalls(calls)[1]) as Record<string, unknown>
    // Not declared means not managed: the realm's own value survives.
    assert.equal(body.accessTokenLifespan, 60)
    assert.equal(body.accessCodeLifespan, 77)
  } finally {
    restore()
  }
})

test('realm-settings deploy reports failure rather than throwing when Keycloak rejects the write', async () => {
  const { restore } = recordKeycloak([TOKEN, ok(liveRealm()), kcError(400, 'Invalid password policy')])
  try {
    const result = await deploy(deployContext([item('settings', DESIRED)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /400/)
  } finally {
    restore()
  }
})

// --- rollback -----------------------------------------------------------------

test('realm-settings rollback refuses when no prior projection was recorded', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(rollbackContext(undefined))

    assert.equal(result.success, false)
    assert.match(String(result.message), /No previous state/)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('realm-settings rollback refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(rollbackContext({ accessTokenLifespan: 60 }, { credential: null }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('realm-settings rollback re-reads the realm fresh and overlays the prior projection', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok(liveRealm({ accessTokenLifespan: 300, registrationAllowed: false })), noContent()])
  try {
    const result = await rollback(
      rollbackContext({ accessTokenLifespan: 60, registrationAllowed: true, passwordPolicy: 'length(8)' }),
    )

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => c.method),
      ['GET', 'PUT'],
    )
    const body = bodyOf(vendor[1]) as Record<string, unknown>
    assert.equal(body.accessTokenLifespan, 60)
    assert.equal(body.registrationAllowed, true)
    assert.equal(body.passwordPolicy, 'length(8)')
    // Reading fresh is what keeps the rest of the realm at its CURRENT state
    // rather than resurrecting a stale snapshot.
    assert.deepEqual(body.smtpServer, { host: 'smtp.example.com', user: 'noreply', password: SMTP_PASSWORD })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('realm-settings rollback stops before writing when the realm cannot be read', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await rollback(rollbackContext({ accessTokenLifespan: 60 }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /could not read the live realm representation/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('realm-settings rollback reports failure rather than throwing when the write is rejected', async () => {
  const { restore } = recordKeycloak([TOKEN, ok(liveRealm()), kcError(500, 'boom')])
  try {
    const result = await rollback(rollbackContext({ accessTokenLifespan: 60 }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback failed/)
  } finally {
    restore()
  }
})

// --- driftDetect --------------------------------------------------------------

test('realm-settings driftDetect reports no drift and makes no calls without a credential', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([item('settings', DESIRED)], { credential: null }))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('realm-settings driftDetect reports no drift when the live realm matches', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    ok(liveRealm({
      accessTokenLifespan: 300,
      registrationAllowed: false,
      verifyEmail: true,
      bruteForceProtected: true,
      passwordPolicy: 'length(12) and notUsername',
    })),
  ])
  try {
    const result = await driftDetect(driftContext([item('settings', DESIRED)]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must be read-only')
  } finally {
    restore()
  }
})

test('realm-settings driftDetect reports security flags flipped in the console', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    ok(liveRealm({ accessTokenLifespan: 300, passwordPolicy: 'length(12) and notUsername' })),
  ])
  try {
    const result = await driftDetect(driftContext([item('settings', DESIRED)]))

    assert.equal(result.hasDrift, true)
    // Self-registration re-enabled and brute-force protection turned off are
    // exactly the changes this config type exists to catch.
    const fields = result.diffs.map((d) => d.field)
    assert.ok(fields.includes('registrationAllowed'))
    assert.ok(fields.includes('verifyEmail'))
    assert.ok(fields.includes('bruteForceProtected'))
  } finally {
    restore()
  }
})

test('realm-settings driftDetect ignores a token lifespan the canvas does not declare', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    ok(liveRealm({
      accessTokenLifespan: 99999,
      registrationAllowed: false,
      verifyEmail: true,
      bruteForceProtected: true,
      passwordPolicy: 'length(12) and notUsername',
    })),
  ])
  try {
    const result = await driftDetect(driftContext([item('settings', { ...DESIRED, accessTokenLifespan: '' })]))

    assert.equal(result.hasDrift, false, 'an undeclared field is not managed, so it cannot drift')
  } finally {
    restore()
  }
})

test('realm-settings driftDetect reports a weakened password policy', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    ok(liveRealm({
      accessTokenLifespan: 300,
      registrationAllowed: false,
      verifyEmail: true,
      bruteForceProtected: true,
      passwordPolicy: 'length(4)',
    })),
  ])
  try {
    const result = await driftDetect(driftContext([item('settings', DESIRED)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['passwordPolicy'],
    )
    assert.equal(result.diffs[0].actual, 'length(4)')
  } finally {
    restore()
  }
})

test('realm-settings driftDetect asserts nothing when the realm cannot be read', async () => {
  const { restore } = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await driftDetect(driftContext([item('settings', DESIRED)]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

// --- healthCheck / getStatus --------------------------------------------------

describeHealthCheckContract('realm-settings', healthCheck)
describeGetStatusContract('realm-settings', getStatus, 'keycloak-realm-settings')
