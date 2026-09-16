import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  created,
  deployContext,
  graphError,
  item,
  leaksSecret,
  ok,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'
import { buildCreateBody, type ResolvedGrant } from '../deploy'

describe('buildCreateBody', () => {
  const base: ResolvedGrant = {
    clientId: 'sp-client-1',
    resourceId: 'sp-resource-1',
    consentType: 'AllPrincipals',
    principalId: '',
    scope: 'User.Read',
  }

  it('omits principalId for an AllPrincipals grant', () => {
    const body = buildCreateBody(base)
    expect(body).toEqual({
      clientId: 'sp-client-1',
      consentType: 'AllPrincipals',
      resourceId: 'sp-resource-1',
      scope: 'User.Read',
    })
    expect('principalId' in body).toBe(false)
  })

  it('includes the resolved principalId for a Principal grant', () => {
    const body = buildCreateBody({ ...base, consentType: 'Principal', principalId: 'user-1' })
    expect(body).toEqual({
      clientId: 'sp-client-1',
      consentType: 'Principal',
      resourceId: 'sp-resource-1',
      principalId: 'user-1',
      scope: 'User.Read',
    })
  })
})

// ============================================================================
// deploy, end to end against a fake Microsoft Graph.
//
// Everything above tests the exported body builder in isolation. What follows
// drives the DEFAULT export — the handler that writes delegated consent into a
// customer's directory. An oauth2PermissionGrant IS the consent: its `scope` is
// the exact set of delegated permissions a client may exercise against a
// resource API on a user's behalf, so a scope that arrives wider than declared
// is a silent privilege escalation nobody is prompted about. Every assertion
// below is about the bytes on the wire.
//
// These use `routeFetch`: deploy builds the service-principal and user name
// maps with `Promise.all`, and a response queue would encode an ordering those
// parallel listings do not guarantee.
// ============================================================================

/** Object ids, so the id-aware resolver passes them through with no lookup. */
const CLIENT = '11111111-1111-4111-8111-111111111111'
const RESOURCE = '22222222-2222-4222-8222-222222222222'

/** PATCH or DELETE /oauth2PermissionGrants/{id}. */
const BY_ID = /\/oauth2PermissionGrants\/[^/?]+$/
/** GET (list) or POST (create) /oauth2PermissionGrants. */
const GRANTS = /\/oauth2PermissionGrants$/
const SP_MAP = /\/servicePrincipals\?\$select=/
const USERS = /\/users\?\$select=/

function liveGrant(over: Record<string, unknown> = {}) {
  return {
    id: 'g-1',
    clientId: CLIENT,
    resourceId: RESOURCE,
    consentType: 'AllPrincipals',
    principalId: null,
    scope: 'User.Read',
    ...over,
  }
}

function grantItem(fields: Record<string, unknown> = {}, id?: string) {
  return item('Contoso client -> Graph', { clientId: CLIENT, resourceId: RESOURCE, scope: 'User.Read', ...fields }, id)
}

type Entries = Array<Record<string, unknown>>
const entriesOf = (result: { rollbackData?: unknown }): Entries =>
  (result.rollbackData as { entries: Entries }).entries

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([grantItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  // Client credentials has no token endpoint without the directory (tenant) id.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([grantItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed grant listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: GRANTS, method: 'GET', respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await deploy(deployContext([grantItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list oauth2 permission grants/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see live consent must not grant more of it',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates a tenant-wide grant with exactly the declared scope', async () => {
  const { calls, restore } = routeFetch([
    { url: BY_ID, respond: ok({}) },
    { url: GRANTS, method: 'GET', respond: collection([]) },
    { url: GRANTS, method: 'POST', respond: created({ id: 'g-new' }) },
    { url: SP_MAP, respond: collection([]) },
    { url: USERS, respond: collection([]) },
  ])
  try {
    const result = await deploy(deployContext([grantItem({ scope: 'User.Read' })]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const post = graphCalls.find((c) => c.method === 'POST')
    assert.ok(post, 'expected a POST creating the grant')
    assert.ok(post.url.endsWith('/oauth2PermissionGrants'))
    // The whole body, not just the scope: an extra or broader permission here is
    // consent nobody was ever prompted for.
    assert.deepEqual(bodyOf(post), {
      clientId: CLIENT,
      consentType: 'AllPrincipals',
      resourceId: RESOURCE,
      scope: 'User.Read',
    })

    assert.equal(result.success, true)
    const entries = entriesOf(result)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].id, 'g-new')
    assert.equal(entries[0].name, `${CLIENT}|${RESOURCE}|allprincipals|`.toLowerCase())
    assert.equal(leaksSecret(result), false, 'the access token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('a Principal grant resolves the hand-typed user and consents only for that principal', async () => {
  const { calls, restore } = routeFetch([
    { url: BY_ID, respond: ok({}) },
    { url: GRANTS, method: 'GET', respond: collection([]) },
    { url: GRANTS, method: 'POST', respond: created({ id: 'g-new' }) },
    { url: SP_MAP, respond: collection([]) },
    { url: USERS, respond: collection([{ id: 'u-1', displayName: 'Ada Lovelace', userPrincipalName: 'ada@contoso.com' }]) },
  ])
  try {
    const result = await deploy(
      deployContext([grantItem({ consentType: 'Principal', principalId: 'ada@contoso.com' })]),
    )

    const post = writeCalls(calls).find((c) => c.method === 'POST')
    assert.ok(post)
    // principalId is what keeps this single-user consent rather than tenant-wide.
    assert.deepEqual(bodyOf(post), {
      clientId: CLIENT,
      consentType: 'Principal',
      resourceId: RESOURCE,
      principalId: 'u-1',
      scope: 'User.Read',
    })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('deploy updates an existing grant by scope alone and records its LIVE prior scope', async () => {
  const { calls, restore } = routeFetch([
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
    { url: GRANTS, method: 'GET', respond: collection([liveGrant({ scope: 'User.Read' })]) },
    { url: SP_MAP, respond: collection([]) },
    { url: USERS, respond: collection([]) },
  ])
  try {
    const result = await deploy(deployContext([grantItem({ scope: 'User.Read Mail.Read' })]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'an existing grant is updated, never duplicated')
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith('/oauth2PermissionGrants/g-1'))
    // scope is the only updatable field; re-sending clientId/resourceId would be
    // an attempt to re-point the grant at a different client or API.
    assert.deepEqual(bodyOf(writes[0]), { scope: 'User.Read Mail.Read' })

    const entries = entriesOf(result)
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 'g-1')
    // Rollback has to narrow the consent back to what the tenant HAD.
    assert.deepEqual(entries[0].prior, { scope: 'User.Read' })
    assert.notDeepEqual(entries[0].prior, bodyOf(writes[0]))
  } finally {
    restore()
  }
})

test('an unresolvable client reference fails the item without granting anything', async () => {
  const { calls, restore } = routeFetch([
    { url: GRANTS, method: 'GET', respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: USERS, respond: collection([]) },
  ])
  try {
    const result = await deploy(deployContext([grantItem({ clientId: 'Ghost Client' })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown target\(s\) Ghost Client/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'consent whose client cannot be identified must not be written at all',
    )
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})

test('deploy reports a rejected create rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: GRANTS, method: 'GET', respond: collection([]) },
    {
      url: GRANTS,
      method: 'POST',
      respond: graphError(400, 'Permission entry already exists for the specified client and resource.', 'Request_BadRequest'),
    },
    { url: SP_MAP, respond: collection([]) },
    { url: USERS, respond: collection([]) },
  ])
  try {
    const result = await deploy(deployContext([grantItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Permission entry already exists/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy revokes a grant it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: BY_ID, method: 'DELETE', respond: NO_CONTENT },
    { url: GRANTS, method: 'GET', respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: USERS, respond: collection([]) },
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'a|b|allprincipals|', existed: false, id: 'g-old' },
            { name: 'c|d|allprincipals|', existed: true, id: 'g-keep', prior: { scope: 'User.Read' } },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'consent this app did not grant is not this app\'s to revoke')
    assert.ok(deletes[0].url.endsWith('/oauth2PermissionGrants/g-old'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a still-declared grant survives a run where its own resolution failed', async () => {
  // The reconcile keeps any prior entry whose itemId is still declared, so a
  // transient name-resolution miss never turns into a revoked consent.
  const { calls, restore } = routeFetch([
    { url: GRANTS, method: 'GET', respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: USERS, respond: collection([]) },
  ])
  try {
    const result = await deploy(
      deployContext([grantItem({ clientId: 'Ghost Client' }, 'ci-1')], {
        priorRollbackData: {
          entries: [{ itemId: 'ci-1', name: `${CLIENT}|${RESOURCE}|allprincipals|`, existed: false, id: 'g-1' }],
        },
      }),
    )

    assert.equal(result.success, false)
    assert.equal(
      writeCalls(calls).filter((c) => c.method === 'DELETE').length,
      0,
      'a declared grant must survive a failed resolution',
    )
  } finally {
    restore()
  }
})
