// deploy for custom-iocs.
//
// An indicator's `action` is the whole point of it: `prevent` blocks the file,
// `detect` only alerts, `no_action` does nothing at all. `severity` decides
// whether anyone looks. So the assertions that matter are that the update path
// writes the declared action rather than leaving a weaker live one, that
// expiry/platform/targeting are not silently dropped when it does, and that the
// rollback record holds the LIVE prior action rather than the desired one.
//
// Read `lib/__tests__/fakeFalcon.ts` first — its header explains the
// module-scope token cache (why every context mints a fresh client secret) and
// the two-call lookup (`GET <queries>` answers with BARE ID STRINGS, then
// `GET <entity>?ids=…` answers with objects).

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
  type RecordedCall,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/iocs\/queries\/indicators\/v1/
const ENTITY = /\/iocs\/entities\/indicators\/v1/

const HASH = 'a3f1c0de4b2955ab7788c0d1e2f3a4b5c6d7e8f90112233445566778899aabbc'

/** Writes carry the managed fields inside an `indicators: [...]` array. */
function indicator(call: RecordedCall | undefined): Record<string, unknown> | undefined {
  const indicators = bodyOf(call)?.indicators
  return Array.isArray(indicators) ? (indicators[0] as Record<string, unknown>) : undefined
}

/**
 * One declared indicator. `extractIocSpecs` reads a FLAT `fields` record off
 * each canvas item — `type`, `value`, `action`, `severity`, `platforms`,
 * `appliedGlobally`, `hostGroups`, `expiration`, `description`, `tags`.
 */
const IOC = item('Loader hash from incident 4812', {
  type: 'sha256',
  value: HASH,
  action: 'prevent',
  severity: 'critical',
  platforms: 'windows, mac',
  appliedGlobally: true,
  expiration: '2026-12-31T00:00:00Z',
  description: 'Loader observed in incident 4812',
  tags: 'incident-4812, veltrix',
})

/**
 * The indicator as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_IOC = {
  id: 'ioc-live-1',
  type: 'sha256',
  value: HASH,
  action: 'no_action',
  severity: 'informational',
  platforms: ['linux'],
  applied_globally: false,
  host_groups: ['hg-legacy'],
  expiration: '2026-02-01T00:00:00Z',
  description: 'legacy note nobody updated',
  tags: ['retired'],
  modified_by: 'alice@acme.com',
  modified_on: '2026-01-04T10:00:00Z',
}

registerDeployGuardContract({ label: 'custom-iocs', handler: deploy, items: [IOC] })

test('custom-iocs deploy: creates an indicator that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ioc-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([IOC]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = indicator(posts[0])
    assert.equal(body?.type, 'sha256')
    assert.equal(body?.value, HASH)
    assert.equal(body?.action, 'prevent', 'the declared action is what decides whether the file is blocked')
    assert.equal(body?.severity, 'critical')
    assert.deepEqual(body?.platforms, ['windows', 'mac'])
    assert.equal(body?.applied_globally, true)
    assert.equal(body?.expiration, '2026-12-31T00:00:00Z')

    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a new indicator must not be patched')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('custom-iocs deploy: records the created indicator so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ioc-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([IOC]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].value, HASH)
    assert.equal(state[0].existed, false, 'an indicator this deploy created is not pre-existing')
    assert.equal(state[0].id, 'ioc-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('custom-iocs deploy: updates an existing indicator, carrying its id and the declared action', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['ioc-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_IOC]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([IOC]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing indicator must not be created again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = indicator(patches[0])
    assert.equal(body?.id, 'ioc-live-1', 'the update must address the live indicator by its id')
    assert.equal(body?.action, 'prevent', 'the live no_action must be raised to the declared prevent')
    assert.equal(body?.severity, 'critical')
  } finally {
    restore()
  }
})

test('custom-iocs deploy: does not drop expiry, platforms or targeting on the update path', async () => {
  // A PATCH that omits these leaves the live values in place — an indicator that
  // expires next month, or covers only Linux, while the canvas says otherwise.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['ioc-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_IOC]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    await deploy(deployContext([IOC]))

    const body = indicator(callsOfMethod(calls, 'PATCH')[0])
    assert.deepEqual(body?.platforms, ['windows', 'mac'])
    assert.equal(body?.applied_globally, true)
    assert.equal(body?.expiration, '2026-12-31T00:00:00Z')
    assert.equal(body?.description, 'Loader observed in incident 4812')
    assert.deepEqual(body?.tags, ['incident-4812', 'veltrix'])
  } finally {
    restore()
  }
})

test('custom-iocs deploy: sends host groups only for an indicator that is not applied globally', async () => {
  const TARGETED = item('Loader hash from incident 4812', {
    type: 'sha256',
    value: HASH,
    action: 'detect',
    severity: 'high',
    platforms: 'windows',
    appliedGlobally: false,
    hostGroups: 'hg-prod, hg-dmz',
  })
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ioc-new-1' }) },
  ])
  try {
    await deploy(deployContext([TARGETED]))

    const body = indicator(callsOfMethod(calls, 'POST')[0])
    assert.equal(body?.applied_globally, false)
    assert.deepEqual(body?.host_groups, ['hg-prod', 'hg-dmz'])
  } finally {
    restore()
  }
})

test('custom-iocs deploy: records the LIVE prior action and severity of an indicator it overwrote', async () => {
  // The canvas asks for prevent/critical; the tenant holds no_action/
  // informational. Rollback restores what was there, not what was wanted, so
  // every value here must come from LIVE_IOC.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['ioc-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_IOC]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([IOC]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{ existed: boolean; id?: string; prior?: Record<string, unknown> }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'ioc-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.action, 'no_action')
    assert.equal(prior.severity, 'informational')
    assert.deepEqual(prior.platforms, ['linux'])
    assert.equal(prior.applied_globally, false)
    assert.deepEqual(prior.host_groups, ['hg-legacy'])
    assert.equal(prior.expiration, '2026-02-01T00:00:00Z')
    assert.equal(prior.description, 'legacy note nobody updated')
    assert.deepEqual(prior.tags, ['retired'])
  } finally {
    restore()
  }
})

test('custom-iocs deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([IOC]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('custom-iocs deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports an indicator it never created as blocking malware.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('indicator quota exceeded') },
  ])
  try {
    const result = await deploy(deployContext([IOC]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /quota exceeded/)
  } finally {
    restore()
  }
})

test('custom-iocs deploy: treats a 200 errors[] on the UPDATE path as a failure too', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['ioc-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_IOC]) },
    { url: ENTITY, method: 'PATCH', respond: partialFailure('indicator is read-only') },
  ])
  try {
    const result = await deploy(deployContext([IOC]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('custom-iocs deploy: keeps the rollback record of what it wrote when a later indicator fails', async () => {
  // The first indicator is created, the second is rejected. Everything the
  // deploy already changed must still come back on the failure path — a `catch`
  // that returns only `{ success: false, message }` discards it.
  const SECOND = item('Second hash', {
    type: 'md5',
    value: 'b3f1c0de4b2955ab7788c0d1e2f3a4b5',
    action: 'detect',
    severity: 'high',
    platforms: 'windows',
  })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'ioc-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([IOC, SECOND]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the indicator that WAS created must still be recorded')
    assert.equal(state[0].id, 'ioc-new-1')
  } finally {
    restore()
  }
})

test('custom-iocs deploy: a create that returns no id is recorded before it is reported as failed', async () => {
  // The POST succeeded, so the indicator exists in the tenant. This handler
  // pushes the rollback entry BEFORE throwing on the missing id, which is the
  // correct order — what it CANNOT do is give rollback an id to delete by, so
  // the entry is recorded but not actionable. That gap is reported, not blessed.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([IOC]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /no indicator id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the indicator was in fact created')

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'an indicator that now exists in the tenant was not recorded at all')
    assert.equal(state[0].existed, false)
  } finally {
    restore()
  }
})

test('custom-iocs deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['ioc-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_IOC]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([IOC]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('custom-iocs deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
