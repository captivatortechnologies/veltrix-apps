// deploy for host-groups.
//
// A host group is the targeting primitive of the whole tenant: prevention
// policies, IOCs and FileVantage policies are all attached to one, so whatever
// its `assignment_rule` matches is what inherits that protection. The tests that
// matter here are therefore the update path (which silently overwrites a rule an
// operator wrote by hand) and the rollback state deploy records for it, which
// must be the LIVE prior rule and not the desired one.
//
// Read `lib/__tests__/fakeFalcon.ts` first — its header explains the
// module-scope token cache (why every context mints a fresh client secret) and
// the 401 that `FalconClient` silently retries.

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
  type RecordedCall,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const COMBINED = /\/devices\/combined\/host-groups\/v1/
const ENTITY = /\/devices\/entities\/host-groups\/v1/

/** The Host Group API wraps every write body in `resources: [...]`. */
function resource(call: RecordedCall | undefined): Record<string, unknown> | undefined {
  const resources = bodyOf(call)?.resources
  return Array.isArray(resources) ? (resources[0] as Record<string, unknown>) : undefined
}

/**
 * One declared host group. `extractHostGroupSpecs` reads a FLAT `fields` record
 * off each canvas item — `name`, `description`, `groupType`, `assignmentRule`.
 */
const GROUP = item('Production servers', {
  name: 'prod-servers',
  description: 'Tier 1 production estate',
  groupType: 'dynamic',
  assignmentRule: "platform_name:'Windows'+tags:'SensorGroupingTags/production'",
})

/**
 * The group as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_GROUP = {
  id: 'hg-live-1',
  name: 'prod-servers',
  description: 'legacy description nobody updated',
  group_type: 'dynamic',
  assignment_rule: "platform_name:'Linux'",
  modified_by: 'alice@acme.com',
  modified_timestamp: '2026-01-04T10:00:00Z',
}

registerDeployGuardContract({ label: 'host-groups', handler: deploy, items: [GROUP] })

test('host-groups deploy: creates a group that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'hg-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = resource(posts[0])
    assert.equal(body?.name, 'prod-servers')
    assert.equal(body?.group_type, 'dynamic')
    assert.equal(body?.description, 'Tier 1 production estate')
    assert.equal(body?.assignment_rule, "platform_name:'Windows'+tags:'SensorGroupingTags/production'")

    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a group that did not exist must not be patched')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('host-groups deploy: records the created group so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'hg-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'prod-servers')
    assert.equal(state[0].existed, false, 'a group this deploy created is not pre-existing')
    assert.equal(state[0].id, 'hg-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('host-groups deploy: updates a group that already exists, carrying its id', async () => {
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_GROUP]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing group must not be created again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = resource(patches[0])
    assert.equal(body?.id, 'hg-live-1', 'the update must address the live group by its id')
    assert.equal(body?.name, 'prod-servers')
    assert.equal(body?.description, 'Tier 1 production estate')
    assert.equal(
      body?.assignment_rule,
      "platform_name:'Windows'+tags:'SensorGroupingTags/production'",
      'the declared rule is what decides which hosts the group targets',
    )
  } finally {
    restore()
  }
})

test('host-groups deploy: records the LIVE prior assignment rule of a group it overwrote', async () => {
  // The canvas asks for a Windows+production rule; the tenant holds a Linux one.
  // Rollback restores what was there, not what was wanted — so every value here
  // must come from LIVE_GROUP.
  const { restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_GROUP]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

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
    assert.equal(state[0].id, 'hg-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.name, 'prod-servers')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(
      prior.assignment_rule,
      "platform_name:'Linux'",
      'the LIVE rule is the only thing that restores the tenant to its prior targeting',
    )
  } finally {
    restore()
  }
})

test('host-groups deploy: refuses to converge a group whose type differs, without writing', async () => {
  // group_type is immutable via the API. Patching a static group with a dynamic
  // group's rule would either fail loudly or silently retarget it, so the
  // deployment stops before touching the tenant.
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: entityPage([{ ...LIVE_GROUP, group_type: 'static' }]) },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /immutable/)
    assert.equal(writeCalls(calls).length, 0, `deploy wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('host-groups deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('host-groups deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a group it never created as deployed.
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('host group quota exceeded') },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /quota exceeded/)
  } finally {
    restore()
  }
})

test('host-groups deploy: treats a 200 errors[] on the UPDATE path as a failure too', async () => {
  const { restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_GROUP]) },
    { url: ENTITY, method: 'PATCH', respond: partialFailure('host group is read-only') },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('host-groups deploy: keeps the rollback record of what it wrote when a later group fails', async () => {
  // The first group is created, the second is rejected. Everything the deploy
  // already changed must still come back on the failure path — a `catch` that
  // returns only `{ success: false, message }` discards it.
  const SECOND = item('Staging servers', {
    name: 'stage-servers',
    groupType: 'dynamic',
    assignmentRule: "platform_name:'Windows'",
  })
  const { restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'hg-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([GROUP, SECOND]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the group that WAS created must still be recorded')
    assert.equal(state[0].name, 'prod-servers')
    assert.equal(state[0].id, 'hg-new-1')
  } finally {
    restore()
  }
})

test('host-groups deploy: a create that returns no id is recorded before it is reported as failed', async () => {
  // The POST succeeded, so the group exists in the tenant. This handler pushes
  // the rollback entry BEFORE throwing on the missing id, which is the correct
  // order — what it CANNOT do is give rollback an id to delete by, so the entry
  // is recorded but not actionable. That gap is reported, not asserted here.
  const { calls, restore } = routeFetch([
    { url: COMBINED, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /no group id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the group was in fact created')

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'a group that now exists in the tenant was not recorded at all')
    assert.equal(state[0].existed, false)
  } finally {
    restore()
  }
})

test('host-groups deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: COMBINED, respond: entityPage([LIVE_GROUP]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GROUP]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('host-groups deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})

test('host-groups deploy: never adopts an ambiguous name match as the group to overwrite', async () => {
  // The name filter matches case-insensitively. Two candidates differing only in
  // case are ambiguous, and patching the wrong one changes which hosts inherit
  // every policy that targets it — so the deploy creates instead of guessing.
  const { calls, restore } = routeFetch([
    {
      url: COMBINED,
      respond: entityPage([
        { ...LIVE_GROUP, id: 'hg-a', name: 'PROD-SERVERS' },
        { ...LIVE_GROUP, id: 'hg-b', name: 'Prod-Servers' },
      ]),
    },
    { url: ENTITY, method: 'POST', respond: created({ id: 'hg-new-1' }) },
  ])
  try {
    await deploy(deployContext([GROUP]))

    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      `an ambiguous match was patched: ${describeCalls(callsOfMethod(calls, 'PATCH'))}`,
    )
  } finally {
    restore()
  }
})
