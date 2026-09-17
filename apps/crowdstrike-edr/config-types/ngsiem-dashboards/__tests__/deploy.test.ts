// deploy for ngsiem-dashboards.
//
// The shared contract covers the pre-flight refusals every config type has. What
// is specific here is the TEMPLATE-SPLIT surface: create/update go to
// `…/entities/dashboards-template/v1` while the id listing comes from
// `…/queries/dashboards/v1`, and the widget/layout definition is sent as a
// parsed JSON object rather than the raw canvas text.
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

const QUERIES = /\/ngsiem-content\/queries\/dashboards\/v1/
const TEMPLATE = /\/ngsiem-content\/entities\/dashboards-template\/v1/

const DEFINITION = '{"widgets":[{"title":"Failed logons","query":"#event_simpleName=UserLogonFailed"}],"layout":{"columns":2}}'

/**
 * One declared dashboard. `extractDashboardSpecs` reads a FLAT `fields` record
 * off each canvas item — `name`, `description`, `definition` (raw JSON text),
 * `shared`.
 */
const DASHBOARD = item('Authentication overview', {
  name: 'authentication-overview',
  description: 'Failed logon activity across the estate',
  definition: DEFINITION,
  shared: true,
})

/**
 * The dashboard as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_DASHBOARD = {
  id: 'dash-live-1',
  name: 'authentication-overview',
  description: 'legacy description nobody updated',
  definition: { widgets: [{ title: 'Old widget', query: '#event_simpleName=OldEvent' }] },
  shared: false,
  updated_by: 'alice@acme.com',
}

registerDeployGuardContract({ label: 'ngsiem-dashboards', handler: deploy, items: [DASHBOARD] })

test('ngsiem-dashboards deploy: creates a dashboard that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: TEMPLATE, method: 'POST', respond: created({ id: 'dash-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([DASHBOARD]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    assert.match(posts[0].url, TEMPLATE, 'creates go to the TEMPLATE collection')

    const body = bodyOf(posts[0])
    assert.ok(body, 'the create carried no JSON body')
    assert.equal(body.name, 'authentication-overview')
    assert.equal(body.description, 'Failed logon activity across the estate')
    assert.equal(body.shared, true)
    // The definition is parsed to an object, not forwarded as raw canvas text.
    assert.deepEqual(body.definition, JSON.parse(DEFINITION))

    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a new dashboard must not be patched')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ngsiem-dashboards deploy: records the created dashboard so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: TEMPLATE, method: 'POST', respond: created({ id: 'dash-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([DASHBOARD]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'authentication-overview')
    assert.equal(state[0].existed, false)
    assert.equal(state[0].id, 'dash-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('ngsiem-dashboards deploy: updates a dashboard that already exists, carrying its id', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['dash-live-1']) },
    { url: TEMPLATE, method: 'GET', respond: entityPage([LIVE_DASHBOARD]) },
    { url: TEMPLATE, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([DASHBOARD]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing dashboard must not be created again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = bodyOf(patches[0])
    assert.ok(body, 'the update carried no JSON body')
    assert.equal(body.id, 'dash-live-1', 'the update must address the live dashboard by its id')
    assert.deepEqual(body.definition, JSON.parse(DEFINITION))
    assert.equal(body.shared, true)
  } finally {
    restore()
  }
})

test('ngsiem-dashboards deploy: records the LIVE prior values of a dashboard it overwrote', async () => {
  // The canvas asks for the new widget set, shared and described; the tenant
  // holds the old widget set, private and stale. Rollback restores what was
  // there, so every one of these must come from LIVE_DASHBOARD.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['dash-live-1']) },
    { url: TEMPLATE, method: 'GET', respond: entityPage([LIVE_DASHBOARD]) },
    { url: TEMPLATE, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([DASHBOARD]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{ existed: boolean; id?: string; prior?: Record<string, unknown> }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'dash-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(prior.shared, false)
    assert.deepEqual(prior.definition, LIVE_DASHBOARD.definition)
  } finally {
    restore()
  }
})

test('ngsiem-dashboards deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: TEMPLATE, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([DASHBOARD]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('ngsiem-dashboards deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a dashboard it never created as deployed.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: TEMPLATE, method: 'POST', respond: partialFailure('dashboard definition rejected') },
  ])
  try {
    const result = await deploy(deployContext([DASHBOARD]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /definition rejected/)
  } finally {
    restore()
  }
})

test('ngsiem-dashboards deploy: keeps the rollback record of what it wrote when a later dashboard fails', async () => {
  // The first dashboard is created, the second is rejected. Everything the
  // deploy already changed must still come back on the failure path.
  const SECOND = item('Detection overview', {
    name: 'detection-overview',
    definition: '{"widgets":[]}',
  })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: TEMPLATE,
      method: 'POST',
      respond: [created({ id: 'dash-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([DASHBOARD, SECOND]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the dashboard that WAS created must still be recorded')
    assert.equal(state[0].id, 'dash-new-1')
  } finally {
    restore()
  }
})

test('ngsiem-dashboards deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['dash-live-1']) },
    { url: TEMPLATE, method: 'GET', respond: entityPage([LIVE_DASHBOARD]) },
    { url: TEMPLATE, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([DASHBOARD]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('ngsiem-dashboards deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createEntity` throws here AFTER the POST
  // succeeded, and `rollbackState.push` only runs on the line below it — so the
  // dashboard now exists in the tenant with nothing recorded to delete it. What
  // is asserted is only the half that is certainly right: the deploy does not
  // claim success. The rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: TEMPLATE, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([DASHBOARD]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the dashboard was in fact created')
  } finally {
    restore()
  }
})

test('ngsiem-dashboards deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})

test('ngsiem-dashboards deploy: skips a section with no definition', async () => {
  // A dashboard with no widget/layout definition would be written as an empty
  // object, replacing whatever the console holds.
  const EMPTY_DEFINITION = item('Placeholder', { name: 'placeholder' })
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([EMPTY_DEFINITION]))

    assert.equal(result.success, true)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})
