// =============================================================================
// Keycloak Clients — deploy / rollback / healthCheck / driftDetect / getStatus
// driven end to end against the fake Keycloak in lib/__tests__/fakeKeycloak.ts.
//
// `clients.test.ts` next to this file covers validate and the pure _shared
// helpers. This file covers the five handlers that reach a customer's realm: a
// silent failure in any of them breaks authentication for every application
// backed by that client.
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
  kcError,
  leaksToken,
  noContent,
  notFound,
  ok,
  created,
  item,
  recordKeycloak,
  rollbackContext,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeKeycloak'
import { describeHealthCheckContract } from '../../../lib/__tests__/healthCheckContract'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

const WEB_APP = {
  clientId: 'web-app',
  name: 'Web App',
  protocol: 'openid-connect',
  enabled: true,
  publicClient: false,
  standardFlowEnabled: true,
  redirectUris: 'https://app.example.com/*\nhttps://app.example.com/cb',
}

/** The live client a deploy/drift run finds in the realm. */
function liveClient(over: Record<string, unknown> = {}) {
  return {
    id: 'uuid-web-app',
    clientId: 'web-app',
    name: 'Web App',
    protocol: 'openid-connect',
    enabled: true,
    publicClient: false,
    standardFlowEnabled: true,
    redirectUris: ['https://app.example.com/*', 'https://app.example.com/cb'],
    ...over,
  }
}

// --- deploy -------------------------------------------------------------------

test('clients deploy refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([item('web', WEB_APP)], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Keycloak without a credential')
  } finally {
    restore()
  }
})

test('clients deploy obtains the admin token before the first realm call', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok([]), created(), ok([liveClient()])])
  try {
    await deploy(deployContext([item('web', WEB_APP)]))

    assert.ok(isTokenCall(calls[0]), `first call must be the token exchange, got ${calls[0].path}`)
    assert.equal(calls.filter(isTokenCall).length, 1, 'the token is cached for the run, not re-fetched per call')
    assert.ok(
      vendorCalls(calls).every((call) => call.authorization?.startsWith('Bearer ')),
      'every realm call must carry the bearer token',
    )
  } finally {
    restore()
  }
})

test('clients deploy creates a client that does not exist and re-reads it to capture the id', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    ok([]), // identity lookup: no such clientId
    created(`https://keycloak.example.com${ADMIN_BASE}/clients/uuid-web-app`),
    ok([liveClient()]), // re-read to capture the id Keycloak only returns in `location`
  ])
  try {
    const result = await deploy(deployContext([item('web', WEB_APP)]))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['GET /clients?clientId=web-app', 'POST /clients', 'GET /clients?clientId=web-app'],
    )

    const body = bodyOf(vendor[1]) as Record<string, unknown>
    assert.equal(body.clientId, 'web-app')
    assert.equal(body.protocol, 'openid-connect')
    assert.equal(body.enabled, true)
    assert.equal(body.publicClient, false)
    assert.deepEqual(body.redirectUris, ['https://app.example.com/*', 'https://app.example.com/cb'])
    assert.equal(body.id, undefined, 'a create must not invent an internal id')

    assert.equal(result.success, true)
    const previous = (result.rollbackData as { previous: Array<Record<string, unknown>> }).previous
    assert.deepEqual(previous, [{ clientId: 'web-app', id: 'uuid-web-app', client: null }])
  } finally {
    restore()
  }
})

test('clients deploy updates the existing client instead of creating a second one', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok([liveClient()]), noContent()])
  try {
    const result = await deploy(deployContext([item('web', { ...WEB_APP, enabled: false })]))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['GET /clients?clientId=web-app', 'PUT /clients/uuid-web-app'],
    )
    assert.equal(vendor.filter((c) => c.method === 'POST').length, 0, 'an existing client must never be re-created')

    const body = bodyOf(vendor[1]) as Record<string, unknown>
    assert.equal(body.id, 'uuid-web-app')
    assert.equal(body.enabled, false, 'the declared value must win on update')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('clients deploy preserves Keycloak-managed fields it does not author', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    ok([liveClient({ protocolMappers: [{ name: 'audience' }], attributes: { 'pkce.code.challenge.method': 'S256' } })]),
    noContent(),
  ])
  try {
    await deploy(deployContext([item('web', WEB_APP)]))

    const body = bodyOf(vendorCalls(calls)[1]) as Record<string, unknown>
    assert.deepEqual(body.protocolMappers, [{ name: 'audience' }], 'an update must not wipe unauthored fields')
    assert.deepEqual(body.attributes, { 'pkce.code.challenge.method': 'S256' })
  } finally {
    restore()
  }
})

test('clients deploy records the LIVE prior state for rollback, not the desired canvas values', async () => {
  const live = liveClient({ enabled: true, redirectUris: ['https://old.example.com/*'] })
  const { restore } = recordKeycloak([TOKEN, ok([live]), noContent()])
  try {
    const result = await deploy(
      deployContext([item('web', { ...WEB_APP, enabled: false, redirectUris: 'https://new.example.com/*' })]),
    )

    const previous = (result.rollbackData as { previous: Array<{ client: Record<string, unknown> }> }).previous
    assert.equal(previous.length, 1)
    // Rollback has to put the realm back the way it was found — the desired
    // values are exactly what it must NOT restore.
    assert.equal(previous[0].client.enabled, true)
    assert.deepEqual(previous[0].client.redirectUris, ['https://old.example.com/*'])
  } finally {
    restore()
  }
})

test('clients deploy sends the live secret back but never records it', async () => {
  const LIVE_SECRET = 'LIVE-CLIENT-SECRET-abc123'
  const live = liveClient({
    secret: LIVE_SECRET,
    registrationAccessToken: 'LIVE-REGISTRATION-TOKEN-xyz789',
    credentials: [{ type: 'secret', value: LIVE_SECRET }],
  })
  const { calls, restore } = recordKeycloak([TOKEN, ok([live]), noContent()])
  try {
    const result = await deploy(deployContext([item('web', WEB_APP)]))

    // Sending it back is what stops the update rotating the client's secret.
    const body = bodyOf(vendorCalls(calls)[1]) as Record<string, unknown>
    assert.equal(body.secret, LIVE_SECRET)

    // Recording it is different: the platform persists rollbackData, and unlike
    // IdP config or component config — which Keycloak masks on read — GET
    // /clients returns a confidential client's secret in full.
    const serialized = JSON.stringify(result.rollbackData)
    assert.equal(serialized.includes(LIVE_SECRET), false, 'a client secret must not reach the rollback-data store')
    assert.equal(serialized.includes('LIVE-REGISTRATION-TOKEN-xyz789'), false)
    const previous = (result.rollbackData as { previous: Array<{ client: Record<string, unknown> }> }).previous
    assert.equal('secret' in previous[0].client, false)
    assert.equal('credentials' in previous[0].client, false)
    // Everything else it needs to restore is still there.
    assert.equal(previous[0].client.clientId, 'web-app')
    assert.deepEqual(previous[0].client.redirectUris, ['https://app.example.com/*', 'https://app.example.com/cb'])
  } finally {
    restore()
  }
})

test('clients rollback restores without writing a secret it never captured', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, noContent()])
  try {
    // The restore omits the key rather than sending a placeholder, which leaves
    // the live secret alone — the same direction user-federation takes for a
    // masked bind credential.
    const prior = { id: 'uuid-web-app', clientId: 'web-app', enabled: true }
    await rollback(rollbackContext({ previous: [{ clientId: 'web-app', id: 'uuid-web-app', client: prior }] }))

    const body = bodyOf(writeCalls(calls)[0]) as Record<string, unknown>
    assert.equal('secret' in body, false)
    assert.equal(body.clientId, 'web-app')
  } finally {
    restore()
  }
})

test('clients deploy reports failure rather than throwing when Keycloak rejects the write', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([]), kcError(409, 'Client web-app already exists')])
  try {
    const result = await deploy(deployContext([item('web', WEB_APP)]))

    // A throw here surfaces as an opaque pipeline crash instead of a message
    // the operator can act on.
    assert.equal(result.success, false)
    assert.match(String(result.message), /409/)
    assert.match(String(result.message), /already exists/)
  } finally {
    restore()
  }
})

test('clients deploy stops at the first failing item and reports what it had applied', async () => {
  const { calls, restore } = recordKeycloak([
    TOKEN,
    ok([liveClient()]), // first item: found
    noContent(), // first item: updated
    ok([]), // second item: absent
    kcError(500, 'boom'), // second item: create rejected
  ])
  try {
    const result = await deploy(
      deployContext([item('web', WEB_APP), item('api', { ...WEB_APP, clientId: 'api' }), item('third', { ...WEB_APP, clientId: 'third' })]),
    )

    assert.equal(result.success, false)
    assert.deepEqual((result.artifacts as { applied: string[] }).applied, ['web-app'])
    // The third item is never attempted — the loop aborts on the first failure.
    assert.equal(vendorCalls(calls).length, 4)
    const previous = (result.rollbackData as { previous: unknown[] }).previous
    assert.equal(previous.length, 1, 'rollbackData must still carry what was already changed')
  } finally {
    restore()
  }
})

test('clients deploy skips an item with a blank clientId without calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await deploy(deployContext([item('blank', { ...WEB_APP, clientId: '   ' })]))

    assert.equal(result.success, true)
    assert.deepEqual((result.artifacts as { applied: string[] }).applied, [])
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('clients deploy never puts the admin token in its message, artifacts or rollbackData', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([liveClient()]), noContent()])
  try {
    const result = await deploy(deployContext([item('web', WEB_APP)]))

    assert.equal(leaksToken(result), false, 'the admin bearer token escaped into the deploy result')
  } finally {
    restore()
  }
})

// --- rollback -----------------------------------------------------------------

test('clients rollback does nothing, successfully, when there is no prior state', async () => {
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

test('clients rollback refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ clientId: 'web-app', id: 'uuid-web-app', client: liveClient() }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('clients rollback restores the captured prior representation verbatim', async () => {
  const prior = liveClient({ enabled: true, redirectUris: ['https://old.example.com/*'] })
  const { calls, restore } = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(rollbackContext({ previous: [{ clientId: 'web-app', id: 'uuid-web-app', client: prior }] }))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['PUT /clients/uuid-web-app'],
    )
    assert.deepEqual(bodyOf(vendor[0]), prior)
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 restored/)
  } finally {
    restore()
  }
})

test('clients rollback deletes a client the deploy created', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(rollbackContext({ previous: [{ clientId: 'web-app', id: 'uuid-web-app', client: null }] }))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['DELETE /clients/uuid-web-app'],
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('clients rollback treats an already-deleted client as success', async () => {
  const { restore } = recordKeycloak([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ previous: [{ clientId: 'web-app', id: 'uuid-web-app', client: null }] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('clients rollback skips an entry whose internal id was never learned', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await rollback(rollbackContext({ previous: [{ clientId: 'web-app', id: null, client: null }] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 skipped/)
    // Nothing is guessed at: no id means no safe target, so nothing is touched.
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('clients rollback reports failure rather than throwing when a restore is rejected', async () => {
  const { restore } = recordKeycloak([TOKEN, kcError(500, 'boom')])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ clientId: 'web-app', id: 'uuid-web-app', client: liveClient() }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback failed/)
    assert.match(String(result.message), /500/)
  } finally {
    restore()
  }
})

// --- driftDetect --------------------------------------------------------------

test('clients driftDetect reports no drift and makes no calls without a credential', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([item('web', WEB_APP)], { credential: null }))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('clients driftDetect reports no drift when the live client matches the canvas', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, ok([liveClient()])])
  try {
    const result = await driftDetect(driftContext([item('web', WEB_APP)]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must be read-only')
  } finally {
    restore()
  }
})

test('clients driftDetect reports each changed field it declares', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([liveClient({ enabled: false, publicClient: true })])])
  try {
    const result = await driftDetect(driftContext([item('web', WEB_APP)]))

    assert.equal(result.hasDrift, true)
    const fields = result.diffs.map((d) => d.field)
    assert.deepEqual(fields, ['web-app.enabled', 'web-app.publicClient'])
    const enabled = result.diffs.find((d) => d.field === 'web-app.enabled')
    assert.equal(enabled?.expected, true)
    assert.equal(enabled?.actual, false)
  } finally {
    restore()
  }
})

test('clients driftDetect compares redirect URIs as a set, not an ordered list', async () => {
  const reordered = recordKeycloak([
    TOKEN,
    ok([liveClient({ redirectUris: ['https://app.example.com/cb', 'https://app.example.com/*'] })]),
  ])
  try {
    const result = await driftDetect(driftContext([item('web', WEB_APP)]))
    assert.equal(result.hasDrift, false, 'redirect URI order is not a configuration change')
  } finally {
    reordered.restore()
  }

  const dropped = recordKeycloak([TOKEN, ok([liveClient({ redirectUris: ['https://app.example.com/*'] })])])
  try {
    const result = await driftDetect(driftContext([item('web', WEB_APP)]))
    assert.equal(result.hasDrift, true, 'a removed redirect URI is a real change')
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['web-app.redirectUris'],
    )
  } finally {
    dropped.restore()
  }
})

test('clients driftDetect skips a client it cannot read rather than asserting false drift', async () => {
  const unreadable = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await driftDetect(driftContext([item('web', WEB_APP)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    unreadable.restore()
  }

  const absent = recordKeycloak([TOKEN, ok([])])
  try {
    const result = await driftDetect(driftContext([item('web', WEB_APP)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    absent.restore()
  }
})

test('clients driftDetect only asserts a name difference when the canvas declares a name', async () => {
  const { restore } = recordKeycloak([TOKEN, ok([liveClient({ name: 'Renamed In Console' })])])
  try {
    const result = await driftDetect(driftContext([item('web', { ...WEB_APP, name: '' })]))

    assert.equal(result.hasDrift, false, 'an undeclared field is not managed, so it cannot drift')
  } finally {
    restore()
  }
})

// --- healthCheck / getStatus --------------------------------------------------

describeHealthCheckContract('clients', healthCheck)
describeGetStatusContract('clients', getStatus, 'keycloak-clients')
