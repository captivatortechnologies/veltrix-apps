// ============================================================================
// deploy for Entra application registrations, against a fake Microsoft Graph.
//
// An application registration is an identity: its redirect URIs are where
// tokens get sent, its appRoles are what callers can claim, and its owners can
// mint new client secrets for it. So the assertions here are about the bytes on
// the wire — which request, against which key, carrying which body — and about
// the two provenance rules that keep a deploy from wrecking a directory it does
// not own: an app is matched ONLY by the immutable uniqueName this app assigns
// (never by the non-unique displayName), and an owner reference is revoked only
// when THIS app added it.
//
// These use `routeFetch` rather than a response queue: deploy builds the two
// owner-principal name maps (users + service principals) with `Promise.all`, and
// a queue would encode an ordering those parallel listings do not guarantee.
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

/** GET /applications?$select=id,displayName,uniqueName,… — the live projection. */
const LIST = /\/applications\?\$select=id,displayName,uniqueName/
/** GET /users?$select=… — half of the owner-principal name map. */
const USERS = /\/users\?\$select=/
/** GET /servicePrincipals?$select=… — the other half. */
const SPS = /\/servicePrincipals\?\$select=/
/** Anything under /applications/{id}/owners — the $ref collection. */
const OWNERS = /\/applications\/[^/]+\/owners/
/** PATCH /applications(uniqueName='…') — the create-or-update upsert. */
const UPSERT = /\/applications\(uniqueName='[^']*'\)$/
/** PATCH or DELETE /applications/{objectId}. */
const BY_ID = /\/applications\/[^/?]+$/

/** A live registration carrying the uniqueName this app keys on. */
function liveApp(over: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    displayName: 'Contoso API',
    uniqueName: 'Contoso-API',
    signInAudience: 'AzureADMyOrg',
    identifierUris: [],
    web: { redirectUris: [] },
    spa: { redirectUris: [] },
    appRoles: [],
    requiredResourceAccess: [],
    groupMembershipClaims: null,
    tags: [],
    ...over,
  }
}

function appItem(fields: Record<string, unknown> = {}, id?: string) {
  return item('Contoso API', { name: 'Contoso API', ...fields }, id)
}

type Entries = Array<Record<string, unknown>>
const entriesOf = (result: { rollbackData?: unknown }): Entries =>
  (result.rollbackData as { entries: Entries }).entries

/**
 * The shared harness records only Authorization / Content-Type / Accept-Language.
 * `Prefer: create-if-missing` is what turns a PATCH-by-alternate-key into an
 * upsert — without it Graph 404s instead of creating — so capture the full
 * header set locally by wrapping the fetch the harness just installed.
 */
function captureHeaders(): { seen: Array<{ url: string; headers: Record<string, string> }>; restore: () => void } {
  const inner = globalThis.fetch
  const seen: Array<{ url: string; headers: Record<string, string> }> = []
  globalThis.fetch = ((input: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push({ url: String(input), headers: { ...(init?.headers ?? {}) } })
    return (inner as (i: unknown, n?: unknown) => Promise<unknown>)(input, init)
  }) as unknown as typeof globalThis.fetch
  return {
    seen,
    restore: () => {
      globalThis.fetch = inner
    },
  }
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([appItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  // Client credentials has no token endpoint without the directory (tenant) id,
  // so this must fail closed BEFORE any network call, not half way through.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([appItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed application listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await deploy(deployContext([appItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list applications/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see live registrations must not create or patch one',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates a registration by the uniqueName alternate key', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
    { url: OWNERS, method: 'GET', respond: collection([]) },
    { url: UPSERT, method: 'PATCH', respond: created({ id: 'app-new' }) },
  ])
  try {
    const result = await deploy(
      deployContext([appItem({ redirectUris: 'https://app.contoso.com/callback' })]),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const write = graphCalls.find((c) => c.method === 'PATCH')
    assert.ok(write, 'expected the upsert PATCH that creates the registration')
    assert.ok(
      write.url.endsWith("/applications(uniqueName='Contoso-API')"),
      `create must address the immutable alternate key, was ${write.url}`,
    )

    const body = bodyOf(write)
    assert.ok(body)
    assert.equal(body.displayName, 'Contoso API')
    assert.equal(body.signInAudience, 'AzureADMyOrg')
    assert.deepEqual(body.web, { redirectUris: ['https://app.contoso.com/callback'] })
    // uniqueName is read-only on the resource — it is set through the URL key,
    // and sending it in the body makes Graph reject the whole write.
    assert.equal('uniqueName' in body, false)
    // A field the author did not declare is left out entirely, so an unmanaged
    // portal setting (homePageUrl, implicit grant, …) is never blanked.
    assert.equal('spa' in body, false)
    assert.equal('tags' in body, false)

    assert.equal(result.success, true)
    const entries = entriesOf(result)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, false, 'a created app must stay marked created, or reconcile orphans it')
    assert.equal(entries[0].id, 'app-new')
    assert.equal(entries[0].uniqueName, 'Contoso-API')
    assert.equal(leaksSecret(result), false, 'the access token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('the create-or-update PATCH carries Prefer: create-if-missing', async () => {
  const graph = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
    { url: OWNERS, method: 'GET', respond: collection([]) },
    { url: UPSERT, method: 'PATCH', respond: created({ id: 'app-new' }) },
  ])
  const headers = captureHeaders()
  try {
    await deploy(deployContext([appItem()]))

    const upsert = headers.seen.find((c) => UPSERT.test(c.url))
    assert.ok(upsert, 'expected the upsert call')
    // Without this header a PATCH against a uniqueName that does not exist yet
    // is a 404, not a create — the whole first deploy would fail.
    assert.equal(upsert.headers.Prefer, 'create-if-missing')
  } finally {
    headers.restore()
    graph.restore()
  }
})

test('deploy updates an existing registration and records its LIVE prior fields', async () => {
  const live = liveApp({
    displayName: 'Contoso API',
    signInAudience: 'AzureADMultipleOrgs',
    web: { redirectUris: ['https://old.contoso.com/callback'] },
    tags: ['HideApp'],
  })
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([live]) },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
    { url: OWNERS, method: 'GET', respond: collection([]) },
    { url: UPSERT, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(
      deployContext([appItem({ redirectUris: 'https://app.contoso.com/callback' })]),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'an existing registration is updated, not duplicated')
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith("/applications(uniqueName='Contoso-API')"))

    const entries = entriesOf(result)
    assert.equal(entries[0].existed, true)
    // Rollback has to restore what the tenant HAD, not what the canvas wanted.
    assert.deepEqual(entries[0].prior, {
      displayName: 'Contoso API',
      signInAudience: 'AzureADMultipleOrgs',
      web: { redirectUris: ['https://old.contoso.com/callback'] },
      spa: { redirectUris: [] },
      identifierUris: [],
      tags: ['HideApp'],
      groupMembershipClaims: null,
      appRoles: [],
      requiredResourceAccess: [],
    })

    const sent = bodyOf(writes[0])
    assert.ok(sent)
    assert.notDeepEqual(sent.web, (entries[0].prior as { web: unknown }).web)
    assert.notEqual(sent.signInAudience, (entries[0].prior as { signInAudience: string }).signInAudience)
  } finally {
    restore()
  }
})

test('a same-named registration without this app\'s uniqueName is never adopted and patched', async () => {
  // displayName is not unique in Entra. Matching on it would PATCH an unrelated
  // pre-existing registration — here the upsert must create our own instead.
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveApp({ id: 'someone-elses', uniqueName: null })]) },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
    { url: OWNERS, method: 'GET', respond: collection([]) },
    { url: UPSERT, method: 'PATCH', respond: created({ id: 'app-new' }) },
  ])
  try {
    const result = await deploy(deployContext([appItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.ok(
      writes[0].url.endsWith("/applications(uniqueName='Contoso-API')"),
      'the write must go to our own key, never to /applications/someone-elses',
    )
    assert.equal(
      writes.some((c) => c.url.includes('/applications/someone-elses')),
      false,
    )
    assert.equal(entriesOf(result)[0].id, 'app-new')
  } finally {
    restore()
  }
})

test('deploy adds a declared owner by $ref and records that IT added it', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveApp()]) },
    { url: USERS, respond: collection([{ id: 'u-1', displayName: 'Ada Lovelace', userPrincipalName: 'ada@contoso.com' }]) },
    { url: SPS, respond: collection([]) },
    { url: OWNERS, method: 'GET', respond: collection([]) },
    { url: OWNERS, method: 'POST', respond: NO_CONTENT },
    { url: UPSERT, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([appItem({ owners: 'Ada Lovelace' })]))

    const add = writeCalls(calls).find((c) => c.method === 'POST')
    assert.ok(add, 'expected a POST to owners/$ref')
    assert.ok(add.url.endsWith('/applications/app-1/owners/$ref'))
    // An owner can mint credentials for the app — the id granted has to be the
    // one that was resolved, addressed in the directoryObjects id space.
    assert.deepEqual(bodyOf(add), {
      '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/u-1',
    })

    assert.deepEqual(entriesOf(result)[0].owners, [{ id: 'u-1', existed: false }])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an owner that is already on the app is tracked as pre-existing and not re-added', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveApp()]) },
    { url: USERS, respond: collection([{ id: 'u-1', displayName: 'Ada Lovelace' }]) },
    { url: SPS, respond: collection([]) },
    { url: OWNERS, method: 'GET', respond: collection([{ id: 'u-1' }]) },
    { url: UPSERT, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([appItem({ owners: 'Ada Lovelace' })]))

    assert.equal(
      writeCalls(calls).filter((c) => /\$ref$/.test(c.url)).length,
      0,
      'an ownership that already exists must not be written again',
    )
    // existed:true is what stops rollback revoking an ownership it never granted.
    assert.deepEqual(entriesOf(result)[0].owners, [{ id: 'u-1', existed: true }])
  } finally {
    restore()
  }
})

test('deploy revokes only the owner reference IT added once the canvas drops it', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveApp()]) },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
    { url: OWNERS, method: 'GET', respond: collection([{ id: 'u-added' }, { id: 'u-preexisting' }]) },
    { url: OWNERS, method: 'DELETE', respond: NO_CONTENT },
    { url: UPSERT, method: 'PATCH', respond: ok({}) },
  ])
  try {
    await deploy(
      deployContext([appItem({}, 'ci-1')], {
        priorRollbackData: {
          entries: [
            {
              itemId: 'ci-1',
              name: 'Contoso API',
              uniqueName: 'Contoso-API',
              existed: true,
              id: 'app-1',
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
    // The trailing /$ref is what keeps this a de-link: without it Graph deletes
    // the owner's directory object instead of just the ownership.
    assert.ok(revokes[0].url.endsWith('/applications/app-1/owners/u-added/$ref'))
  } finally {
    restore()
  }
})

test('an unresolvable owner name fails the item and leaves ownership completely untouched', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveApp()]) },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
    { url: UPSERT, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([appItem({ owners: 'Ghost Owner' })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown owner\(s\) Ghost Owner/)
    assert.equal(
      vendorCalls(calls).filter((c) => /\/owners/.test(c.url)).length,
      0,
      'ownership must not be half-applied — it is not even read while one owner is unknown',
    )
    assert.deepEqual(entriesOf(result)[0].owners, [], 'ownership is left exactly as last tracked')
  } finally {
    restore()
  }
})

test('deploy reports a rejected write rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
    {
      url: UPSERT,
      method: 'PATCH',
      respond: graphError(400, 'Another object with the same value for property identifierUris already exists.', 'Request_BadRequest'),
    },
  ])
  try {
    const result = await deploy(deployContext([appItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /identifierUris already exists/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes a registration it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
    { url: BY_ID, method: 'DELETE', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired API', uniqueName: 'Retired-API', existed: false, id: 'app-old' },
            { name: 'Adopted API', uniqueName: 'Adopted-API', existed: true, id: 'app-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only a registration this app created may be deleted')
    assert.ok(deletes[0].url.endsWith('/applications/app-old'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a still-declared registration is never deleted just because its update failed', async () => {
  // The reconcile set is built from the declared SPECS, not from the entries that
  // succeeded — otherwise a transient 500 on the PATCH turns into a deletion.
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: USERS, respond: collection([]) },
    { url: SPS, respond: collection([]) },
    { url: UPSERT, method: 'PATCH', respond: graphError(500, 'Service unavailable', 'ServiceUnavailable') },
  ])
  try {
    const result = await deploy(
      deployContext([appItem()], {
        priorRollbackData: {
          entries: [{ name: 'Contoso API', uniqueName: 'Contoso-API', existed: false, id: 'app-1' }],
        },
      }),
    )

    assert.equal(result.success, false)
    assert.equal(
      writeCalls(calls).filter((c) => c.method === 'DELETE').length,
      0,
      'a declared app must survive a failed update',
    )
  } finally {
    restore()
  }
})
