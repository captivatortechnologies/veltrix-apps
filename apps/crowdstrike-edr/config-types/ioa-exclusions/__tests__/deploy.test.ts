// deploy for ioa-exclusions.
//
// The shared contract covers the pre-flight refusals every config type has. What
// is specific here is the create/update split and the fields that decide what an
// IOA exclusion actually suppresses: the pattern id plus the two regexes. Unlike
// ML and SV exclusions, an IOA exclusion is matched on its `name`, so the update
// path is reached by name and must carry the live object's id. Targeting works
// the same way — there is no `applied_globally` write field, so the sentinel
// ["all"] is the only thing that keeps the exclusion in force fleet-wide.

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

const QUERIES = /\/policy\/queries\/ioa-exclusions\/v1/
const ENTITY = /\/policy\/entities\/ioa-exclusions\/v1/

/**
 * One declared IOA exclusion, applied to every host. `extractIoaExclusionSpecs`
 * reads a FLAT `fields` record — `name`, `description`, `patternId`,
 * `patternName`, `clRegex`, `ifnRegex`, `appliedGlobally`, `hostGroups`,
 * `comment`.
 */
const GLOBAL_EXCLUSION = item('Deployment agent', {
  name: 'vendor-deployment-agent',
  description: 'Vendor deployment agent triggers the suspicious-install pattern',
  patternId: '10197',
  patternName: 'Suspicious Installer Behavior',
  clRegex: '.*deploy-agent\\.exe.*',
  ifnRegex: '.*\\\\Program Files\\\\Vendor\\\\.*',
  appliedGlobally: true,
  comment: 'Approved by the detection engineering team',
})

/** The same config type scoped to two host groups instead of the whole fleet. */
const SCOPED_EXCLUSION = item('Build fleet', {
  name: 'build-fleet-compiler',
  patternId: '10321',
  clRegex: '.*msbuild\\.exe.*',
  ifnRegex: '.*\\\\build\\\\.*',
  appliedGlobally: false,
  hostGroups: 'hg-build-1, hg-build-2',
})

/**
 * The exclusion as it exists in the tenant BEFORE this deploy — different from
 * the canvas in every managed field, so a rollback record that captured the
 * DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_EXCLUSION = {
  id: 'ioa-live-1',
  name: 'vendor-deployment-agent',
  description: 'legacy description nobody updated',
  pattern_id: '10004',
  pattern_name: 'Credential Dumping',
  cl_regex: '.*old-installer\\.exe.*',
  ifn_regex: '.*\\\\Temp\\\\.*',
  applied_globally: false,
  groups: [{ id: 'hg-legacy-1', name: 'Legacy servers' }],
  comment: 'added by hand during an incident',
  modified_by: 'alice@acme.com',
  last_modified: '2026-01-04T10:00:00Z',
}

registerDeployGuardContract({ label: 'ioa-exclusions', handler: deploy, items: [GLOBAL_EXCLUSION] })

test('ioa-exclusions deploy: creates an exclusion that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ioa-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(tenantCalls.length > 0, 'deploy made no vendor call')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.equal(body?.name, 'vendor-deployment-agent')
    assert.equal(body?.pattern_id, '10197')
    assert.equal(body?.pattern_name, 'Suspicious Installer Behavior')
    assert.equal(body?.cl_regex, '.*deploy-agent\\.exe.*')
    assert.equal(body?.ifn_regex, '.*\\\\Program Files\\\\Vendor\\\\.*')
    assert.equal(body?.description, 'Vendor deployment agent triggers the suspicious-install pattern')
    assert.equal(body?.comment, 'Approved by the detection engineering team')

    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      'an exclusion that did not exist must not be patched',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('ioa-exclusions deploy: omits an undeclared description and pattern name rather than blanking them', async () => {
  // `buildManagedFields` only sends the optional fields when the canvas declared
  // them, so a deploy of a minimal exclusion does not wipe metadata set in the
  // console.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ioa-new-2' }) },
  ])
  try {
    await deploy(deployContext([SCOPED_EXCLUSION]))

    const body = bodyOf(callsOfMethod(calls, 'POST')[0])
    assert.equal('description' in (body ?? {}), false)
    assert.equal('pattern_name' in (body ?? {}), false)
  } finally {
    restore()
  }
})

test('ioa-exclusions deploy: keeps a globally applied exclusion global', async () => {
  // There is no `applied_globally` write field — ["all"] is the only way to say
  // "every host". Sending a group list instead narrows the exclusion silently.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ioa-new-1' }) },
  ])
  try {
    await deploy(deployContext([GLOBAL_EXCLUSION]))

    const body = bodyOf(callsOfMethod(calls, 'POST')[0])
    assert.deepEqual(body?.groups, ['all'], 'a global exclusion must be written as ["all"]')
  } finally {
    restore()
  }
})

test('ioa-exclusions deploy: keeps a host-group scoped exclusion scoped', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ioa-new-2' }) },
  ])
  try {
    await deploy(deployContext([SCOPED_EXCLUSION]))

    const body = bodyOf(callsOfMethod(calls, 'POST')[0])
    assert.deepEqual(body?.groups, ['hg-build-1', 'hg-build-2'])
  } finally {
    restore()
  }
})

test('ioa-exclusions deploy: records the created exclusion so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'ioa-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'vendor-deployment-agent')
    assert.equal(state[0].existed, false, 'an exclusion this deploy created is not pre-existing')
    assert.equal(state[0].id, 'ioa-new-1', 'without the new id rollback cannot find what it created')
  } finally {
    restore()
  }
})

test('ioa-exclusions deploy: updates an exclusion that already exists, carrying its id', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['ioa-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_EXCLUSION]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION]))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'POST').length,
      0,
      'an existing exclusion must not be created again',
    )

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'ioa-live-1', 'the update must address the live exclusion by its id')
    assert.equal(body?.name, 'vendor-deployment-agent')
    assert.equal(body?.pattern_id, '10197')
    assert.equal(body?.cl_regex, '.*deploy-agent\\.exe.*')
    assert.deepEqual(body?.groups, ['all'])
  } finally {
    restore()
  }
})

test('ioa-exclusions deploy: records the LIVE prior values of an exclusion it overwrote', async () => {
  // The canvas asks for pattern 10197 applied globally; the tenant holds pattern
  // 10004 scoped to a legacy host group. Rollback restores what was there, so
  // every value below must come from LIVE_EXCLUSION.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['ioa-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_EXCLUSION]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION]))

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
    assert.equal(state[0].id, 'ioa-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.patternId, '10004')
    assert.equal(prior.patternName, 'Credential Dumping')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(prior.clRegex, '.*old-installer\\.exe.*')
    assert.equal(prior.ifnRegex, '.*\\\\Temp\\\\.*')
    assert.equal(
      prior.appliedGlobally,
      false,
      'the exclusion was NOT global before this deploy — recording true would widen it on rollback',
    )
    assert.deepEqual(prior.groups, ['hg-legacy-1'])
    assert.equal(prior.comment, 'added by hand during an incident')
  } finally {
    restore()
  }
})

test('ioa-exclusions deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('ioa-exclusions deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports an exclusion it never created as deployed.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('unknown pattern id') },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /unknown pattern id/)
  } finally {
    restore()
  }
})

test('ioa-exclusions deploy: keeps the rollback record of what it wrote when a later exclusion fails', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'ioa-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION, SCOPED_EXCLUSION]))

    assert.equal(result.success, false)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the exclusion that WAS created must still be recorded')
    assert.equal(state[0].name, 'vendor-deployment-agent')
    assert.equal(state[0].id, 'ioa-new-1')
  } finally {
    restore()
  }
})

test('ioa-exclusions deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['ioa-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_EXCLUSION]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('ioa-exclusions deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createExclusion` throws here AFTER the POST
  // succeeded, and `rollbackState.push` only runs on the line below it — so the
  // exclusion now exists in the tenant with nothing recorded to remove it. Only
  // the half that is certainly right is asserted: no claim of success.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([GLOBAL_EXCLUSION]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the exclusion was in fact created')
  } finally {
    restore()
  }
})

test('ioa-exclusions deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
