// deploy for cloud-registry-connections.
//
// The shared contract covers the pre-flight refusals every config type has.
// Three things are specific to this config type and drive everything below:
//
//   * The collection has NO name filter, so deploy loads the WHOLE registry list
//     once (queries → entities) and matches by `user_defined_alias` client-side.
//   * The update is `PATCH …?id=<id>` — the id rides in the query string, not in
//     the body, so a lost id silently becomes a create.
//   * A registry connection carries a SECRET (the registry username/password or
//     token). It must reach the request body and NOTHING else: not the result
//     message, not the artifacts, not the rollback state.

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
  partialFailure,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/container-security\/queries\/registries\/v1/
const ENTITY = /\/container-security\/entities\/registries\/v1/

/**
 * The registry credential. The shared fake models only the Falcon token and API
 * client secret, so `leaksSecret` does not cover this one — this local marker
 * and helper stand in for it rather than changing the shared harness.
 */
const REGISTRY_SECRET = 'registry-password-MUST-NOT-LEAK'

function leaksRegistrySecret(value: unknown): boolean {
  return (JSON.stringify(value ?? null) ?? '').includes(REGISTRY_SECRET)
}

/**
 * One declared registry connection. `extractRegistrySpecs` reads a FLAT `fields`
 * record — `name`, `url`, `type`, `username`, `credential`, `scanInterval`,
 * `enabled`.
 */
const REGISTRY = item('Production Harbor', {
  name: 'prod-harbor',
  url: 'harbor.acme.internal',
  type: 'harbor',
  username: 'veltrix-scanner',
  credential: REGISTRY_SECRET,
  scanInterval: 24,
  enabled: true,
})

/** A second registry, used where a partial failure needs two objects. */
const SECOND_REGISTRY = item('Lab registry', {
  name: 'lab-quay',
  url: 'quay.lab.acme.internal',
  type: 'quay',
  credential: REGISTRY_SECRET,
})

/**
 * The registry as it exists in the tenant BEFORE this deploy — deliberately
 * different in every managed non-secret field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_REGISTRY = {
  id: 'reg-live-1',
  user_defined_alias: 'prod-harbor',
  url: 'harbor-old.acme.internal',
  url_uniqueness_key: 'prod-harbor-legacy',
  type: 'artifactory',
  state: 'paused',
  scan_interval: 168,
  modified_by: 'alice@acme.com',
  modified_timestamp: '2026-01-04T10:00:00Z',
}

registerDeployGuardContract({
  label: 'cloud-registry-connections',
  handler: deploy,
  items: [REGISTRY],
})

test('cloud-registry-connections deploy: creates a registry that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'reg-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([REGISTRY]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.equal(body?.user_defined_alias, 'prod-harbor')
    assert.equal(body?.url, 'harbor.acme.internal')
    assert.equal(body?.url_uniqueness_key, 'prod-harbor')
    assert.equal(body?.type, 'harbor')
    assert.equal(body?.state, 'active')
    assert.equal(body?.scan_interval, 24)

    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      'a registry that did not exist must not be patched',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('cloud-registry-connections deploy: sends the registry credential to the vendor and nowhere else', async () => {
  // The secret has exactly one legitimate destination: the create body. A
  // deploy result is persisted by the platform and shown to operators.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'reg-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([REGISTRY]))

    const body = bodyOf(callsOfMethod(calls, 'POST')[0])
    assert.deepEqual(body?.credential, {
      details: { username: 'veltrix-scanner', password: REGISTRY_SECRET },
    })

    assert.equal(result.success, true)
    assert.equal(
      leaksRegistrySecret(result),
      false,
      'the registry credential reached the result message, artifacts or rollbackData',
    )
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('cloud-registry-connections deploy: omits the credential entirely when none is declared', async () => {
  // An update that sent an empty credential block would wipe the secret the
  // registry is already authenticating with and silently stop every scan.
  const noSecret = item('Public mirror', {
    name: 'public-mirror',
    url: 'mirror.acme.internal',
    type: 'mirror',
  })
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'reg-new-9' }) },
  ])
  try {
    await deploy(deployContext([noSecret]))

    const body = bodyOf(callsOfMethod(calls, 'POST')[0]) ?? {}
    assert.equal('credential' in body, false)
  } finally {
    restore()
  }
})

test('cloud-registry-connections deploy: records the created registry so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'reg-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([REGISTRY]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'prod-harbor')
    assert.equal(state[0].existed, false, 'a registry this deploy created is not pre-existing')
    assert.equal(state[0].id, 'reg-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('cloud-registry-connections deploy: updates a registry that already exists, addressing it by id', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['reg-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_REGISTRY]) },
    { url: ENTITY, method: 'PATCH', respond: created({ id: 'reg-live-1' }) },
  ])
  try {
    const result = await deploy(deployContext([REGISTRY]))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'POST').length,
      0,
      'an existing registry must not be created again',
    )

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /id=reg-live-1/, 'the update must address the live registry by id')
    const body = bodyOf(patches[0])
    assert.equal(body?.url, 'harbor.acme.internal')
    assert.equal(body?.type, 'harbor')
    assert.equal(body?.state, 'active')
  } finally {
    restore()
  }
})

test('cloud-registry-connections deploy: records the LIVE prior values, and never the credential', async () => {
  // The canvas asks for an active Harbor at a new URL on a 24-hour cycle; the
  // tenant holds a paused Artifactory at the old URL on a weekly cycle. The
  // credential is write-only, so it must be absent from the record entirely —
  // a rollback that restored a stale secret would break authentication.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['reg-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_REGISTRY]) },
    { url: ENTITY, method: 'PATCH', respond: created({ id: 'reg-live-1' }) },
  ])
  try {
    const result = await deploy(deployContext([REGISTRY]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{
          name: string
          existed: boolean
          id?: string
          prior?: Record<string, unknown>
        }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'reg-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.url, 'harbor-old.acme.internal')
    assert.equal(prior.type, 'artifactory')
    assert.equal(prior.url_uniqueness_key, 'prod-harbor-legacy')
    assert.equal(prior.user_defined_alias, 'prod-harbor')
    assert.equal(prior.state, 'paused')
    assert.equal(prior.scan_interval, 168)
    assert.equal('credential' in prior, false, 'rollback state must not carry a registry credential')
    assert.equal(leaksRegistrySecret(result), false)
  } finally {
    restore()
  }
})

test('cloud-registry-connections deploy: matches an existing registry by alias, case-insensitively', async () => {
  // Falcon preserves the alias as typed. A case difference must not create a
  // second connection scanning the same registry twice.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['reg-live-1']) },
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ ...LIVE_REGISTRY, user_defined_alias: 'PROD-HARBOR' }]),
    },
    { url: ENTITY, method: 'PATCH', respond: created({ id: 'reg-live-1' }) },
  ])
  try {
    await deploy(deployContext([REGISTRY]))

    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'a duplicate registry must not be created')
    assert.equal(callsOfMethod(calls, 'PATCH').length, 1)
  } finally {
    restore()
  }
})

test('cloud-registry-connections deploy: refuses to write when the registry list cannot be read', async () => {
  // A 500 on the listing is "I could not tell", not "there are none". Creating
  // on that basis would duplicate every registry the tenant already has.
  const { calls, restore } = routeFetch(
    [{ url: /oauth2\/token/, respond: TOKEN }],
    serverError('internal server error'),
  )
  try {
    const result = await deploy(deployContext([REGISTRY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /internal server error/)
    assert.equal(writeCalls(calls).length, 0, `deploy wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-registry-connections deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([REGISTRY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(
      leaksRegistrySecret(result),
      false,
      'a failure message must not echo the registry credential',
    )
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('cloud-registry-connections deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a registry it never connected as deployed, and the
  // images in it are never scanned.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('registry credentials rejected') },
  ])
  try {
    const result = await deploy(deployContext([REGISTRY]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /credentials rejected/)
    assert.equal(leaksRegistrySecret(result), false)
  } finally {
    restore()
  }
})

test('cloud-registry-connections deploy: treats a 200 errors[] on the UPDATE path as a failure too', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['reg-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_REGISTRY]) },
    { url: ENTITY, method: 'PATCH', respond: partialFailure('registry is managed by the console') },
  ])
  try {
    const result = await deploy(deployContext([REGISTRY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /managed by the console/)
  } finally {
    restore()
  }
})

test('cloud-registry-connections deploy: keeps the rollback record of what it wrote when a later registry fails', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'reg-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([REGISTRY, SECOND_REGISTRY]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the registry that WAS created must still be recorded')
    assert.equal(state[0].name, 'prod-harbor')
    assert.equal(state[0].id, 'reg-new-1')
    assert.equal(leaksRegistrySecret(result), false)
  } finally {
    restore()
  }
})

test('cloud-registry-connections deploy: records a create that returned no id BEFORE reporting it failed', async () => {
  // The registry exists in the tenant either way. This handler pushes the
  // rollback entry first and only then throws, which is what lets an operator
  // undo a connection the API acknowledged but did not identify.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([REGISTRY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /no registry id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the registry was in fact created')

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'a registry was created with nothing recorded about it')
    assert.equal(state[0].name, 'prod-harbor')
    assert.equal(state[0].existed, false)
  } finally {
    restore()
  }
})

test('cloud-registry-connections deploy: an empty canvas writes nothing', async () => {
  const { calls, restore } = routeFetch([{ url: QUERIES, respond: EMPTY }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `deploy wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})
