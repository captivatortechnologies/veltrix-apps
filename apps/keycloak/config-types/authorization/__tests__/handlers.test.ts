// =============================================================================
// Keycloak Authorization (resource server) — deploy / rollback / healthCheck /
// driftDetect / getStatus driven end to end against the fake Keycloak.
//
// One canvas item is one of four different Admin REST sub-resources, chosen by
// `kind`, under one client's authz resource server. Two preconditions gate
// every write: the client must resolve, and it must already have authorization
// services enabled. Getting either wrong writes fine-grained permissions to
// the wrong place, so both are driven here alongside each kind's own flow.
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

const BASE = '/clients/uuid-api/authz/resource-server'

const CLIENT_LOOKUP = ok([{ id: 'uuid-api', clientId: 'api' }])
const AUTHZ_ENABLED = ok({ id: 'rs-uuid', clientId: 'api', allowRemoteResourceManagement: false })

const SCOPE_ITEM = {
  clientId: 'api',
  kind: 'scope',
  name: 'reports:read',
  displayName: 'Read reports',
  iconUri: 'https://cdn.example.com/read.svg',
}

const RESOURCE_ITEM = {
  clientId: 'api',
  kind: 'resource',
  name: 'reports',
  uris: ['/reports', '/reports/*'],
  scopes: ['reports:read'],
  ownerManagedAccess: false,
}

const PERMISSION_ITEM = {
  clientId: 'api',
  kind: 'permission',
  name: 'reports-read-permission',
  permissionType: 'resource',
  policies: ['analysts-policy'],
  resources: ['reports'],
  scopes: [],
  decisionStrategy: 'UNANIMOUS',
}

const ROLE_POLICY_ITEM = {
  clientId: 'api',
  kind: 'role-policy',
  name: 'analysts-policy',
  roles: JSON.stringify([{ name: 'analyst', required: true }]),
  decisionStrategy: 'UNANIMOUS',
  logic: 'POSITIVE',
}

const LIVE_SCOPE = { id: 'scope-uuid', name: 'reports:read', displayName: 'Read reports', iconUri: 'https://cdn.example.com/read.svg' }
const LIVE_RESOURCE = { id: 'resource-uuid', name: 'reports', uris: ['/reports', '/reports/*'], scopes: [{ id: 'scope-uuid', name: 'reports:read' }] }
const LIVE_POLICY = { id: 'policy-uuid', name: 'analysts-policy', type: 'role', decisionStrategy: 'UNANIMOUS', logic: 'POSITIVE', roles: [{ id: 'role-uuid-analyst', required: true }] }
const LIVE_PERMISSION = { id: 'permission-uuid', name: 'reports-read-permission', type: 'resource', decisionStrategy: 'UNANIMOUS', policies: ['policy-uuid'], resources: ['resource-uuid'], scopes: [] }

// --- deploy: preconditions ----------------------------------------------------

test('authorization deploy refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([item('scope', SCOPE_ITEM)], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('authorization deploy fails loudly when the declared client does not exist', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok([])])
  try {
    const result = await deploy(deployContext([item('scope', SCOPE_ITEM)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /client "api" not found/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('authorization deploy stops before writing when the client has no authorization services', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, kcError(404, 'Not a resource server')])
  try {
    const result = await deploy(deployContext([item('scope', SCOPE_ITEM)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /does not have authorization services enabled/)
    assert.equal(writeCalls(calls).length, 0, 'this app does not flip that switch for the operator')
  } finally {
    restore()
  }
})

test('authorization deploy resolves the client and its authz state once for many items', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    CLIENT_LOOKUP,
    AUTHZ_ENABLED,
    ok([LIVE_SCOPE]),
    noContent(), // first scope updated
    ok([{ ...LIVE_SCOPE, id: 'scope-uuid-2', name: 'reports:write' }]),
    noContent(), // second scope updated
  ])
  try {
    await deploy(
      deployContext([item('a', SCOPE_ITEM), item('b', { ...SCOPE_ITEM, name: 'reports:write' })]),
    )

    const vendor = vendorCalls(calls)
    assert.equal(vendor.filter((c) => c.path.includes('clientId=api')).length, 1, 'the client lookup is cached')
    assert.equal(vendor.filter((c) => adminPath(c) === BASE).length, 1, 'the authz check is cached')
  } finally {
    restore()
  }
})

test('authorization deploy skips an item missing any part of its composite identity', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await deploy(
      deployContext([
        item('a', { ...SCOPE_ITEM, clientId: '' }),
        item('b', { ...SCOPE_ITEM, kind: '' }),
        item('c', { ...SCOPE_ITEM, name: '' }),
      ]),
    )

    assert.equal(result.success, true)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('authorization deploy rejects an unknown kind rather than guessing an endpoint', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, AUTHZ_ENABLED])
  try {
    const result = await deploy(deployContext([item('x', { ...SCOPE_ITEM, kind: 'group-policy' })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown kind "group-policy"/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

// --- deploy: per-kind flows ---------------------------------------------------

test('authorization deploy creates a scope and re-reads it to capture the id', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, AUTHZ_ENABLED, ok([]), created(), ok([LIVE_SCOPE])])
  try {
    const result = await deploy(deployContext([item('scope', SCOPE_ITEM)]))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      [
        'GET /clients?clientId=api',
        `GET ${BASE}`,
        `GET ${BASE}/scope?name=reports%3Aread`,
        `POST ${BASE}/scope`,
        `GET ${BASE}/scope?name=reports%3Aread`,
      ],
    )
    assert.deepEqual(bodyOf(vendor[3]), {
      name: 'reports:read',
      displayName: 'Read reports',
      iconUri: 'https://cdn.example.com/read.svg',
    })
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { previous: unknown[] }).previous, [
      { clientId: 'api', resolvedClientUuid: 'uuid-api', kind: 'scope', name: 'reports:read', id: 'scope-uuid', rep: null },
    ])
  } finally {
    restore()
  }
})

test('authorization deploy resolves a resource’s declared scopes to ids before writing it', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    CLIENT_LOOKUP,
    AUTHZ_ENABLED,
    ok([LIVE_SCOPE]), // resolve the declared scope name
    ok([]), // the resource itself is absent
    created(),
    ok([LIVE_RESOURCE]),
  ])
  try {
    const result = await deploy(deployContext([item('resource', RESOURCE_ITEM)]))

    const vendor = vendorCalls(calls)
    assert.equal(`${vendor[3].method} ${adminPath(vendor[3])}`, `GET ${BASE}/resource?name=reports&exactName=true`)
    const body = bodyOf(vendor[4]) as Record<string, unknown>
    assert.deepEqual(body.uris, ['/reports', '/reports/*'])
    assert.deepEqual(body.scopes, [{ id: 'scope-uuid', name: 'reports:read' }])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('authorization deploy fails loudly when a referenced scope cannot be resolved', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, AUTHZ_ENABLED, ok([])])
  try {
    const result = await deploy(deployContext([item('resource', RESOURCE_ITEM)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /resource "reports" on client "api": scope "reports:read" not found/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('authorization deploy resolves a role-policy’s roles and posts to the role policy endpoint', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    CLIENT_LOOKUP,
    AUTHZ_ENABLED,
    ok({ id: 'role-uuid-analyst', name: 'analyst' }), // a bare name resolves as a REALM role
    ok([]), // the policy itself is absent
    created(),
    ok([LIVE_POLICY]),
  ])
  try {
    const result = await deploy(deployContext([item('policy', ROLE_POLICY_ITEM)]))

    const vendor = vendorCalls(calls)
    assert.equal(`${vendor[2].method} ${adminPath(vendor[2])}`, 'GET /roles/analyst')
    assert.equal(`${vendor[3].method} ${adminPath(vendor[3])}`, `GET ${BASE}/policy?name=analysts-policy&type=role`)
    assert.equal(`${vendor[4].method} ${adminPath(vendor[4])}`, `POST ${BASE}/policy/role`)
    const body = bodyOf(vendor[4]) as Record<string, unknown>
    assert.deepEqual(body.roles, [{ id: 'role-uuid-analyst', required: true }])
    assert.equal(body.decisionStrategy, 'UNANIMOUS')
    assert.equal(body.logic, 'POSITIVE')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('authorization deploy resolves a "clientId/roleName" role entry as a CLIENT role', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    CLIENT_LOOKUP,
    AUTHZ_ENABLED,
    ok([{ id: 'uuid-web-app', clientId: 'web-app' }]), // resolve the other client
    ok({ id: 'role-uuid-reader', name: 'reader' }),
    ok([]),
    created(),
    ok([LIVE_POLICY]),
  ])
  try {
    await deploy(
      deployContext([
        item('policy', { ...ROLE_POLICY_ITEM, roles: JSON.stringify([{ name: 'web-app/reader', required: false }]) }),
      ]),
    )

    const vendor = vendorCalls(calls)
    assert.equal(`${vendor[2].method} ${adminPath(vendor[2])}`, 'GET /clients?clientId=web-app')
    assert.equal(`${vendor[3].method} ${adminPath(vendor[3])}`, 'GET /clients/uuid-web-app/roles/reader')
    const body = bodyOf(vendor[5]) as Record<string, unknown>
    assert.deepEqual(body.roles, [{ id: 'role-uuid-reader', required: false }])
  } finally {
    restore()
  }
})

test('authorization deploy fails loudly when a role-policy declares a role that does not exist', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, AUTHZ_ENABLED, notFound()])
  try {
    const result = await deploy(deployContext([item('policy', ROLE_POLICY_ITEM)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /role "analyst" not found/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('authorization deploy creates a resource permission on the resource sub-path', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    CLIENT_LOOKUP,
    AUTHZ_ENABLED,
    ok([LIVE_POLICY]), // resolve the referenced policy
    ok([LIVE_RESOURCE]), // resolve the referenced resource
    ok([]), // the permission itself is absent
    created(),
    ok([LIVE_PERMISSION]),
  ])
  try {
    const result = await deploy(deployContext([item('perm', PERMISSION_ITEM)]))

    const vendor = vendorCalls(calls)
    assert.equal(`${vendor[5].method} ${adminPath(vendor[5])}`, `POST ${BASE}/permission/resource`)
    const body = bodyOf(vendor[5]) as Record<string, unknown>
    assert.deepEqual(body.policies, ['policy-uuid'])
    assert.deepEqual(body.resources, ['resource-uuid'])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('authorization deploy creates a scope permission on the scope sub-path, without resources', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    CLIENT_LOOKUP,
    AUTHZ_ENABLED,
    ok([LIVE_POLICY]),
    ok([LIVE_SCOPE]),
    ok([]),
    created(),
    ok([LIVE_PERMISSION]),
  ])
  try {
    await deploy(
      deployContext([
        item('perm', { ...PERMISSION_ITEM, permissionType: 'scope', scopes: ['reports:read'], resources: ['reports'] }),
      ]),
    )

    const vendor = vendorCalls(calls)
    assert.equal(`${vendor[5].method} ${adminPath(vendor[5])}`, `POST ${BASE}/permission/scope`)
    const body = bodyOf(vendor[5]) as Record<string, unknown>
    assert.deepEqual(body.scopes, ['scope-uuid'])
    assert.equal(body.resources, undefined, 'a scope permission must not carry resource ids')
    // The declared `resources` is never even resolved for a scope permission.
    assert.equal(vendor.filter((c) => c.path.includes('/resource?name=')).length, 0)
  } finally {
    restore()
  }
})

test('authorization deploy updates an existing object and records the LIVE prior representation', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, AUTHZ_ENABLED, ok([LIVE_SCOPE]), noContent()])
  try {
    const result = await deploy(deployContext([item('scope', { ...SCOPE_ITEM, displayName: 'Renamed' })]))

    const vendor = vendorCalls(calls)
    assert.equal(`${vendor[3].method} ${adminPath(vendor[3])}`, `PUT ${BASE}/scope/scope-uuid`)
    assert.equal((bodyOf(vendor[3]) as Record<string, unknown>).displayName, 'Renamed')

    const previous = (result.rollbackData as { previous: Array<{ rep: { displayName: string }; resolvedClientUuid: string }> })
      .previous
    assert.equal(previous[0].rep.displayName, 'Read reports', 'the prior LIVE state, not the canvas value')
    assert.equal(previous[0].resolvedClientUuid, 'uuid-api')
  } finally {
    restore()
  }
})

test('authorization deploy reports failure rather than throwing when Keycloak rejects the write', async () => {
  const { restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, AUTHZ_ENABLED, ok([]), kcError(409, 'Conflict')])
  try {
    const result = await deploy(deployContext([item('scope', SCOPE_ITEM)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /409/)
  } finally {
    restore()
  }
})

test('authorization deploy never puts the admin token in its result', async () => {
  const { restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, AUTHZ_ENABLED, ok([LIVE_SCOPE]), noContent()])
  try {
    const result = await deploy(deployContext([item('scope', SCOPE_ITEM)]))
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

// --- rollback -----------------------------------------------------------------

test('authorization rollback does nothing, successfully, when there is no prior state', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(rollbackContext({ previous: [] }))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('authorization rollback refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(
      rollbackContext(
        {
          previous: [
            { clientId: 'api', resolvedClientUuid: 'uuid-api', kind: 'scope', name: 'reports:read', id: 'scope-uuid', rep: LIVE_SCOPE },
          ],
        },
        { credential: null },
      ),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('authorization rollback restores each kind on its own path, using the stored client uuid', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, noContent(), noContent(), noContent(), noContent()])
  try {
    const result = await rollback(
      rollbackContext({
        previous: [
          { clientId: 'renamed', resolvedClientUuid: 'uuid-api', kind: 'scope', name: 'reports:read', id: 'scope-uuid', rep: LIVE_SCOPE },
          { clientId: 'renamed', resolvedClientUuid: 'uuid-api', kind: 'resource', name: 'reports', id: 'resource-uuid', rep: LIVE_RESOURCE },
          { clientId: 'renamed', resolvedClientUuid: 'uuid-api', kind: 'permission', name: 'p', id: 'permission-uuid', rep: LIVE_PERMISSION },
          { clientId: 'renamed', resolvedClientUuid: 'uuid-api', kind: 'role-policy', name: 'analysts-policy', id: 'policy-uuid', rep: LIVE_POLICY },
        ],
      }),
    )

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      [
        `PUT ${BASE}/scope/scope-uuid`,
        `PUT ${BASE}/resource/resource-uuid`,
        `PUT ${BASE}/permission/permission-uuid`,
        // role-policy restores on the generic policy path, not /policy/role.
        `PUT ${BASE}/policy/policy-uuid`,
      ],
    )
    assert.deepEqual(bodyOf(vendor[0]), LIVE_SCOPE)
    assert.equal(vendor.filter((c) => c.path.includes('clientId=')).length, 0, 'a client rename must not redirect it')
    assert.match(String(result.message), /4 restored/)
  } finally {
    restore()
  }
})

test('authorization rollback deletes an object the deploy created, tolerating a 404', async () => {
  const deleted = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(
      rollbackContext({
        previous: [
          { clientId: 'api', resolvedClientUuid: 'uuid-api', kind: 'permission', name: 'p', id: 'permission-uuid', rep: null },
        ],
      }),
    )
    assert.deepEqual(
      vendorCalls(deleted.calls).map((c) => `${c.method} ${adminPath(c)}`),
      [`DELETE ${BASE}/permission/permission-uuid`],
    )
    assert.match(String(result.message), /1 deleted/)
  } finally {
    deleted.restore()
  }

  const gone = recordKeycloak([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({
        previous: [
          { clientId: 'api', resolvedClientUuid: 'uuid-api', kind: 'permission', name: 'p', id: 'permission-uuid', rep: null },
        ],
      }),
    )
    assert.equal(result.success, true)
  } finally {
    gone.restore()
  }
})

test('authorization rollback skips an entry whose id was never learned', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await rollback(
      rollbackContext({
        previous: [
          { clientId: 'api', resolvedClientUuid: 'uuid-api', kind: 'scope', name: 'reports:read', id: null, rep: null },
        ],
      }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 skipped/)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('authorization rollback reports failure rather than throwing when a restore is rejected', async () => {
  const { restore } = recordKeycloak([TOKEN, kcError(500, 'boom')])
  try {
    const result = await rollback(
      rollbackContext({
        previous: [
          { clientId: 'api', resolvedClientUuid: 'uuid-api', kind: 'scope', name: 'reports:read', id: 'scope-uuid', rep: LIVE_SCOPE },
        ],
      }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback failed/)
    assert.match(String(result.message), /reports:read/)
  } finally {
    restore()
  }
})

// --- driftDetect --------------------------------------------------------------

test('authorization driftDetect reports no drift and makes no calls without a credential', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([item('scope', SCOPE_ITEM)], { credential: null }))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('authorization driftDetect reports no drift when the live scope matches', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, CLIENT_LOOKUP, AUTHZ_ENABLED, ok([LIVE_SCOPE])])
  try {
    const result = await driftDetect(driftContext([item('scope', SCOPE_ITEM)]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must be read-only')
  } finally {
    restore()
  }
})

test('authorization driftDetect reports a scope renamed in the console', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    CLIENT_LOOKUP,
    AUTHZ_ENABLED,
    ok([{ ...LIVE_SCOPE, displayName: 'Edited in console' }]),
  ])
  try {
    const result = await driftDetect(driftContext([item('scope', SCOPE_ITEM)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['api/scope/reports:read.displayName'],
    )
  } finally {
    restore()
  }
})

test('authorization driftDetect reports a resource whose URIs were widened', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    CLIENT_LOOKUP,
    AUTHZ_ENABLED,
    ok([{ ...LIVE_RESOURCE, uris: ['/*'] }]), // the resource itself
    ok([LIVE_SCOPE]), // resolve the declared scope
  ])
  try {
    const result = await driftDetect(driftContext([item('resource', RESOURCE_ITEM)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['api/resource/reports.uris'],
    )
    assert.deepEqual(result.diffs[0].actual, ['/*'])
  } finally {
    restore()
  }
})

test('authorization driftDetect reports a permission rewired to a different policy', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    CLIENT_LOOKUP,
    AUTHZ_ENABLED,
    ok([{ ...LIVE_PERMISSION, policies: ['some-other-policy-uuid'], decisionStrategy: 'AFFIRMATIVE' }]),
    ok([LIVE_POLICY]), // resolve the declared policy name
    ok([LIVE_RESOURCE]), // resolve the declared resource name
  ])
  try {
    const result = await driftDetect(driftContext([item('perm', PERMISSION_ITEM)]))

    assert.equal(result.hasDrift, true)
    const fields = result.diffs.map((d) => d.field)
    assert.ok(fields.includes('api/permission/reports-read-permission.policies'))
    assert.ok(fields.includes('api/permission/reports-read-permission.decisionStrategy'))
  } finally {
    restore()
  }
})

test('authorization driftDetect reports a role-policy whose role set changed', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    CLIENT_LOOKUP,
    AUTHZ_ENABLED,
    ok([{ ...LIVE_POLICY, roles: [{ id: 'role-uuid-analyst', required: false }] }]),
    ok({ id: 'role-uuid-analyst', name: 'analyst' }),
  ])
  try {
    const result = await driftDetect(driftContext([item('policy', ROLE_POLICY_ITEM)]))

    // The same role with `required` flipped is a different authorization rule.
    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['api/role-policy/analysts-policy.roles'],
    )
  } finally {
    restore()
  }
})

test('authorization driftDetect skips an unresolvable client or a disabled resource server', async () => {
  const noClient = recordKeycloak([TOKEN, ok([])])
  try {
    const result = await driftDetect(driftContext([item('scope', SCOPE_ITEM)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    noClient.restore()
  }

  const noAuthz = recordKeycloak([TOKEN, CLIENT_LOOKUP, kcError(404, 'Not a resource server')])
  try {
    const result = await driftDetect(driftContext([item('scope', SCOPE_ITEM)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    noAuthz.restore()
  }

  const noObject = recordKeycloak([TOKEN, CLIENT_LOOKUP, AUTHZ_ENABLED, ok([])])
  try {
    const result = await driftDetect(driftContext([item('scope', SCOPE_ITEM)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    noObject.restore()
  }
})

test('authorization driftDetect skips an item whose declared reference cannot be resolved', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    CLIENT_LOOKUP,
    AUTHZ_ENABLED,
    ok([{ ...LIVE_RESOURCE, uris: ['/*'] }]), // the resource IS there and HAS drifted
    ok([]), // but the declared scope name resolves to nothing
  ])
  try {
    const result = await driftDetect(driftContext([item('resource', RESOURCE_ITEM)]))

    // Comparing an unresolvable reference would report a difference that is
    // really just an incomplete read.
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

// --- healthCheck / getStatus --------------------------------------------------

describeHealthCheckContract('authorization', healthCheck)
describeGetStatusContract('authorization', getStatus, 'keycloak-authorization')
