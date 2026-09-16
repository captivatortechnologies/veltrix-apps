// =============================================================================
// Keycloak Required Actions — deploy / rollback / healthCheck / driftDetect /
// getStatus driven end to end against the fake Keycloak.
//
// A required action is what a realm forces a user through at login (verify
// email, configure OTP, update password). Turning one off, or making one a
// default for every new user by accident, is an authentication-wide change.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import rollback from '../rollback'
import healthCheck from '../healthCheck'
import driftDetect from '../driftDetect'
import getStatus from '../getStatus'
import {
  TOKEN,
  adminPath,
  bodyOf,
  created,
  deployContext,
  driftContext,
  isTokenCall,
  item,
  kcError,
  leaksToken,
  noContent,
  notFound,
  ok,
  recordKeycloak,
  rollbackContext,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeKeycloak'
import { describeHealthCheckContract } from '../../../lib/__tests__/healthCheckContract'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

const CONFIGURE_TOTP = {
  alias: 'CONFIGURE_TOTP',
  name: 'Configure OTP',
  enabled: true,
  defaultAction: true,
  priority: 10,
  config: {},
}

function liveAction(over: Record<string, unknown> = {}) {
  return {
    alias: 'CONFIGURE_TOTP',
    name: 'Configure OTP',
    providerId: 'CONFIGURE_TOTP',
    enabled: true,
    defaultAction: false,
    priority: 10,
    config: {},
    ...over,
  }
}

// --- deploy -------------------------------------------------------------------

test('required-actions deploy refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([item('totp', CONFIGURE_TOTP)], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('required-actions deploy updates an already-registered action without re-registering it', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok(liveAction()), noContent()])
  try {
    const result = await deploy(deployContext([item('totp', CONFIGURE_TOTP)]))

    assert.ok(isTokenCall(calls[0]))
    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['GET /authentication/required-actions/CONFIGURE_TOTP', 'PUT /authentication/required-actions/CONFIGURE_TOTP'],
    )
    const body = bodyOf(vendor[1]) as Record<string, unknown>
    assert.equal(body.defaultAction, true, 'the declared value must win on update')
    assert.equal(body.providerId, 'CONFIGURE_TOTP', 'providerId is immutable and carried from the live record')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('required-actions deploy registers an action the realm has not enabled, then configures it', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    notFound(), // not registered in this realm yet
    created(), // register-required-action
    ok(liveAction({ defaultAction: false })), // re-read the freshly registered action
    noContent(), // apply the declared configuration
  ])
  try {
    const result = await deploy(deployContext([item('totp', CONFIGURE_TOTP)]))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      [
        'GET /authentication/required-actions/CONFIGURE_TOTP',
        'POST /authentication/register-required-action',
        'GET /authentication/required-actions/CONFIGURE_TOTP',
        'PUT /authentication/required-actions/CONFIGURE_TOTP',
      ],
    )
    assert.deepEqual(bodyOf(vendor[1]), { providerId: 'CONFIGURE_TOTP', name: 'Configure OTP' })
    // A null prior body is what tells rollback to de-register rather than restore.
    assert.deepEqual((result.rollbackData as { previous: unknown[] }).previous, [
      { alias: 'CONFIGURE_TOTP', prior: null },
    ])
  } finally {
    restore()
  }
})

test('required-actions deploy fails loudly when the provider does not exist on the server', async () => {
  const { restore } = recordKeycloak([TOKEN, notFound(), kcError(400, 'Provider not found')])
  try {
    const result = await deploy(deployContext([item('totp', { ...CONFIGURE_TOTP, alias: 'NO_SUCH_ACTION' })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /register NO_SUCH_ACTION/)
    assert.match(String(result.message), /the provider may not exist on this server/)
  } finally {
    restore()
  }
})

test('required-actions deploy fails when a registration cannot be read back rather than writing blind', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, notFound(), created(), notFound()])
  try {
    const result = await deploy(deployContext([item('totp', CONFIGURE_TOTP)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /could not be re-read/)
    // The configuring PUT is never sent without a base to merge over.
    assert.equal(writeCalls(calls).filter((c) => c.method === 'PUT').length, 0)
  } finally {
    restore()
  }
})

test('required-actions deploy keeps the live priority when the canvas leaves it blank', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok(liveAction({ priority: 42 })), noContent()])
  try {
    await deploy(deployContext([item('totp', { ...CONFIGURE_TOTP, priority: '' })]))

    const body = bodyOf(vendorCalls(calls)[1]) as Record<string, unknown>
    assert.equal(body.priority, 42, 'leaving priority untouched must not silently reorder the action')
  } finally {
    restore()
  }
})

test('required-actions deploy replaces config wholesale rather than merging server-retained keys', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    ok(liveAction({ config: { 'stale.key': 'left-over' } })),
    noContent(),
  ])
  try {
    await deploy(deployContext([item('totp', { ...CONFIGURE_TOTP, config: { 'max.auth.age': '300' } })]))

    const body = bodyOf(vendorCalls(calls)[1]) as { config: Record<string, string> }
    assert.deepEqual(body.config, { 'max.auth.age': '300' })
  } finally {
    restore()
  }
})

test('required-actions deploy records the LIVE prior action for rollback, not the desired values', async () => {
  const { restore } = recordKeycloak([TOKEN, ok(liveAction({ enabled: true, defaultAction: false })), noContent()])
  try {
    const result = await deploy(deployContext([item('totp', { ...CONFIGURE_TOTP, enabled: false, defaultAction: true })]))

    const previous = (result.rollbackData as { previous: Array<{ prior: Record<string, unknown> }> }).previous
    assert.equal(previous[0].prior.enabled, true)
    assert.equal(previous[0].prior.defaultAction, false)
  } finally {
    restore()
  }
})

test('required-actions deploy skips an item with a blank alias without calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await deploy(deployContext([item('blank', { ...CONFIGURE_TOTP, alias: '' })]))

    assert.equal(result.success, true)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('required-actions deploy never puts the admin token in its result', async () => {
  const { restore } = recordKeycloak([TOKEN, ok(liveAction()), noContent()])
  try {
    const result = await deploy(deployContext([item('totp', CONFIGURE_TOTP)]))
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

// --- rollback -----------------------------------------------------------------

test('required-actions rollback does nothing, successfully, when there is no prior state', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(rollbackContext({ previous: [] }))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('required-actions rollback refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ alias: 'CONFIGURE_TOTP', prior: liveAction() }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('required-actions rollback restores the captured prior action verbatim', async () => {
  const prior = liveAction({ enabled: true, defaultAction: false })
  const { calls, restore } = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(rollbackContext({ previous: [{ alias: 'CONFIGURE_TOTP', prior }] }))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['PUT /authentication/required-actions/CONFIGURE_TOTP'],
    )
    assert.deepEqual(bodyOf(vendor[0]), prior)
    assert.match(String(result.message), /1 restored, 0 deleted/)
  } finally {
    restore()
  }
})

test('required-actions rollback de-registers only an action the deploy registered', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(rollbackContext({ previous: [{ alias: 'CONFIGURE_TOTP', prior: null }] }))

    assert.deepEqual(
      vendorCalls(calls).map((c) => `${c.method} ${adminPath(c)}`),
      ['DELETE /authentication/required-actions/CONFIGURE_TOTP'],
    )
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('required-actions rollback treats an already-de-registered action as success', async () => {
  const { restore } = recordKeycloak([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ previous: [{ alias: 'CONFIGURE_TOTP', prior: null }] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('required-actions rollback reports failure rather than throwing when a restore is rejected', async () => {
  const { restore } = recordKeycloak([TOKEN, kcError(500, 'boom')])
  try {
    const result = await rollback(rollbackContext({ previous: [{ alias: 'CONFIGURE_TOTP', prior: liveAction() }] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback failed/)
  } finally {
    restore()
  }
})

// --- driftDetect --------------------------------------------------------------

test('required-actions driftDetect reports no drift and makes no calls without a credential', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([item('totp', CONFIGURE_TOTP)], { credential: null }))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('required-actions driftDetect reports no drift when the live action matches', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok(liveAction({ defaultAction: true }))])
  try {
    const result = await driftDetect(driftContext([item('totp', CONFIGURE_TOTP)]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must be read-only')
  } finally {
    restore()
  }
})

test('required-actions driftDetect reports an action disabled out of band', async () => {
  const { restore } = recordKeycloak([TOKEN, ok(liveAction({ enabled: false, defaultAction: false }))])
  try {
    const result = await driftDetect(driftContext([item('totp', CONFIGURE_TOTP)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['CONFIGURE_TOTP.enabled', 'CONFIGURE_TOTP.defaultAction'],
    )
  } finally {
    restore()
  }
})

test('required-actions driftDetect only asserts a name difference when one is declared', async () => {
  const { restore } = recordKeycloak([TOKEN, ok(liveAction({ name: 'Renamed', defaultAction: true }))])
  try {
    const result = await driftDetect(driftContext([item('totp', { ...CONFIGURE_TOTP, name: '' })]))

    assert.equal(result.hasDrift, false, 'an undeclared field is not managed, so it cannot drift')
  } finally {
    restore()
  }
})

test('required-actions driftDetect skips an unregistered action rather than asserting false drift', async () => {
  const unregistered = recordKeycloak([TOKEN, notFound()])
  try {
    const result = await driftDetect(driftContext([item('totp', CONFIGURE_TOTP)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    unregistered.restore()
  }

  const unavailable = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await driftDetect(driftContext([item('totp', CONFIGURE_TOTP)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    unavailable.restore()
  }
})

// --- healthCheck / getStatus --------------------------------------------------

describeHealthCheckContract('required-actions', healthCheck)
describeGetStatusContract('required-actions', getStatus, 'keycloak-required-actions')
