// deploy for installation-tokens.
//
// An installation token is a SECRET: whoever holds its value can enrol a sensor
// into the customer's tenant. Falcon returns that value on create and on read,
// so the load-bearing assertion in this file is the one that proves the value
// never reaches a result message, an artifact or the rollback record.
//
// The other thing specific to this config type is transport: unlike the generic
// entity adapter, the update PATCH carries the id in the `ids` QUERY parameter,
// and create cannot set the revoke state — a token asked to be born revoked
// needs a second call, which must not be silently skipped.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  CREATED_WITHOUT_ID,
  EMPTY,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  callsOfMethod,
  created,
  deployContext,
  describeCalls,
  entityPage,
  forbidden,
  idsPage,
  item,
  leaksSecret,
  ok,
  partialFailure,
  routeFetch,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/installation-tokens\/queries\/tokens\/v1/
const ENTITY = /\/installation-tokens\/entities\/tokens\/v1/

/**
 * The token SECRET the fake tenant hands back. `leaksSecret()` only knows about
 * the OAuth2 token and the API client secret, so this file carries its own
 * detector for the one secret that is specific to installation tokens.
 */
const TOKEN_VALUE = 'falcon-installation-token-value-MUST-NOT-LEAK'

function leaksTokenValue(value: unknown): boolean {
  return (JSON.stringify(value ?? null) ?? '').includes(TOKEN_VALUE)
}

/**
 * One declared token. `extractInstallationTokenSpecs` reads a FLAT `fields`
 * record — `label`, `expiresTimestamp`, `revoked`.
 */
const TOKEN_ITEM = item('Workstation rollout', {
  label: 'workstation-rollout',
  expiresTimestamp: '2026-12-31T00:00:00Z',
  revoked: false,
})

/**
 * The token as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field (it is REVOKED and expires
 * nine months earlier), so a rollback record that captured the DESIRED values
 * instead of the LIVE ones fails these assertions.
 */
const LIVE_TOKEN = {
  id: 'tok-live-1',
  label: 'workstation-rollout',
  value: TOKEN_VALUE,
  expires_timestamp: '2026-03-01T00:00:00Z',
  status: 'revoked',
  revoked_timestamp: '2026-02-01T00:00:00Z',
}

registerDeployGuardContract({ label: 'installation-tokens', handler: deploy, items: [TOKEN_ITEM] })

test('installation-tokens deploy: creates a token that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'tok-new-1', value: TOKEN_VALUE }) },
  ])
  try {
    const result = await deploy(deployContext([TOKEN_ITEM]))

    assertAuthenticatedFirst(assert, calls)
    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)

    const body = bodyOf(posts[0])
    assert.equal(body?.label, 'workstation-rollout')
    assert.equal(body?.expires_timestamp, '2026-12-31T00:00:00Z')
    assert.equal(body?.revoked, undefined, 'create cannot set the revoke state — it is applied after')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('installation-tokens deploy: omits the expiry entirely for a token that never expires', async () => {
  const forever = item('Lab rollout', { label: 'lab-rollout', expiresTimestamp: '', revoked: false })
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'tok-new-2', value: TOKEN_VALUE }) },
  ])
  try {
    await deploy(deployContext([forever]))

    const body = bodyOf(callsOfMethod(calls, 'POST')[0])
    assert.equal(body?.expires_timestamp, undefined)
  } finally {
    restore()
  }
})

test('installation-tokens deploy: never lets the generated token value out of the handler', async () => {
  // The create response carries the secret that enrols sensors. A message,
  // artifact or rollback record holding it would persist it in the platform.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'tok-new-1', value: TOKEN_VALUE }) },
  ])
  try {
    const result = await deploy(deployContext([TOKEN_ITEM]))

    assert.equal(result.success, true)
    assert.equal(leaksTokenValue(result), false, 'the new token secret escaped the handler')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('installation-tokens deploy: records the created token so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'tok-new-1', value: TOKEN_VALUE }) },
  ])
  try {
    const result = await deploy(deployContext([TOKEN_ITEM]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].label, 'workstation-rollout')
    assert.equal(state[0].existed, false, 'a token this deploy created is not pre-existing')
    assert.equal(state[0].id, 'tok-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('installation-tokens deploy: revokes a token it just created when the canvas asked for that', async () => {
  // A token is born active, so a canvas asking for a revoked token needs a
  // second call. Skipping it would leave a usable enrolment secret live.
  const revokedOnDeploy = item('Retired rollout', {
    label: 'retired-rollout',
    expiresTimestamp: '',
    revoked: true,
  })
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'tok-new-3', value: TOKEN_VALUE }) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([revokedOnDeploy]))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected the revoke to follow the create, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /ids=tok-new-3/, 'the id rides in the query, not the body')
    assert.equal(bodyOf(patches[0])?.revoked, true)
  } finally {
    restore()
  }
})

test('installation-tokens deploy: records the created token BEFORE it tries to revoke it', async () => {
  // The token exists — and is usable — the moment the POST returns. If the
  // revoke that follows fails, the record of what to delete must already exist.
  const revokedOnDeploy = item('Retired rollout', {
    label: 'retired-rollout',
    expiresTimestamp: '',
    revoked: true,
  })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'tok-new-3', value: TOKEN_VALUE }) },
    { url: ENTITY, method: 'PATCH', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([revokedOnDeploy]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1)
    assert.equal(state[0].id, 'tok-new-3', 'an active enrolment token must be recoverable')
    assert.equal(leaksTokenValue(result), false)
  } finally {
    restore()
  }
})

test('installation-tokens deploy: updates an existing token, addressing it by id in the query', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['tok-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_TOKEN]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([TOKEN_ITEM]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing token must not be created again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /ids=tok-live-1/, 'the Installation Tokens API takes the id in the query')

    const body = bodyOf(patches[0])
    assert.equal(body?.label, 'workstation-rollout')
    assert.equal(body?.expires_timestamp, '2026-12-31T00:00:00Z')
    assert.equal(body?.id, undefined, 'the id must not also be sent in the body')
  } finally {
    restore()
  }
})

test('installation-tokens deploy: un-revokes a live revoked token rather than silently leaving it dead', async () => {
  // The tenant holds this token revoked; the canvas declares it active. Omitting
  // `revoked` from the patch would leave sensor enrolment broken with a green
  // deploy reported over the top of it.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['tok-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_TOKEN]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    await deploy(deployContext([TOKEN_ITEM]))

    assert.equal(bodyOf(callsOfMethod(calls, 'PATCH')[0])?.revoked, false)
  } finally {
    restore()
  }
})

test('installation-tokens deploy: revokes a live active token when the canvas asks for it', async () => {
  const revokeIt = item('Workstation rollout', {
    label: 'workstation-rollout',
    expiresTimestamp: '2026-12-31T00:00:00Z',
    revoked: true,
  })
  const liveActive = { id: 'tok-live-1', label: 'workstation-rollout', status: 'active', value: TOKEN_VALUE }
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['tok-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([liveActive]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([revokeIt]))

    assert.equal(result.success, true)
    assert.equal(bodyOf(callsOfMethod(calls, 'PATCH')[0])?.revoked, true)
  } finally {
    restore()
  }
})

test('installation-tokens deploy: records the LIVE prior label, expiry and revoke state', async () => {
  // The canvas asks for an active token expiring at the end of 2026; the tenant
  // holds a revoked one expiring in March. Rollback restores what was there, so
  // every one of these must come from LIVE_TOKEN.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['tok-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_TOKEN]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([TOKEN_ITEM]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{
          label: string
          existed: boolean
          id?: string
          prior?: { label: string; expiresTimestamp: string; revoked: boolean }
        }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'tok-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.label, 'workstation-rollout')
    assert.equal(prior.expiresTimestamp, '2026-03-01T00:00:00Z')
    assert.equal(prior.revoked, true, 'the live token was revoked — rollback must put it back that way')
    assert.equal(leaksTokenValue(result), false, 'the live token secret must not be recorded either')
  } finally {
    restore()
  }
})

test('installation-tokens deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([TOKEN_ITEM]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('installation-tokens deploy: a failed token listing fails the deploy instead of creating a duplicate', async () => {
  // `findTokenByLabel` could not read the tenant. Treating that as "no such
  // token" would mint a SECOND enrolment secret under the same label.
  const { calls, restore } = routeFetch([{ url: QUERIES, respond: { status: 500, body: {} } }])
  try {
    const result = await deploy(deployContext([TOKEN_ITEM]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list installation tokens/)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an unreadable tenant must not be written to')
  } finally {
    restore()
  }
})

test('installation-tokens deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a token it never created as deployed.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('installation token limit reached') },
  ])
  try {
    const result = await deploy(deployContext([TOKEN_ITEM]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /token limit reached/)
  } finally {
    restore()
  }
})

test('installation-tokens deploy: treats a 200 errors[] on the UPDATE path as a failure too', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['tok-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_TOKEN]) },
    { url: ENTITY, method: 'PATCH', respond: partialFailure('token is managed elsewhere') },
  ])
  try {
    const result = await deploy(deployContext([TOKEN_ITEM]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /managed elsewhere/)
  } finally {
    restore()
  }
})

test('installation-tokens deploy: keeps the rollback record of what it wrote when a later token fails', async () => {
  // The first token is created, the second is rejected. Everything the deploy
  // already changed must still come back on the failure path — a `catch` that
  // returns only `{ success: false, message }` discards it.
  const SECOND = item('Server rollout', { label: 'server-rollout', expiresTimestamp: '', revoked: false })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [
        created({ id: 'tok-new-1', value: TOKEN_VALUE }),
        forbidden('access denied, authorization failed'),
      ],
    },
  ])
  try {
    const result = await deploy(deployContext([TOKEN_ITEM, SECOND]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /after 1 of 2/)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the token that WAS created must still be recorded')
    assert.equal(state[0].id, 'tok-new-1')
  } finally {
    restore()
  }
})

test('installation-tokens deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createEntity` throws here AFTER the POST
  // succeeded, and `rollbackState.push` only runs on the line below it — so a
  // usable enrolment token now exists in the tenant with nothing recorded to
  // delete it. What is asserted is only the half that is certainly right: the
  // deploy does not claim success. The missing rollback record is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([TOKEN_ITEM]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the token was in fact minted')
  } finally {
    restore()
  }
})

test('installation-tokens deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
