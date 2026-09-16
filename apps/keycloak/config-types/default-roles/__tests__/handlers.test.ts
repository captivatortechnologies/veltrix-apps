// =============================================================================
// Keycloak Default Roles — deploy / rollback / healthCheck / driftDetect /
// getStatus driven end to end against the fake Keycloak.
//
// This config type edits the composite children of the realm's `defaultRole`,
// which every NEW user is granted. Adding one entry here grants it to the whole
// realm going forward, so the reconciliation — what is added, what is removed,
// and what is recorded so it can be put back — is what these tests drive.
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
  recordKeycloak,
  rollbackContext,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeKeycloak'
import { describeHealthCheckContract } from '../../../lib/__tests__/healthCheckContract'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

const DESIRED = { realmRoles: ['app-admin'], clientRoles: '{"web-app":["reader"]}' }

const REALM_WITH_DEFAULT_ROLE = ok({ id: 'realm-uuid', realm: 'corp', defaultRole: { id: 'default-role-uuid', name: 'default-roles-corp' } })
const REALM_WITHOUT_DEFAULT_ROLE = ok({ id: 'realm-uuid', realm: 'corp' })

const NO_COMPOSITES = ok([])
const APP_ADMIN_ROLE = ok({ id: 'role-uuid-admin', name: 'app-admin' })
const CLIENT_LOOKUP = ok([{ id: 'uuid-web-app', clientId: 'web-app' }])
const READER_ROLE = ok({ id: 'role-uuid-reader', name: 'reader' })

// --- deploy -------------------------------------------------------------------

test('default-roles deploy refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([item('defaults', DESIRED)], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('default-roles deploy refuses when the canvas declares nothing', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /No default-roles configuration/)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('default-roles deploy stops before writing when the realm has no default composite role', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, REALM_WITHOUT_DEFAULT_ROLE])
  try {
    const result = await deploy(deployContext([item('defaults', DESIRED)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Keycloak 13\+/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('default-roles deploy stops before writing when the realm itself cannot be read', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await deploy(deployContext([item('defaults', DESIRED)]))

    assert.equal(result.success, false)
    assert.equal(writeCalls(calls).length, 0, 'a failed read must not be followed by a blind composite write')
  } finally {
    restore()
  }
})

test('default-roles deploy resolves each declared role and adds the missing composites in one call', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    REALM_WITH_DEFAULT_ROLE,
    NO_COMPOSITES,
    APP_ADMIN_ROLE, // resolve the realm role
    CLIENT_LOOKUP, // resolve the client for the client role
    READER_ROLE, // resolve the client role itself
    noContent(), // add both composites
  ])
  try {
    const result = await deploy(deployContext([item('defaults', DESIRED)]))

    assert.ok(isTokenCall(calls[0]))
    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      [
        'GET ',
        'GET /roles-by-id/default-role-uuid/composites',
        'GET /roles/app-admin',
        'GET /clients?clientId=web-app',
        'GET /clients/uuid-web-app/roles/reader',
        'POST /roles-by-id/default-role-uuid/composites',
      ],
    )
    assert.deepEqual(bodyOf(vendor[5]), [
      { id: 'role-uuid-admin', name: 'app-admin' },
      { id: 'role-uuid-reader', name: 'reader' },
    ])
    assert.equal(result.success, true)
    assert.match(String(result.message), /2 added, 0 removed/)
  } finally {
    restore()
  }
})

test('default-roles deploy removes a composite that is no longer declared', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    REALM_WITH_DEFAULT_ROLE,
    ok([{ id: 'role-uuid-legacy', name: 'legacy-role', clientRole: false, containerId: 'realm-uuid' }]),
    noContent(), // remove
  ])
  try {
    const result = await deploy(deployContext([item('defaults', { realmRoles: [], clientRoles: '{}' })]))

    const removal = writeCalls(calls).find((c) => c.method === 'DELETE')
    assert.ok(removal, 'a role no longer declared must actually be removed from the default set')
    assert.equal(adminPath(removal), '/roles-by-id/default-role-uuid/composites')
    assert.deepEqual(bodyOf(removal), [{ id: 'role-uuid-legacy', name: 'legacy-role' }])
    assert.match(String(result.message), /0 added, 1 removed/)
  } finally {
    restore()
  }
})

test('default-roles deploy resolves a client-role composite back to its human clientId', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    REALM_WITH_DEFAULT_ROLE,
    ok([{ id: 'role-uuid-reader', name: 'reader', clientRole: true, containerId: 'uuid-web-app' }]),
    ok({ id: 'uuid-web-app', clientId: 'web-app' }), // containerId -> clientId
    APP_ADMIN_ROLE,
    noContent(),
  ])
  try {
    const result = await deploy(deployContext([item('defaults', DESIRED)]))

    // "reader" is already there under web-app, so only the realm role is added.
    assert.match(String(result.message), /1 added, 0 removed/)
    const added = writeCalls(calls).find((c) => c.method === 'POST')
    assert.deepEqual(bodyOf(added), [{ id: 'role-uuid-admin', name: 'app-admin' }])
  } finally {
    restore()
  }
})

test('default-roles deploy fails loudly when a declared role does not exist', async () => {
  const missingRealmRole = recordKeycloak([TOKEN, REALM_WITH_DEFAULT_ROLE, NO_COMPOSITES, notFound()])
  try {
    const result = await deploy(deployContext([item('defaults', { realmRoles: ['ghost'], clientRoles: '{}' })]))
    assert.equal(result.success, false)
    assert.match(String(result.message), /realm role "ghost" not found/)
    assert.equal(writeCalls(missingRealmRole.calls).length, 0)
  } finally {
    missingRealmRole.restore()
  }

  const missingClientRole = recordKeycloak([TOKEN, REALM_WITH_DEFAULT_ROLE, NO_COMPOSITES, CLIENT_LOOKUP, notFound()])
  try {
    const result = await deploy(
      deployContext([item('defaults', { realmRoles: [], clientRoles: '{"web-app":["ghost"]}' })]),
    )
    assert.equal(result.success, false)
    assert.match(String(result.message), /client role "ghost" on client "web-app" not found/)
    assert.equal(writeCalls(missingClientRole.calls).length, 0)
  } finally {
    missingClientRole.restore()
  }
})

test('default-roles deploy records the PRIOR composite set for rollback, not the desired one', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    REALM_WITH_DEFAULT_ROLE,
    ok([
      { id: 'role-uuid-legacy', name: 'legacy-role', clientRole: false, containerId: 'realm-uuid' },
      { id: 'role-uuid-old', name: 'old-reader', clientRole: true, containerId: 'uuid-web-app' },
    ]),
    ok({ id: 'uuid-web-app', clientId: 'web-app' }),
    APP_ADMIN_ROLE,
    CLIENT_LOOKUP,
    READER_ROLE,
    noContent(), // add
    noContent(), // remove
  ])
  try {
    const result = await deploy(deployContext([item('defaults', DESIRED)]))

    const data = result.rollbackData as { priorRealmRoles: string[]; priorClientRoles: Record<string, string[]> }
    assert.deepEqual(data.priorRealmRoles, ['legacy-role'])
    assert.deepEqual(data.priorClientRoles, { 'web-app': ['old-reader'] })
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('default-roles deploy reports failure rather than throwing when Keycloak rejects the write', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    REALM_WITH_DEFAULT_ROLE,
    NO_COMPOSITES,
    APP_ADMIN_ROLE,
    CLIENT_LOOKUP,
    READER_ROLE,
    kcError(500, 'boom'),
  ])
  try {
    const result = await deploy(deployContext([item('defaults', DESIRED)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Default-roles deploy failed/)
    assert.match(String(result.message), /500/)
  } finally {
    restore()
  }
})

// --- rollback -----------------------------------------------------------------

test('default-roles rollback refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(
      rollbackContext({ priorRealmRoles: ['legacy-role'], priorClientRoles: {} }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('default-roles rollback reconciles back toward the recorded prior set', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    REALM_WITH_DEFAULT_ROLE,
    ok([{ id: 'role-uuid-admin', name: 'app-admin', clientRole: false, containerId: 'realm-uuid' }]),
    ok({ id: 'role-uuid-legacy', name: 'legacy-role' }), // resolve the prior role again
    noContent(), // add it back
    noContent(), // remove the one the deploy added
  ])
  try {
    const result = await rollback(rollbackContext({ priorRealmRoles: ['legacy-role'], priorClientRoles: {} }))

    const writes = writeCalls(calls)
    assert.deepEqual(bodyOf(writes.find((c) => c.method === 'POST')), [{ id: 'role-uuid-legacy', name: 'legacy-role' }])
    assert.deepEqual(bodyOf(writes.find((c) => c.method === 'DELETE')), [{ id: 'role-uuid-admin', name: 'app-admin' }])
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 added back, 1 removed/)
  } finally {
    restore()
  }
})

test('default-roles rollback with an empty prior set strips every composite the deploy added', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    REALM_WITH_DEFAULT_ROLE,
    ok([{ id: 'role-uuid-admin', name: 'app-admin', clientRole: false, containerId: 'realm-uuid' }]),
    noContent(),
  ])
  try {
    // A genuinely empty prior set is a state to restore to, not a no-op.
    const result = await rollback(rollbackContext({}))

    assert.equal(result.success, true)
    assert.deepEqual(bodyOf(writeCalls(calls).find((c) => c.method === 'DELETE')), [
      { id: 'role-uuid-admin', name: 'app-admin' },
    ])
  } finally {
    restore()
  }
})

test('default-roles rollback stops before writing when the default role cannot be resolved', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, REALM_WITHOUT_DEFAULT_ROLE])
  try {
    const result = await rollback(rollbackContext({ priorRealmRoles: [], priorClientRoles: {} }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Keycloak 13\+/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('default-roles rollback reports failure rather than throwing when a write is rejected', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    REALM_WITH_DEFAULT_ROLE,
    ok([{ id: 'role-uuid-admin', name: 'app-admin', clientRole: false, containerId: 'realm-uuid' }]),
    kcError(500, 'boom'),
  ])
  try {
    const result = await rollback(rollbackContext({ priorRealmRoles: [], priorClientRoles: {} }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback failed/)
  } finally {
    restore()
  }
})

// --- driftDetect --------------------------------------------------------------

test('default-roles driftDetect reports no drift and makes no calls without a credential', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([item('defaults', DESIRED)], { credential: null }))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('default-roles driftDetect reports no drift when the live composites match', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    REALM_WITH_DEFAULT_ROLE,
    ok([
      { id: 'role-uuid-admin', name: 'app-admin', clientRole: false, containerId: 'realm-uuid' },
      { id: 'role-uuid-reader', name: 'reader', clientRole: true, containerId: 'uuid-web-app' },
    ]),
    ok({ id: 'uuid-web-app', clientId: 'web-app' }),
  ])
  try {
    const result = await driftDetect(driftContext([item('defaults', DESIRED)]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must be read-only')
  } finally {
    restore()
  }
})

test('default-roles driftDetect reports a role granted to every new user out of band', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    REALM_WITH_DEFAULT_ROLE,
    ok([
      { id: 'role-uuid-admin', name: 'app-admin', clientRole: false, containerId: 'realm-uuid' },
      { id: 'role-uuid-super', name: 'realm-admin', clientRole: false, containerId: 'realm-uuid' },
      { id: 'role-uuid-reader', name: 'reader', clientRole: true, containerId: 'uuid-web-app' },
    ]),
    ok({ id: 'uuid-web-app', clientId: 'web-app' }),
  ])
  try {
    const result = await driftDetect(driftContext([item('defaults', DESIRED)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['realmRoles'],
    )
    assert.deepEqual(result.diffs[0].actual, ['app-admin', 'realm-admin'])
  } finally {
    restore()
  }
})

test('default-roles driftDetect reports a changed client-role grant', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    REALM_WITH_DEFAULT_ROLE,
    ok([
      { id: 'role-uuid-admin', name: 'app-admin', clientRole: false, containerId: 'realm-uuid' },
      { id: 'role-uuid-writer', name: 'writer', clientRole: true, containerId: 'uuid-web-app' },
    ]),
    ok({ id: 'uuid-web-app', clientId: 'web-app' }),
  ])
  try {
    const result = await driftDetect(driftContext([item('defaults', DESIRED)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['clientRoles'],
    )
    assert.deepEqual(result.diffs[0].actual, { 'web-app': ['writer'] })
  } finally {
    restore()
  }
})

test('default-roles driftDetect asserts nothing when the default role cannot be resolved', async () => {
  const noDefaultRole = recordKeycloak([TOKEN, REALM_WITHOUT_DEFAULT_ROLE])
  try {
    const result = await driftDetect(driftContext([item('defaults', DESIRED)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    noDefaultRole.restore()
  }

  const unreadable = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await driftDetect(driftContext([item('defaults', DESIRED)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    unreadable.restore()
  }
})

// --- healthCheck / getStatus --------------------------------------------------

describeHealthCheckContract('default-roles', healthCheck)
describeGetStatusContract('default-roles', getStatus, 'keycloak-default-roles')
