// =============================================================================
// Keycloak Client Roles — deploy / rollback / healthCheck / driftDetect /
// getStatus driven end to end against the fake Keycloak.
//
// A client role lives under a client's INTERNAL UUID, which has to be resolved
// from the human clientId first. The two things that matter: a clientId that
// does not resolve must fail loudly rather than write somewhere else, and
// rollback must target the UUID captured at deploy time so a client rename
// between deploy and rollback cannot misdirect it.
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

const READER = { clientId: 'web-app', name: 'reader', description: 'Read-only access', composite: false }

const CLIENT_LOOKUP = ok([{ id: 'uuid-web-app', clientId: 'web-app' }])

function liveRole(over: Record<string, unknown> = {}) {
  return {
    id: 'role-uuid',
    name: 'reader',
    description: 'Read-only access',
    composite: false,
    clientRole: true,
    containerId: 'uuid-web-app',
    ...over,
  }
}

// --- deploy -------------------------------------------------------------------

test('client-roles deploy refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([item('reader', READER)], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('client-roles deploy resolves the client UUID before touching any role', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, notFound(), created()])
  try {
    await deploy(deployContext([item('reader', READER)]))

    assert.ok(isTokenCall(calls[0]))
    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      [
        'GET /clients?clientId=web-app',
        'GET /clients/uuid-web-app/roles/reader',
        'POST /clients/uuid-web-app/roles',
      ],
    )
  } finally {
    restore()
  }
})

test('client-roles deploy fails loudly when the declared client does not exist', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok([])])
  try {
    const result = await deploy(deployContext([item('reader', READER)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /client "web-app" not found/)
    // Nothing is written anywhere when the target cannot be identified.
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('client-roles deploy creates a role that does not exist on the client', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, notFound(), created()])
  try {
    const result = await deploy(deployContext([item('reader', READER)]))

    const body = bodyOf(vendorCalls(calls)[2]) as Record<string, unknown>
    assert.deepEqual(body, { name: 'reader', composite: false, description: 'Read-only access' })
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { previous: unknown[] }).previous, [
      { clientId: 'web-app', clientUuid: 'uuid-web-app', name: 'reader', role: null },
    ])
  } finally {
    restore()
  }
})

test('client-roles deploy updates an existing role and records the LIVE prior state', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    CLIENT_LOOKUP,
    ok(liveRole({ composite: false, description: 'Old text' })),
    noContent(),
  ])
  try {
    const result = await deploy(
      deployContext([item('reader', { ...READER, composite: true, description: 'New text' })]),
    )

    const vendor = vendorCalls(calls)
    assert.equal(`${vendor[2].method} ${adminPath(vendor[2])}`, 'PUT /clients/uuid-web-app/roles/reader')
    const body = bodyOf(vendor[2]) as Record<string, unknown>
    assert.equal(body.composite, true)
    assert.equal(body.containerId, 'uuid-web-app', 'Keycloak-managed fields must survive an update')

    const previous = (result.rollbackData as { previous: Array<{ role: Record<string, unknown> }> }).previous
    assert.equal(previous[0].role.composite, false, 'rollback restores the prior LIVE state')
    assert.equal(previous[0].role.description, 'Old text')
  } finally {
    restore()
  }
})

test('client-roles deploy records the resolved UUID, not the clientId, for rollback', async () => {
  const { restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, notFound(), created()])
  try {
    const result = await deploy(deployContext([item('reader', READER)]))

    const previous = (result.rollbackData as { previous: Array<{ clientUuid: string }> }).previous
    // Re-resolving clientId at rollback time would follow a rename to the wrong
    // client; the UUID captured here cannot.
    assert.equal(previous[0].clientUuid, 'uuid-web-app')
  } finally {
    restore()
  }
})

test('client-roles deploy skips an item missing either half of its composite identity', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await deploy(
      deployContext([item('a', { ...READER, clientId: '' }), item('b', { ...READER, name: '' })]),
    )

    assert.equal(result.success, true)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('client-roles deploy reports failure rather than throwing when Keycloak rejects the write', async () => {
  const { restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, notFound(), kcError(409, 'Role already exists')])
  try {
    const result = await deploy(deployContext([item('reader', READER)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /409/)
  } finally {
    restore()
  }
})

test('client-roles deploy never puts the admin token in its result', async () => {
  const { restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, ok(liveRole()), noContent()])
  try {
    const result = await deploy(deployContext([item('reader', READER)]))
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

// --- rollback -----------------------------------------------------------------

test('client-roles rollback does nothing, successfully, when there is no prior state', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(rollbackContext({ previous: [] }))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('client-roles rollback refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(
      rollbackContext(
        { previous: [{ clientId: 'web-app', clientUuid: 'uuid-web-app', name: 'reader', role: liveRole() }] },
        { credential: null },
      ),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('client-roles rollback targets the stored UUID without re-resolving the clientId', async () => {
  const prior = liveRole({ description: 'Old text' })
  const { calls, restore } = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ clientId: 'renamed-since', clientUuid: 'uuid-web-app', name: 'reader', role: prior }] }),
    )

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['PUT /clients/uuid-web-app/roles/reader'],
    )
    assert.equal(
      vendor.filter((c) => c.path.includes('clientId=')).length,
      0,
      'a rename between deploy and rollback must not redirect the restore',
    )
    assert.deepEqual(bodyOf(vendor[0]), prior)
    assert.match(String(result.message), /1 restored/)
  } finally {
    restore()
  }
})

test('client-roles rollback skips, rather than fails, when the role or its client is already gone', async () => {
  const { restore } = recordKeycloak([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ clientId: 'web-app', clientUuid: 'uuid-web-app', name: 'reader', role: liveRole() }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /0 restored, 0 deleted, 1 skipped/)
  } finally {
    restore()
  }
})

test('client-roles rollback deletes a role the deploy created, tolerating an already-gone 404', async () => {
  const deleted = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ clientId: 'web-app', clientUuid: 'uuid-web-app', name: 'reader', role: null }] }),
    )
    assert.deepEqual(
      vendorCalls(deleted.calls).map((c) => `${c.method} ${adminPath(c)}`),
      ['DELETE /clients/uuid-web-app/roles/reader'],
    )
    assert.match(String(result.message), /1 deleted/)
  } finally {
    deleted.restore()
  }

  const gone = recordKeycloak([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ clientId: 'web-app', clientUuid: 'uuid-web-app', name: 'reader', role: null }] }),
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    gone.restore()
  }
})

test('client-roles rollback reports failure rather than throwing when a restore is rejected', async () => {
  const { restore } = recordKeycloak([TOKEN, kcError(500, 'boom')])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ clientId: 'web-app', clientUuid: 'uuid-web-app', name: 'reader', role: liveRole() }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback failed/)
  } finally {
    restore()
  }
})

// --- driftDetect --------------------------------------------------------------

test('client-roles driftDetect reports no drift and makes no calls without a credential', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([item('reader', READER)], { credential: null }))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('client-roles driftDetect reports no drift when the live role matches', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, ok(liveRole())])
  try {
    const result = await driftDetect(driftContext([item('reader', READER)]))

    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0, 'drift detection must be read-only')
  } finally {
    restore()
  }
})

test('client-roles driftDetect labels a diff with both halves of the composite identity', async () => {
  const { restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, ok(liveRole({ composite: true }))])
  try {
    const result = await driftDetect(driftContext([item('reader', READER)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['web-app/reader.composite'],
    )
  } finally {
    restore()
  }
})

test('client-roles driftDetect skips an unresolvable client rather than asserting false drift', async () => {
  const noClient = recordKeycloak([TOKEN, ok([])])
  try {
    const result = await driftDetect(driftContext([item('reader', READER)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    noClient.restore()
  }

  const noRole = recordKeycloak([TOKEN, CLIENT_LOOKUP, notFound()])
  try {
    const result = await driftDetect(driftContext([item('reader', READER)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    noRole.restore()
  }
})

// --- healthCheck / getStatus --------------------------------------------------

describeHealthCheckContract('client-roles', healthCheck)
describeGetStatusContract('client-roles', getStatus, 'keycloak-client-roles')
