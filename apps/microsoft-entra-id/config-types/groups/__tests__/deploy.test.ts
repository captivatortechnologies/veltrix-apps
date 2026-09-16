// ============================================================================
// deploy for Entra security groups, against a fake Microsoft Graph.
//
// Group membership IS access in Entra — a Conditional Access policy, a role
// assignment and an access package all target groups. So the assertions here are
// about what the handler refuses to do as much as what it does: never create a
// mail-enabled or Microsoft 365 group, never modify a same-named group it does
// not own, never touch membership while a declared member is unresolvable, and
// never remove a reference it did not add.
//
// These use `routeFetch` rather than a response queue: deploy builds six
// display-name maps with `Promise.all`, and a queue would encode an ordering
// those parallel listings do not guarantee.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  created,
  deployContext,
  graphError,
  item,
  leaksSecret,
  ok,
  recordFetch,
  routeFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

/** GET /groups?$select=id,displayName,description,... — the live group listing. */
const LIST = /\/groups\?\$select=id,displayName,description/
/** GET /groups?$select=id,displayName — the displayName -> id map. */
const GROUP_MAP = /\/groups\?\$select=id,displayName$/
const OWNERS = /\/groups\/[^/]+\/owners/
const MEMBERS = /\/groups\/[^/]+\/members/
const CREATE = /\/v1\.0\/groups$/
const UPDATE = /\/v1\.0\/groups\/[^/?]+$/

/** A plain assigned security group — the only kind this handler may manage. */
function liveGroup(over: Record<string, unknown> = {}) {
  return {
    id: 'g-1',
    displayName: 'Engineering',
    description: 'Engineers',
    mailNickname: 'Engineering',
    mailEnabled: false,
    securityEnabled: true,
    groupTypes: [],
    ...over,
  }
}

function groupItem(fields: Record<string, unknown> = {}) {
  return item('Engineering', { name: 'Engineering', ...fields })
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([groupItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed group listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await deploy(deployContext([groupItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list groups/)
    assert.equal(writeCalls(calls).length, 0, 'a deploy that cannot see live groups must not create one')
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates a plain security group, never a mail or M365 group', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: created({ id: 'g-new' }) },
  ])
  try {
    const result = await deploy(deployContext([groupItem({ description: 'Engineers' })]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const post = graphCalls.find((c) => c.method === 'POST')
    assert.ok(post, 'expected a POST creating the group')

    const body = bodyOf(post)
    assert.ok(body)
    assert.equal(body.displayName, 'Engineering')
    assert.equal(body.mailEnabled, false, 'a mail-enabled group is a different, unmanaged object')
    assert.equal(body.securityEnabled, true)
    assert.deepEqual(body.groupTypes, [], 'an empty groupTypes keeps this an assigned, non-dynamic group')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy refuses to modify a same-named Microsoft 365 group and writes nothing', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveGroup({ groupTypes: ['Unified'] })]) },
  ])
  try {
    const result = await deploy(deployContext([groupItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /will not be modified/)
    assert.equal(writeCalls(calls).length, 0, 'a group this app does not own must be left completely alone')
  } finally {
    restore()
  }
})

test('deploy refuses to modify a same-named dynamic-membership group', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveGroup({ groupTypes: ['DynamicMembership'] })]) },
  ])
  try {
    const result = await deploy(deployContext([groupItem()]))

    assert.equal(result.success, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('deploy updates an existing security group and records its LIVE prior fields', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveGroup({ description: 'Old description', mailNickname: 'eng-old' })]) },
    { url: OWNERS, respond: collection([]) },
    { url: MEMBERS, respond: collection([]) },
    { url: UPDATE, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([groupItem({ description: 'Engineers' })]))

    const patch = writeCalls(calls).find((c) => c.method === 'PATCH')
    assert.ok(patch, 'an existing group is updated, not duplicated')
    assert.ok(patch.url.includes('/groups/g-1'))
    assert.equal(bodyOf(patch)?.description, 'Engineers')

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    // The prior snapshot is the tenant's own values, not the canvas's.
    assert.deepEqual(entries[0].prior, {
      displayName: 'Engineering',
      description: 'Old description',
      mailNickname: 'eng-old',
    })
  } finally {
    restore()
  }
})

test('deploy adds a declared member by $ref and records that IT added it', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveGroup()]) },
    { url: GROUP_MAP, respond: collection([]) },
    { url: /\/users\?/, respond: collection([{ id: 'u-1', displayName: 'Ada Lovelace', userPrincipalName: 'ada@contoso.com' }]) },
    { url: OWNERS, respond: collection([]) },
    { url: MEMBERS, method: 'GET', respond: collection([]) },
    { url: MEMBERS, method: 'POST', respond: NO_CONTENT },
    { url: UPDATE, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([groupItem({ members: ['Ada Lovelace'] })]))

    const add = writeCalls(calls).find((c) => c.method === 'POST' && /\/members\/\$ref$/.test(c.url))
    assert.ok(add, 'expected a POST to members/$ref')
    assert.equal(bodyOf(add)?.['@odata.id'], 'https://graph.microsoft.com/v1.0/directoryObjects/u-1')

    const entries = (result.rollbackData as { entries: Array<{ members: Array<{ id: string; existed: boolean }> }> }).entries
    assert.deepEqual(entries[0].members, [{ id: 'u-1', existed: false }])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a member that is already in the group is tracked as pre-existing and not re-added', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveGroup()]) },
    { url: GROUP_MAP, respond: collection([]) },
    { url: /\/users\?/, respond: collection([{ id: 'u-1', displayName: 'Ada Lovelace' }]) },
    { url: OWNERS, respond: collection([]) },
    { url: MEMBERS, method: 'GET', respond: collection([{ id: 'u-1' }]) },
    { url: UPDATE, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([groupItem({ members: ['Ada Lovelace'] })]))

    const adds = writeCalls(calls).filter((c) => /\/\$ref$/.test(c.url))
    assert.equal(adds.length, 0, 'a membership that already exists must not be written again')

    const entries = (result.rollbackData as { entries: Array<{ members: Array<{ id: string; existed: boolean }> }> }).entries
    // existed:true is what stops rollback revoking someone else's membership.
    assert.deepEqual(entries[0].members, [{ id: 'u-1', existed: true }])
  } finally {
    restore()
  }
})

test('an unresolvable member name leaves membership untouched', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([liveGroup()]) },
    { url: GROUP_MAP, respond: collection([]) },
    { url: OWNERS, respond: collection([]) },
    { url: UPDATE, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await deploy(deployContext([groupItem({ members: ['Ghost User'] })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown member\(s\) Ghost User/)
    assert.equal(
      vendorCalls(calls).filter((c) => /\/members/.test(c.url) && c.method !== 'GET').length,
      0,
      'membership must not be half-applied while one member cannot be resolved',
    )
  } finally {
    restore()
  }
})

test('deploy reports a rejected create rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: CREATE, method: 'POST', respond: graphError(400, 'Another object with the same value for property mailNickname already exists.', 'Request_BadRequest') },
  ])
  try {
    const result = await deploy(deployContext([groupItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /mailNickname already exists/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes a group it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: LIST, respond: collection([]) },
    { url: UPDATE, method: 'DELETE', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired', existed: false, id: 'g-old' },
            { name: 'Pre-existing', existed: true, id: 'g-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only a group this app created may be deleted')
    assert.ok(deletes[0].url.includes('/groups/g-old'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
