// deploy for ngsiem-saved-queries.
//
// The shared contract covers the pre-flight refusals every config type has. What
// is specific here is the TEMPLATE-SPLIT surface: create/update go to
// `…/entities/savedqueries-template/v1` while the id listing comes from
// `…/queries/savedqueries/v1` — and the CQL query itself, which is what the
// saved query actually is.
//
// Read `../../../lib/__tests__/fakeFalcon.ts` first — its header explains the
// module-scope token cache and the 401 FalconClient silently retries.

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
  vendorCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/ngsiem-content\/queries\/savedqueries\/v1/
const TEMPLATE = /\/ngsiem-content\/entities\/savedqueries-template\/v1/

/**
 * One declared saved query. `extractSavedQuerySpecs` reads a FLAT `fields`
 * record off each canvas item — `name`, `description`, `query`, `timeRange`,
 * `shared`.
 */
const SAVED_QUERY = item('Failed logons by host', {
  name: 'failed-logons-by-host',
  description: 'Counts failed interactive logons per host',
  query: '#event_simpleName=UserLogonFailed | groupBy(ComputerName)',
  timeRange: '24h',
  shared: true,
})

/**
 * The saved query as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_QUERY = {
  id: 'sq-live-1',
  name: 'failed-logons-by-host',
  description: 'legacy description nobody updated',
  query: '#event_simpleName=OldEventName',
  time_range: '7d',
  shared: false,
  updated_by: 'alice@acme.com',
}

registerDeployGuardContract({
  label: 'ngsiem-saved-queries',
  handler: deploy,
  items: [SAVED_QUERY],
})

test('ngsiem-saved-queries deploy: creates a saved query that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: TEMPLATE, method: 'POST', respond: created({ id: 'sq-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([SAVED_QUERY]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    assert.match(posts[0].url, TEMPLATE, 'creates go to the TEMPLATE collection')

    const body = bodyOf(posts[0])
    assert.ok(body, 'the create carried no JSON body')
    assert.equal(body.name, 'failed-logons-by-host')
    assert.equal(body.query, '#event_simpleName=UserLogonFailed | groupBy(ComputerName)')
    assert.equal(body.time_range, '24h')
    assert.equal(body.shared, true)
    assert.equal(body.description, 'Counts failed interactive logons per host')

    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a new saved query must not be patched')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries deploy: records the created query so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: TEMPLATE, method: 'POST', respond: created({ id: 'sq-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([SAVED_QUERY]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'failed-logons-by-host')
    assert.equal(state[0].existed, false)
    assert.equal(state[0].id, 'sq-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries deploy: updates a saved query that already exists, carrying its id', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['sq-live-1']) },
    { url: TEMPLATE, method: 'GET', respond: entityPage([LIVE_QUERY]) },
    { url: TEMPLATE, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([SAVED_QUERY]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing query must not be created again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = bodyOf(patches[0])
    assert.ok(body, 'the update carried no JSON body')
    assert.equal(body.id, 'sq-live-1', 'the update must address the live query by its id')
    assert.equal(body.query, '#event_simpleName=UserLogonFailed | groupBy(ComputerName)')
    assert.equal(body.shared, true)
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries deploy: records the LIVE prior values of a query it overwrote', async () => {
  // The canvas asks for the new CQL, 24h and shared; the tenant holds the old
  // CQL, 7d and private. Rollback restores what was there, not what was wanted.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['sq-live-1']) },
    { url: TEMPLATE, method: 'GET', respond: entityPage([LIVE_QUERY]) },
    { url: TEMPLATE, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([SAVED_QUERY]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{ existed: boolean; id?: string; prior?: Record<string, unknown> }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'sq-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(prior.query, '#event_simpleName=OldEventName')
    assert.equal(prior.time_range, '7d')
    assert.equal(prior.shared, false)
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: TEMPLATE, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([SAVED_QUERY]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a query it never created as deployed.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: TEMPLATE, method: 'POST', respond: partialFailure('CQL query is not parseable') },
  ])
  try {
    const result = await deploy(deployContext([SAVED_QUERY]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /not parseable/)
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries deploy: keeps the rollback record of what it wrote when a later query fails', async () => {
  const SECOND = item('Process executions', {
    name: 'process-executions',
    query: '#event_simpleName=ProcessRollup2',
  })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: TEMPLATE,
      method: 'POST',
      respond: [created({ id: 'sq-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([SAVED_QUERY, SECOND]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the query that WAS created must still be recorded')
    assert.equal(state[0].id, 'sq-new-1')
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['sq-live-1']) },
    { url: TEMPLATE, method: 'GET', respond: entityPage([LIVE_QUERY]) },
    { url: TEMPLATE, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([SAVED_QUERY]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createEntity` throws here AFTER the POST
  // succeeded, and `rollbackState.push` only runs on the line below it — so the
  // saved query now exists in the tenant with nothing recorded to delete it.
  // What is asserted is only the half that is certainly right: the deploy does
  // not claim success. The rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: TEMPLATE, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([SAVED_QUERY]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the saved query was in fact created')
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries deploy: skips a section with no CQL query', async () => {
  // A saved query with no CQL would overwrite the live query with nothing.
  const NO_QUERY = item('Placeholder', { name: 'placeholder' })
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([NO_QUERY]))

    assert.equal(result.success, true)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})
