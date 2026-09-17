// deploy for filevantage-scheduled-exclusions.
//
// A scheduled exclusion is a window in which FileVantage stops raising change
// events, so every managed field here is a period of deliberate blindness: the
// schedule bounds, the recurrence, and the process/user scope that decides whose
// changes are ignored inside it. Getting the update path wrong widens that
// window silently.
//
// This family's transport is also the odd one out: BOTH the query and the get
// endpoints require the parent `policy_id`, and the query takes no filter — it
// returns every exclusion id in the policy, and the name is pinned client-side.
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
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/filevantage\/queries\/policy-scheduled-exclusions\/v1/
const ENTITY = /\/filevantage\/entities\/policy-scheduled-exclusions\/v1/

const PROCESS = 'C:\\Windows\\System32\\wuauclt.exe'
const USER = 'NT AUTHORITY\\SYSTEM'

/**
 * One declared exclusion. `extractScheduledExclusionSpecs` reads a FLAT `fields`
 * record off each canvas item — `name`, `description`, `policyId`, `timezone`,
 * `scheduleStart`, `scheduleEnd`, `recurrence`, `allDay`, `startTime`,
 * `endTime`, `weeklyDays`, `monthlyDays`, `processes`, `users`.
 */
const EXCLUSION = item('Weekend patch window', {
  name: 'weekend-patch-window',
  description: 'Suppress FIM noise during patching',
  policyId: 'fvp-1',
  timezone: 'Etc/UTC',
  scheduleStart: '2026-01-01T02:00:00Z',
  scheduleEnd: '2026-12-31T04:00:00Z',
  recurrence: 'weekly',
  allDay: false,
  startTime: '02:00',
  endTime: '04:00',
  weeklyDays: 'saturday, sunday',
  processes: PROCESS,
  users: USER,
})

/**
 * The exclusion as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_EXCLUSION = {
  id: 'fvse-live-1',
  name: 'weekend-patch-window',
  policy_id: 'fvp-1',
  description: 'legacy note nobody updated',
  timezone: 'America/New_York',
  schedule_start: '2025-06-01T00:00:00Z',
  schedule_end: '2025-12-31T00:00:00Z',
  processes: 'C:\\Legacy\\old.exe',
  users: 'ACME\\legacy',
  repeated: { frequency: 'daily', all_day: true },
  modified_by: 'alice@acme.com',
  modified_timestamp: '2026-01-04T10:00:00Z',
}

registerDeployGuardContract({
  label: 'filevantage-scheduled-exclusions',
  handler: deploy,
  items: [EXCLUSION],
})

test('filevantage-scheduled-exclusions deploy: creates an exclusion that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'fvse-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([EXCLUSION]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')
    assert.equal(result.success, true)

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.equal(body?.name, 'weekend-patch-window')
    assert.equal(body?.policy_id, 'fvp-1', 'an exclusion is bound to its parent policy')
    assert.equal(body?.timezone, 'Etc/UTC')
    assert.equal(body?.schedule_start, '2026-01-01T02:00:00Z')
    assert.equal(body?.schedule_end, '2026-12-31T04:00:00Z')
    assert.equal(body?.processes, PROCESS, 'the scope decides whose changes stop being reported')
    assert.equal(body?.users, USER)

    const repeated = body?.repeated as Record<string, unknown>
    assert.equal(repeated?.frequency, 'weekly')
    assert.equal(repeated?.all_day, false)
    assert.equal(repeated?.start_time, '02:00')
    assert.equal(repeated?.end_time, '04:00')
    assert.deepEqual(repeated?.weekly_days, ['saturday', 'sunday'])
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions deploy: sends no recurrence for a one-time window', async () => {
  // "never" is a single window, not a frequency — sending a `repeated` object
  // would turn a one-off maintenance window into a standing blind spot.
  const ONE_TIME = item('Cutover window', {
    name: 'cutover-window',
    policyId: 'fvp-1',
    timezone: 'Etc/UTC',
    scheduleStart: '2026-03-01T22:00:00Z',
    scheduleEnd: '2026-03-02T02:00:00Z',
    recurrence: 'never',
    processes: PROCESS,
  })
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'fvse-new-2' }) },
  ])
  try {
    await deploy(deployContext([ONE_TIME]))

    const body = bodyOf(callsOfMethod(calls, 'POST')[0])
    assert.equal('repeated' in (body ?? {}), false, 'a one-time window carries no recurrence')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions deploy: records the created exclusion so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'fvse-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([EXCLUSION]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'weekend-patch-window')
    assert.equal(state[0].policyId, 'fvp-1', 'the policy is needed to delete the exclusion again')
    assert.equal(state[0].existed, false, 'an exclusion this deploy created is not pre-existing')
    assert.equal(state[0].id, 'fvse-new-1')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions deploy: updates an existing exclusion, carrying its id', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvse-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_EXCLUSION]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([EXCLUSION]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing exclusion must not be created again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'fvse-live-1', 'the update must address the live exclusion by its id')
    assert.equal(body?.timezone, 'Etc/UTC', 'the declared timezone replaces the live one')
    assert.equal(body?.schedule_start, '2026-01-01T02:00:00Z')
    assert.equal(body?.processes, PROCESS)
    assert.equal(body?.users, USER)
    assert.equal((body?.repeated as Record<string, unknown>)?.frequency, 'weekly')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions deploy: pins the exact name inside the policy it was given', async () => {
  // The query endpoint takes no filter and returns EVERY exclusion in the
  // policy. Adopting an arbitrary hit would rewrite somebody else's window.
  const other = { ...LIVE_EXCLUSION, id: 'fvse-other', name: 'nightly-backup-window' }
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvse-other']) },
    { url: ENTITY, method: 'GET', respond: entityPage([other]) },
    { url: ENTITY, method: 'POST', respond: created({ id: 'fvse-new-1' }) },
  ])
  try {
    await deploy(deployContext([EXCLUSION]))

    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      `a differently-named exclusion was overwritten: ${describeCalls(callsOfMethod(calls, 'PATCH'))}`,
    )
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the declared exclusion is created instead')
    const queryUrl = new URL(calls.find((c) => QUERIES.test(c.url))?.url ?? 'https://x/')
    assert.equal(queryUrl.searchParams.get('policy_id'), 'fvp-1', 'the lookup is scoped to the policy')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions deploy: records the LIVE prior window, scope and recurrence', async () => {
  // The canvas asks for a weekly Etc/UTC window scoped to wuauclt; the tenant
  // holds a daily America/New_York one scoped to a legacy binary. Rollback
  // restores what was there, so every value here must come from LIVE_EXCLUSION.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvse-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_EXCLUSION]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([EXCLUSION]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{ existed: boolean; id?: string; prior?: Record<string, unknown> }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'fvse-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.description, 'legacy note nobody updated')
    assert.equal(prior.timezone, 'America/New_York')
    assert.equal(prior.schedule_start, '2025-06-01T00:00:00Z')
    assert.equal(prior.schedule_end, '2025-12-31T00:00:00Z')
    assert.equal(prior.processes, 'C:\\Legacy\\old.exe')
    assert.equal(prior.users, 'ACME\\legacy')
    assert.deepEqual(prior.repeated, { frequency: 'daily', all_day: true })
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions deploy: skips an item with no policy id rather than guessing one', async () => {
  const ORPHAN = item('No policy', {
    name: 'orphan-window',
    timezone: 'Etc/UTC',
    scheduleStart: '2026-01-01T02:00:00Z',
    processes: PROCESS,
  })
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await deploy(deployContext([ORPHAN]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'an exclusion with no parent policy has nowhere to be written')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([EXCLUSION]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports an exclusion it never created as in place — and the
  // change events it was meant to suppress keep firing.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('scheduled exclusion quota exceeded') },
  ])
  try {
    const result = await deploy(deployContext([EXCLUSION]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /quota exceeded/)
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions deploy: treats a 200 errors[] on the UPDATE path as a failure too', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvse-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_EXCLUSION]) },
    { url: ENTITY, method: 'PATCH', respond: partialFailure('exclusion is read-only') },
  ])
  try {
    const result = await deploy(deployContext([EXCLUSION]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createFileVantage` throws here AFTER the
  // POST succeeded, and `rollbackState.push` is the statement below its call —
  // so the exclusion now exists in the tenant with nothing recorded to remove
  // it. What is asserted is only the half that is certainly right: the deploy
  // does not claim success. The rollback record it fails to keep is NOT
  // asserted. (Rollback does re-resolve created entries by name, so this one is
  // recoverable in practice — but only if the entry is recorded at all.)
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([EXCLUSION]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the exclusion was in fact created')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions deploy: keeps the rollback record of what it wrote when a later item fails', async () => {
  const SECOND = item('Nightly backup window', {
    name: 'nightly-backup-window',
    policyId: 'fvp-1',
    timezone: 'Etc/UTC',
    scheduleStart: '2026-01-01T01:00:00Z',
    recurrence: 'daily',
    processes: PROCESS,
  })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'fvse-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([EXCLUSION, SECOND]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the exclusion that WAS created must still be recorded')
    assert.equal(state[0].id, 'fvse-new-1')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['fvse-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_EXCLUSION]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([EXCLUSION]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
