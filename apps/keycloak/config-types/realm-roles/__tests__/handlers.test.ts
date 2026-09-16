// =============================================================================
// Keycloak Realm Roles — deploy / rollback / healthCheck / driftDetect /
// getStatus driven end to end against the fake Keycloak.
//
// Realm roles are addressed by NAME, which is both the identity and the path
// segment — so the encoding of that segment is load-bearing, not cosmetic.
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
  deployContext,
  driftContext,
  isTokenCall,
  item,
  kcError,
  leaksToken,
  noContent,
  notFound,
  ok,
  created,
  recordKeycloak,
  rollbackContext,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeKeycloak'
import { describeHealthCheckContract } from '../../../lib/__tests__/healthCheckContract'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

const APP_ADMIN = { name: 'app-admin', description: 'Application administrator', composite: false }

function liveRole(over: Record<string, unknown> = {}) {
  return {
    id: 'role-uuid',
    name: 'app-admin',
    description: 'Application administrator',
    composite: false,
    containerId: 'realm-uuid',
    ...over,
  }
}

// --- deploy -------------------------------------------------------------------

test('realm-roles deploy refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([item('admin', APP_ADMIN)], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('realm-roles deploy obtains the admin token before the first realm call', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, notFound(), created()])
  try {
    await deploy(deployContext([item('admin', APP_ADMIN)]))

    assert.ok(isTokenCall(calls[0]))
    assert.equal(calls.filter(isTokenCall).length, 1)
    assert.ok(vendorCalls(calls).every((c) => c.authorization?.startsWith('Bearer ')))
  } finally {
    restore()
  }
})

test('realm-roles deploy creates a role Keycloak reports as absent', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, notFound(), created()])
  try {
    const result = await deploy(deployContext([item('admin', APP_ADMIN)]))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['GET /roles/app-admin', 'POST /roles'],
    )
    assert.deepEqual(bodyOf(vendor[1]), {
      name: 'app-admin',
      composite: false,
      description: 'Application administrator',
    })
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { previous: unknown[] }).previous, [{ name: 'app-admin', role: null }])
  } finally {
    restore()
  }
})

test('realm-roles deploy updates an existing role instead of creating a duplicate', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok(liveRole()), noContent()])
  try {
    await deploy(deployContext([item('admin', { ...APP_ADMIN, composite: true })]))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['GET /roles/app-admin', 'PUT /roles/app-admin'],
    )
    const body = bodyOf(vendor[1]) as Record<string, unknown>
    assert.equal(body.composite, true, 'the declared value must win on update')
    assert.equal(body.containerId, 'realm-uuid', 'Keycloak-managed fields must survive an update')
  } finally {
    restore()
  }
})

test('realm-roles deploy URL-encodes a role name with a space into the path segment', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok(liveRole({ name: 'app admin' })), noContent()])
  try {
    await deploy(deployContext([item('admin', { ...APP_ADMIN, name: 'app admin' })]))

    const vendor = vendorCalls(calls)
    assert.equal(adminPath(vendor[0]), '/roles/app%20admin')
    assert.equal(adminPath(vendor[1]), '/roles/app%20admin')
  } finally {
    restore()
  }
})

test('realm-roles deploy records the LIVE prior role for rollback, not the desired values', async () => {
  const { restore } = recordKeycloak([TOKEN, ok(liveRole({ composite: false, description: 'Old text' })), noContent()])
  try {
    const result = await deploy(
      deployContext([item('admin', { ...APP_ADMIN, composite: true, description: 'New text' })]),
    )

    const previous = (result.rollbackData as { previous: Array<{ role: Record<string, unknown> }> }).previous
    assert.equal(previous[0].role.composite, false)
    assert.equal(previous[0].role.description, 'Old text')
  } finally {
    restore()
  }
})

test('realm-roles deploy reports failure rather than throwing when Keycloak rejects the write', async () => {
  const { restore } = recordKeycloak([TOKEN, notFound(), kcError(409, 'Role with name app-admin already exists')])
  try {
    const result = await deploy(deployContext([item('admin', APP_ADMIN)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /409/)
  } finally {
    restore()
  }
})

test('realm-roles deploy skips an item with a blank name without calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await deploy(deployContext([item('blank', { ...APP_ADMIN, name: '  ' })]))

    assert.equal(result.success, true)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('realm-roles deploy never puts the admin token in its result', async () => {
  const { restore } = recordKeycloak([TOKEN, ok(liveRole()), noContent()])
  try {
    const result = await deploy(deployContext([item('admin', APP_ADMIN)]))
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

// --- rollback -----------------------------------------------------------------

test('realm-roles rollback does nothing, successfully, when there is no prior state', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(rollbackContext({ previous: [] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Nothing to roll back/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('realm-roles rollback refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ name: 'app-admin', role: liveRole() }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('realm-roles rollback restores the captured prior role verbatim', async () => {
  const prior = liveRole({ composite: false, description: 'Old text' })
  const { calls, restore } = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(rollbackContext({ previous: [{ name: 'app-admin', role: prior }] }))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['PUT /roles/app-admin'],
    )
    assert.deepEqual(bodyOf(vendor[0]), prior)
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 restored, 0 deleted/)
  } finally {
    restore()
  }
})

test('realm-roles rollback deletes a role the deploy created, tolerating an already-gone 404', async () => {
  const deleted = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(rollbackContext({ previous: [{ name: 'app-admin', role: null }] }))
    assert.deepEqual(
      vendorCalls(deleted.calls).map((c) => `${c.method} ${adminPath(c)}`),
      ['DELETE /roles/app-admin'],
    )
    assert.match(String(result.message), /0 restored, 1 deleted/)
  } finally {
    deleted.restore()
  }

  const gone = recordKeycloak([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ previous: [{ name: 'app-admin', role: null }] }))
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    gone.restore()
  }
})

test('realm-roles rollback reports failure rather than throwing when a delete is rejected', async () => {
  const { restore } = recordKeycloak([TOKEN, kcError(500, 'boom')])
  try {
    const result = await rollback(rollbackContext({ previous: [{ name: 'app-admin', role: null }] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback failed/)
  } finally {
    restore()
  }
})

// --- driftDetect --------------------------------------------------------------

test('realm-roles driftDetect reports no drift and makes no calls without a credential', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([item('admin', APP_ADMIN)], { credential: null }))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('realm-roles driftDetect reports no drift when the live role matches', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok(liveRole())])
  try {
    const result = await driftDetect(driftContext([item('admin', APP_ADMIN)]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must be read-only')
  } finally {
    restore()
  }
})

test('realm-roles driftDetect reports a flipped composite flag and a changed description', async () => {
  const { restore } = recordKeycloak([TOKEN, ok(liveRole({ composite: true, description: 'Edited in console' }))])
  try {
    const result = await driftDetect(driftContext([item('admin', APP_ADMIN)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['app-admin.description', 'app-admin.composite'],
    )
  } finally {
    restore()
  }
})

test('realm-roles driftDetect only asserts a description difference when one is declared', async () => {
  const { restore } = recordKeycloak([TOKEN, ok(liveRole({ description: 'Set in console' }))])
  try {
    const result = await driftDetect(driftContext([item('admin', { ...APP_ADMIN, description: '' })]))

    assert.equal(result.hasDrift, false, 'an undeclared field is not managed, so it cannot drift')
  } finally {
    restore()
  }
})

test('realm-roles driftDetect skips a role it cannot read rather than asserting false drift', async () => {
  const missing = recordKeycloak([TOKEN, notFound()])
  try {
    const result = await driftDetect(driftContext([item('admin', APP_ADMIN)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    missing.restore()
  }

  const unavailable = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await driftDetect(driftContext([item('admin', APP_ADMIN)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    unavailable.restore()
  }
})

// --- healthCheck / getStatus --------------------------------------------------

describeHealthCheckContract('realm-roles', healthCheck)
describeGetStatusContract('realm-roles', getStatus, 'keycloak-realm-roles')
