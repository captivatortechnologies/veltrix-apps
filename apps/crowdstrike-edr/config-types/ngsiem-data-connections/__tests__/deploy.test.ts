// deploy for ngsiem-data-connections.
//
// The shared contract covers the pre-flight refusals every config type has. What
// is specific here is a connection that carries a CLOUD CREDENTIAL: the upstream
// secret has to reach the request body and nowhere else — not the result
// message, not the artifacts, and above all not rollbackData, which the platform
// persists. The other specifics are the create-only `connector_type` and the
// separate, deliberately non-fatal enable/disable endpoint.
//
// Read `../../../lib/__tests__/fakeFalcon.ts` first — its header explains the
// module-scope token cache and the 401 FalconClient silently retries. The
// upstream-secret leak check below is LOCAL to this file: the shared
// `leaksSecret` only knows the Falcon token and API client secret, and this
// config type has a third secret of its own.

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
  item,
  leaksSecret,
  ok,
  partialFailure,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const COLLECTION = /\/ngsiem\/combined\/connections\/v1/
const STATUS = /\/ngsiem\/entities\/connections\/status\/v1/
const ENTITY = /\/ngsiem\/entities\/connections\/v1/

/**
 * The customer's upstream cloud credential. Distinctive on purpose: anything
 * carrying this string outside a request body has leaked it.
 */
const UPSTREAM_SECRET = 'aws-upstream-access-key-MUST-NOT-LEAK'

/** Local counterpart of the shared `leaksSecret`, for this type's own secret. */
function leaksUpstreamSecret(value: unknown): boolean {
  return (JSON.stringify(value ?? null) ?? '').includes(UPSTREAM_SECRET)
}

/**
 * One declared data connection. `extractConnectionSpecs` reads a FLAT `fields`
 * record off each canvas item — `name`, `connectorType`, `sourceEndpoint`,
 * `credential`, `targetRepository`, `parser`, `enabled`.
 */
const CONNECTION = item('CloudTrail ingest', {
  name: 'acme-cloudtrail',
  connectorType: 'aws-s3',
  sourceEndpoint: 's3://acme-cloudtrail-logs',
  credential: UPSTREAM_SECRET,
  targetRepository: 'acme-security-events',
  parser: 'aws-cloudtrail',
  enabled: true,
})

/**
 * The connection as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_CONNECTION = {
  id: 'conn-live-1',
  name: 'acme-cloudtrail',
  connector_type: 'aws-s3',
  parser: 'legacy-parser',
  description: 'legacy description nobody updated',
  status: 'disabled',
  config: { endpoint: 's3://old-bucket', repository: 'legacy-repository' },
  modified_by: 'alice@acme.com',
}

registerDeployGuardContract({
  label: 'ngsiem-data-connections',
  handler: deploy,
  items: [CONNECTION],
})

test('ngsiem-data-connections deploy: creates a connection that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: COLLECTION, respond: EMPTY },
    { url: STATUS, method: 'PATCH', respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'conn-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([CONNECTION]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.ok(body, 'the create carried no JSON body')
    assert.equal(body.name, 'acme-cloudtrail')
    assert.equal(body.connector_type, 'aws-s3', 'connector_type is accepted only on create')
    assert.equal(body.parser, 'aws-cloudtrail')

    const config = body.config as Record<string, unknown>
    assert.equal(config.endpoint, 's3://acme-cloudtrail-logs')
    assert.equal(config.repository, 'acme-security-events')
    assert.equal(config.credential, UPSTREAM_SECRET, 'the upstream secret belongs in the request body')

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ngsiem-data-connections deploy: records the created connection so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: COLLECTION, respond: EMPTY },
    { url: STATUS, method: 'PATCH', respond: ok() },
    { url: ENTITY, method: 'POST', respond: created({ id: 'conn-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([CONNECTION]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'acme-cloudtrail')
    assert.equal(state[0].existed, false)
    assert.equal(state[0].id, 'conn-new-1')
  } finally {
    restore()
  }
})

test('ngsiem-data-connections deploy: updates an existing connection and never re-sends connector_type', async () => {
  // connector_type is immutable; sending it on update would fail every update of
  // a connection that is otherwise fine.
  const { calls, restore } = routeFetch([
    { url: COLLECTION, respond: entityPage([LIVE_CONNECTION]) },
    { url: STATUS, method: 'PATCH', respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([CONNECTION]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing connection must not be created again')

    const patches = callsOfMethod(calls, 'PATCH').filter((c) => !STATUS.test(c.url))
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /ids=conn-live-1/, 'the update must address the live connection by its id')

    const body = bodyOf(patches[0])
    assert.ok(body, 'the update carried no JSON body')
    assert.equal(body.connector_type, undefined, 'connector_type is create-only')
    assert.equal((body.config as Record<string, unknown>).repository, 'acme-security-events')
  } finally {
    restore()
  }
})

test('ngsiem-data-connections deploy: records the LIVE prior values, and NEVER the credential', async () => {
  // rollbackData is persisted by the platform. The upstream secret is
  // write-only: it is never read back, so it must never appear here.
  const { restore } = routeFetch([
    { url: COLLECTION, respond: entityPage([LIVE_CONNECTION]) },
    { url: STATUS, method: 'PATCH', respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([CONNECTION]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{ existed: boolean; id?: string; prior?: Record<string, unknown> }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'conn-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.parser, 'legacy-parser')
    assert.equal(prior.repository, 'legacy-repository')
    assert.equal(prior.endpoint, 's3://old-bucket')
    assert.equal(prior.status, 'disabled')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(
      Object.prototype.hasOwnProperty.call(prior, 'credential'),
      false,
      'the upstream credential must never be recorded in rollback state',
    )
  } finally {
    restore()
  }
})

test('ngsiem-data-connections deploy: converges enable/disable through the status endpoint', async () => {
  const disabled = item('CloudTrail ingest', {
    ...(CONNECTION.fields as Record<string, unknown>),
    enabled: false,
  })
  const { calls, restore } = routeFetch([
    { url: COLLECTION, respond: entityPage([LIVE_CONNECTION]) },
    { url: STATUS, method: 'PATCH', respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    await deploy(deployContext([disabled]))

    const statusCalls = calls.filter((c) => STATUS.test(c.url))
    assert.equal(statusCalls.length, 1, `expected one status call, got ${describeCalls(statusCalls)}`)
    assert.match(statusCalls[0].url, /ids=conn-live-1/)
    assert.equal(bodyOf(statusCalls[0])?.status, 'disabled')
  } finally {
    restore()
  }
})

test('ngsiem-data-connections deploy: reports a failed enable/disable without failing the connection', async () => {
  // The status enum is unverified, so a rejection there is surfaced as a note
  // rather than discarding a connection that was in fact written.
  const { restore } = routeFetch([
    { url: COLLECTION, respond: entityPage([LIVE_CONNECTION]) },
    { url: STATUS, method: 'PATCH', respond: forbidden('access denied, authorization failed') },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([CONNECTION]))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Enable\/disable could not be applied/)
    assert.match(String(result.message), /acme-cloudtrail/)
  } finally {
    restore()
  }
})

test('ngsiem-data-connections deploy: omits the credential from an update that declares none', async () => {
  // An update with a blank credential field must not send `config.credential` —
  // sending an empty one would wipe the working upstream secret.
  const noSecret = item('CloudTrail ingest', {
    ...(CONNECTION.fields as Record<string, unknown>),
    credential: '   ',
  })
  const { calls, restore } = routeFetch([
    { url: COLLECTION, respond: entityPage([LIVE_CONNECTION]) },
    { url: STATUS, method: 'PATCH', respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    await deploy(deployContext([noSecret]))

    const patch = callsOfMethod(calls, 'PATCH').filter((c) => !STATUS.test(c.url))[0]
    const config = bodyOf(patch)?.config as Record<string, unknown>
    assert.equal(
      Object.prototype.hasOwnProperty.call(config, 'credential'),
      false,
      'a blank credential must leave the existing upstream secret alone',
    )
  } finally {
    restore()
  }
})

test('ngsiem-data-connections deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: COLLECTION, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([CONNECTION]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
    assert.equal(leaksUpstreamSecret(result), false, 'a failure message must not echo the credential')
  } finally {
    restore()
  }
})

test('ngsiem-data-connections deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a forwarder it never created as ingesting.
  const { restore } = routeFetch([
    { url: COLLECTION, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('connector quota exceeded') },
  ])
  try {
    const result = await deploy(deployContext([CONNECTION]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /quota exceeded/)
  } finally {
    restore()
  }
})

test('ngsiem-data-connections deploy: a create that returns no id keeps its rollback record, and fails', async () => {
  // Unlike its siblings, this handler pushes the rollback entry BEFORE it
  // checks the id, so the connection that now exists is at least recorded.
  // DEFECT (reported, not blessed): the entry it keeps has no id, and rollback's
  // created-branch only acts on `entry.id` — so the orphan can never be removed.
  // That half is NOT asserted here.
  const { calls, restore } = routeFetch([
    { url: COLLECTION, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([CONNECTION]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no connection id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the connection was in fact created')
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the connection exists in the tenant and nothing was recorded')
    assert.equal(state[0].name, 'acme-cloudtrail')
  } finally {
    restore()
  }
})

test('ngsiem-data-connections deploy: never puts any secret in its result', async () => {
  const { restore } = routeFetch([
    { url: COLLECTION, respond: entityPage([LIVE_CONNECTION]) },
    { url: STATUS, method: 'PATCH', respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([CONNECTION]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a Falcon secret')
    assert.equal(
      leaksUpstreamSecret(result),
      false,
      'message, artifacts or rollbackData carried the upstream cloud credential',
    )
  } finally {
    restore()
  }
})

test('ngsiem-data-connections deploy: writes nothing for an empty canvas', async () => {
  // This handler lists the tenant's connections once up front, so an empty
  // canvas still reads — but it must change nothing.
  const { calls, restore } = routeFetch([{ url: COLLECTION, respond: EMPTY }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `deploy wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('ngsiem-data-connections deploy: skips a section missing a connector type or repository', async () => {
  // Either one missing makes the connection undeployable; writing a partial one
  // would create a forwarder that ingests nowhere.
  const INCOMPLETE = item('Draft', { name: 'draft-connection', connectorType: 'aws-s3' })
  const { calls, restore } = routeFetch([{ url: COLLECTION, respond: EMPTY }])
  try {
    const result = await deploy(deployContext([INCOMPLETE]))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})
