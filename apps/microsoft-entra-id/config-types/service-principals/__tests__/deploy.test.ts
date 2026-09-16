// ============================================================================
// deploy for Entra service principals (enterprise applications), against a fake
// Microsoft Graph.
//
// A service principal is the tenant-local instance of an application, so the
// fields this handler writes decide whether the app can sign anyone in at all
// (`accountEnabled`) and whether a user needs an explicit assignment first
// (`appRoleAssignmentRequired`) — the switch that separates "only the people we
// assigned" from "anyone in the tenant". An SP already exists for every
// installed enterprise app, so the normal path is PATCH-existing keyed on
// appId, and create is the rare one; both are asserted here on the wire.
//
// These use `routeFetch`: deploy builds the two owner-principal name maps with
// `Promise.all`, and a response queue would encode an ordering those parallel
// listings do not guarantee.
// ============================================================================

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
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

/** The appId of the application this service principal represents. */
const APP_ID = '77777777-7777-4777-8777-777777777777'

/** GET /servicePrincipals?$filter=appId eq '…' — the per-item lookup. */
const FIND = /\/servicePrincipals\?\$filter=appId/
/** GET /servicePrincipals?$select=id,displayName — the owner name map. */
const SP_MAP = /\/servicePrincipals\?\$select=id,displayName$/
const USERS = /\/users\?\$select=/
const OWNERS = /\/servicePrincipals\/[^/]+\/owners/
/** PATCH or DELETE /servicePrincipals/{objectId}. */
const BY_ID = /\/servicePrincipals\/[^/?]+$/
/** POST /servicePrincipals — the rare create. */
const CREATE = /\/v1\.0\/servicePrincipals$/

function liveSp(over: Record<string, unknown> = {}) {
  return {
    id: 'sp-1',
    appId: APP_ID,
    displayName: 'Contoso Enterprise App',
    accountEnabled: true,
    appRoleAssignmentRequired: false,
    preferredSingleSignOnMode: null,
    homepage: null,
    notificationEmailAddresses: [],
    tags: [],
    servicePrincipalType: 'Application',
    ...over,
  }
}

function spItem(fields: Record<string, unknown> = {}, id?: string) {
  return item('Contoso Enterprise App', { appId: APP_ID, ...fields }, id)
}

type Entries = Array<Record<string, unknown>>
const entriesOf = (result: { rollbackData?: unknown }): Entries =>
  (result.rollbackData as { entries: Entries }).entries

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([spItem()], { credential: null }))

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
    const result = await deploy(deployContext([spItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed service-principal lookup stops the item before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: FIND, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
    { url: USERS, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
  ])
  try {
    const result = await deploy(deployContext([spItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see the live SP must not patch or create one',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first, patches the existing SP and records its LIVE prior fields', async () => {
  const live = liveSp({
    accountEnabled: false,
    appRoleAssignmentRequired: false,
    preferredSingleSignOnMode: 'password',
    homepage: 'https://old.contoso.com',
    notificationEmailAddresses: ['old-ops@contoso.com'],
    tags: ['WindowsAzureActiveDirectoryIntegratedApp'],
  })
  const { calls, restore } = routeFetch([
    { url: FIND, respond: collection([live]) },
    { url: USERS, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: OWNERS, method: 'GET', respond: collection([]) },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(
      deployContext([
        spItem({
          accountEnabled: true,
          appRoleAssignmentRequired: true,
          preferredSingleSignOnMode: 'saml',
          homepage: 'https://app.contoso.com',
          notificationEmailAddresses: 'sso-ops@contoso.com',
          tags: 'HideApp',
        }),
      ]),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const patch = graphCalls.find((c) => c.method === 'PATCH')
    assert.ok(patch, 'an existing SP is updated, not duplicated')
    assert.ok(patch.url.endsWith('/servicePrincipals/sp-1'))
    assert.deepEqual(bodyOf(patch), {
      accountEnabled: true,
      // The switch between "only assigned users" and "anyone in the tenant" —
      // it has to arrive as declared, not as a default.
      appRoleAssignmentRequired: true,
      preferredSingleSignOnMode: 'saml',
      homepage: 'https://app.contoso.com',
      notificationEmailAddresses: ['sso-ops@contoso.com'],
      tags: ['HideApp'],
    })

    const entries = entriesOf(result)
    assert.equal(entries[0].existed, true)
    // Rollback has to restore what the tenant HAD, not what the canvas wanted.
    assert.deepEqual(entries[0].prior, {
      accountEnabled: false,
      appRoleAssignmentRequired: false,
      preferredSingleSignOnMode: 'password',
      homepage: 'https://old.contoso.com',
      notificationEmailAddresses: ['old-ops@contoso.com'],
      tags: ['WindowsAzureActiveDirectoryIntegratedApp'],
    })
    assert.notDeepEqual(bodyOf(patch), entries[0].prior)
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'the access token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('an unrecognised single sign-on mode is sent as null rather than passed through', async () => {
  const { calls, restore } = routeFetch([
    { url: FIND, respond: collection([liveSp()]) },
    { url: USERS, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: OWNERS, method: 'GET', respond: collection([]) },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
  ])
  try {
    await deploy(deployContext([spItem({ preferredSingleSignOnMode: 'SAML2' })]))

    const body = bodyOf(writeCalls(calls)[0])
    assert.ok(body)
    assert.equal(body.preferredSingleSignOnMode, null, 'an unknown mode must not be forwarded to Graph verbatim')
  } finally {
    restore()
  }
})

test('deploy creates the SP with only its appId, then applies the managed settings', async () => {
  const { calls, restore } = routeFetch([
    { url: FIND, respond: collection([]) },
    { url: USERS, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: OWNERS, method: 'GET', respond: collection([]) },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
    { url: CREATE, method: 'POST', respond: created({ id: 'sp-new', appId: APP_ID }) },
  ])
  try {
    const result = await deploy(deployContext([spItem({ appRoleAssignmentRequired: true })]))

    const writes = writeCalls(calls)
    assert.equal(writes[0].method, 'POST')
    assert.ok(writes[0].url.endsWith('/servicePrincipals'))
    // Graph derives everything else from the application, so the create body is
    // exactly the appId; the settings follow in a second call.
    assert.deepEqual(bodyOf(writes[0]), { appId: APP_ID })

    assert.equal(writes[1].method, 'PATCH')
    assert.ok(writes[1].url.endsWith('/servicePrincipals/sp-new'))
    assert.equal(bodyOf(writes[1])?.appRoleAssignmentRequired, true)

    const entries = entriesOf(result)
    assert.equal(entries[0].existed, false, 'a created SP must stay marked created, or reconcile orphans it')
    assert.equal(entries[0].id, 'sp-new')
    assert.equal(entries[0].prior, undefined, 'there is no prior state to restore for something we created')
  } finally {
    restore()
  }
})

test('deploy adds a declared owner by $ref and records that IT added it', async () => {
  const { calls, restore } = routeFetch([
    { url: FIND, respond: collection([liveSp()]) },
    { url: USERS, respond: collection([{ id: 'u-1', displayName: 'Ada Lovelace', userPrincipalName: 'ada@contoso.com' }]) },
    { url: SP_MAP, respond: collection([]) },
    { url: OWNERS, method: 'GET', respond: collection([]) },
    { url: OWNERS, method: 'POST', respond: NO_CONTENT },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([spItem({ owners: 'ada@contoso.com' })]))

    const add = writeCalls(calls).find((c) => c.method === 'POST')
    assert.ok(add, 'expected a POST to owners/$ref')
    assert.ok(add.url.endsWith('/servicePrincipals/sp-1/owners/$ref'))
    assert.deepEqual(bodyOf(add), {
      '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/u-1',
    })

    assert.deepEqual(entriesOf(result)[0].owners, [{ id: 'u-1', existed: false }])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an owner that is already on the SP is tracked as pre-existing and not re-added', async () => {
  const { calls, restore } = routeFetch([
    { url: FIND, respond: collection([liveSp()]) },
    { url: USERS, respond: collection([{ id: 'u-1', displayName: 'Ada Lovelace' }]) },
    { url: SP_MAP, respond: collection([]) },
    { url: OWNERS, method: 'GET', respond: collection([{ id: 'u-1' }]) },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([spItem({ owners: 'Ada Lovelace' })]))

    assert.equal(writeCalls(calls).filter((c) => /\$ref$/.test(c.url)).length, 0)
    assert.deepEqual(entriesOf(result)[0].owners, [{ id: 'u-1', existed: true }])
  } finally {
    restore()
  }
})

test('deploy revokes only the owner reference IT added once the canvas drops it', async () => {
  const { calls, restore } = routeFetch([
    { url: FIND, respond: collection([liveSp()]) },
    { url: USERS, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: OWNERS, method: 'GET', respond: collection([{ id: 'u-added' }, { id: 'u-preexisting' }]) },
    { url: OWNERS, method: 'DELETE', respond: NO_CONTENT },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
  ])
  try {
    await deploy(
      deployContext([spItem({}, 'ci-1')], {
        priorRollbackData: {
          entries: [
            {
              itemId: 'ci-1',
              appId: APP_ID,
              existed: true,
              id: 'sp-1',
              prior: {},
              owners: [
                { id: 'u-added', existed: false },
                { id: 'u-preexisting', existed: true },
              ],
            },
          ],
        },
      }),
    )

    const revokes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(revokes.length, 1, 'an owner that pre-dated this app must survive')
    // Without the trailing /$ref Graph deletes the owner's directory object
    // instead of the ownership reference.
    assert.ok(revokes[0].url.endsWith('/servicePrincipals/sp-1/owners/u-added/$ref'))
  } finally {
    restore()
  }
})

test('an unresolvable owner name fails the item and leaves ownership completely untouched', async () => {
  const { calls, restore } = routeFetch([
    { url: FIND, respond: collection([liveSp()]) },
    { url: USERS, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: BY_ID, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([spItem({ owners: 'Ghost Owner' })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown owner\(s\) Ghost Owner/)
    assert.equal(
      vendorCalls(calls).filter((c) => /\/owners/.test(c.url)).length,
      0,
      'ownership must not be half-applied — it is not even read while one owner is unknown',
    )
    assert.deepEqual(entriesOf(result)[0].owners, [])
  } finally {
    restore()
  }
})

test('deploy reports a rejected patch rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: FIND, respond: collection([liveSp()]) },
    { url: USERS, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    {
      url: BY_ID,
      method: 'PATCH',
      respond: graphError(400, 'Property preferredSingleSignOnMode is invalid.', 'Request_BadRequest'),
    },
  ])
  try {
    const result = await deploy(deployContext([spItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /preferredSingleSignOnMode is invalid/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes an SP it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: USERS, respond: collection([]) },
    { url: SP_MAP, respond: collection([]) },
    { url: BY_ID, method: 'DELETE', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { appId: '11111111-1111-4111-8111-111111111111', existed: false, id: 'sp-old' },
            { appId: '22222222-2222-4222-8222-222222222222', existed: true, id: 'sp-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'a pre-existing enterprise app must never be deleted by a reconcile')
    assert.ok(deletes[0].url.endsWith('/servicePrincipals/sp-old'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
