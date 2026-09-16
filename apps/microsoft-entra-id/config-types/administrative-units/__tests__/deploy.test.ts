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
  recordFetch,
  routeFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy, { reconcileMembers, buildCreateBody, buildPatchBody } from '../deploy'
import { buildGraphClient } from '../../../lib/graph'

interface Call {
  method: string
  url: string
  body?: unknown
}

function mockGraphFetch(responder: (method: string, url: string) => { status: number; body: unknown }): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.includes('login.microsoftonline.com')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ access_token: 'test-token', expires_in: 3600 }),
      }
    }
    calls.push({ method, url: u, body: init?.body ? JSON.parse(init.body) : undefined })
    const { status, body } = responder(method, u)
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    }
  }) as unknown as typeof fetch
  return calls
}

function client() {
  return buildGraphClient(
    { tenantId: 'tenant-1', clientId: 'client-id', clientSecret: 'secret' },
    { timeoutMs: 5000, tenantId: 'tenant-1' }
  )
}

const UNIT_ID = 'au-1'
const USER_ID = 'u-1'
const GROUP_ID = 'g-1'
const DEVICE_ID = 'd-1'

describe('reconcileMembers', () => {
  it('adds every desired member not already live, via POST .../members/$ref with a directoryObjects @odata.id', async () => {
    const calls = mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/members')) return { status: 200, body: { value: [] } }
      if (method === 'POST' && u.includes('/members/$ref')) return { status: 204, body: {} }
      return { status: 404, body: {} }
    })
    const { members, failures } = await reconcileMembers(client(), UNIT_ID, [USER_ID, GROUP_ID], [])
    expect(failures).toEqual([])
    expect(members).toEqual([
      { id: USER_ID, existed: false },
      { id: GROUP_ID, existed: false },
    ])
    const addCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/members/$ref'))
    expect(addCalls).toHaveLength(2)
    for (const c of addCalls) {
      const odataId = (c.body as { '@odata.id'?: string })['@odata.id'] ?? ''
      expect(odataId).toContain('https://graph.microsoft.com/v1.0/directoryObjects/')
    }
  })

  it('does not re-add a member that is already live', async () => {
    const calls = mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/members')) return { status: 200, body: { value: [{ id: USER_ID }] } }
      return { status: 204, body: {} }
    })
    await reconcileMembers(client(), UNIT_ID, [USER_ID], [])
    const addCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/members/$ref'))
    expect(addCalls).toHaveLength(0)
  })

  it('a member already live but untracked is treated as pre-existing (existed:true), not owned by this app', async () => {
    mockGraphFetch((method, u) => (method === 'GET' && u.includes('/members') ? { status: 200, body: { value: [{ id: USER_ID }] } } : { status: 204, body: {} }))
    const { members } = await reconcileMembers(client(), UNIT_ID, [USER_ID], [])
    expect(members).toEqual([{ id: USER_ID, existed: true }])
  })

  it('removes ONLY members this app previously added (existed:false) that are no longer declared', async () => {
    const calls = mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/members')) return { status: 200, body: { value: [{ id: USER_ID }, { id: GROUP_ID }, { id: DEVICE_ID }] } }
      return { status: 204, body: {} }
    })
    const prior = [
      { id: USER_ID, existed: false }, // app-owned, no longer declared -> revoke
      { id: GROUP_ID, existed: true }, // pre-existing, no longer declared -> leave alone
      { id: DEVICE_ID, existed: false }, // app-owned, still declared -> leave alone
    ]
    const { members } = await reconcileMembers(client(), UNIT_ID, [DEVICE_ID], prior)

    const deleteCalls = calls.filter((c) => c.method === 'DELETE')
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0].url).toContain(`/members/${USER_ID}/$ref`)
    // The critical safety property: the delete call MUST end in "/$ref" — without
    // it Graph deletes the member object itself, not just the membership.
    expect(deleteCalls[0].url.endsWith('/$ref')).toBe(true)
    expect(members).toEqual([{ id: DEVICE_ID, existed: false }])
  })

  it('leaves membership unchanged and reports a failure when the live listing cannot be read', async () => {
    mockGraphFetch(() => ({ status: 500, body: { error: { message: 'boom' } } }))
    const prior = [{ id: USER_ID, existed: false }]
    const { members, failures } = await reconcileMembers(client(), UNIT_ID, [GROUP_ID], prior)
    expect(members).toEqual(prior)
    expect(failures.length).toBeGreaterThan(0)
  })

  it('reports a per-member failure without throwing when an add fails', async () => {
    mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/members')) return { status: 200, body: { value: [] } }
      if (method === 'POST') return { status: 403, body: { error: { code: 'Forbidden', message: 'no permission' } } }
      return { status: 404, body: {} }
    })
    const { members, failures } = await reconcileMembers(client(), UNIT_ID, [USER_ID], [])
    expect(members).toEqual([])
    expect(failures.some((f) => f.includes('no permission'))).toBe(true)
  })
})

describe('buildCreateBody / buildPatchBody are unaffected by members (a separate reconcile step)', () => {
  it('never includes a members key', () => {
    const spec = { name: 'AU', description: '', visibility: 'public', members: ['x'] }
    expect('members' in buildCreateBody(spec)).toBeFalsy()
    expect('members' in buildPatchBody(spec)).toBeFalsy()
  })
})

// ============================================================================
// deploy, end to end against a fake Microsoft Graph.
//
// Everything above tests `reconcileMembers` and the body builders in isolation.
// What follows drives the DEFAULT export — the handler that actually creates
// administrative units in a customer's directory and moves users, groups and
// devices into them. An administrative unit is a delegation boundary: what is
// inside it is what a scoped admin may administer, so the assertions are about
// which objects end up inside, the visibility the unit is created with, and the
// provenance that stops a rollback evicting members the tenant put there first.
//
// These use `routeFetch` rather than a response queue: deploy builds the
// user/group/device display-name maps with `Promise.all`, and a queue would
// encode an ordering those parallel listings do not guarantee.
// ============================================================================

const BASE = '/directory/administrativeUnits'

/** GET /directory/administrativeUnits?$select=... — the live unit listing. */
const AU_LIST = /\/directory\/administrativeUnits\?\$select=id,displayName,description/
/** POST /directory/administrativeUnits — creating a unit. */
const AU_CREATE = /\/directory\/administrativeUnits$/
/** PATCH|DELETE /directory/administrativeUnits/{id} — the unit itself. */
const AU_ITEM = /\/administrativeUnits\/[^/?]+$/
/** GET .../members?$select=id — the unit's current membership. */
const MEMBER_LIST = /\/administrativeUnits\/[^/]+\/members\?/
/** POST .../members/$ref — adding one member. */
const MEMBER_ADD = /\/administrativeUnits\/[^/]+\/members\/\$ref$/
/** DELETE .../members/{id}/$ref — de-linking one member (never deleting it). */
const MEMBER_REMOVE = /\/administrativeUnits\/[^/]+\/members\/[^/]+\/\$ref$/

const ADA = 'a1111111-1111-1111-1111-111111111111'

/** The name maps every run builds; empty unless a test needs a hand-typed name. */
function nameMapRoutes(over: { users?: unknown[]; groups?: unknown[]; devices?: unknown[] } = {}) {
  return [
    { url: /\/users\?/, respond: collection(over.users ?? []) },
    { url: /\/groups\?/, respond: collection(over.groups ?? []) },
    { url: /\/devices\?/, respond: collection(over.devices ?? []) },
  ]
}

function liveUnit(over: Record<string, unknown> = {}) {
  return {
    id: 'au-1',
    displayName: 'West Region',
    description: 'Old description',
    visibility: 'HiddenMembership',
    membershipType: null,
    ...over,
  }
}

function unitItem(fields: Record<string, unknown> = {}) {
  return item('West Region', { name: 'West Region', ...fields })
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([unitItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  // Client-credentials has no token endpoint without the directory (tenant) id,
  // so this must fail closed BEFORE any network call, not half way through.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([unitItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed unit listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([
    { url: AU_LIST, respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await deploy(deployContext([unitItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list administrative units/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see the live units would create a duplicate of every one of them',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates a unit with visibility null — never hidden by accident', async () => {
  const { calls, restore } = routeFetch([
    { url: AU_LIST, respond: collection([]) },
    ...nameMapRoutes(),
    { url: AU_CREATE, method: 'POST', respond: created({ id: 'au-new' }) },
  ])
  try {
    const result = await deploy(deployContext([unitItem({ description: 'Western offices' })]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls[0].method, 'GET', 'the live units are listed before anything is written')

    const post = writeCalls(calls).find((c) => c.method === 'POST')
    assert.ok(post, 'expected a POST creating the unit')
    assert.ok(post.url.endsWith(BASE))
    // `null` is Graph's encoding of the PUBLIC default. Sending
    // "HiddenMembership" here would hide the unit's membership from every
    // non-member in the tenant.
    assert.deepEqual(bodyOf(post), {
      displayName: 'West Region',
      description: 'Western offices',
      visibility: null,
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].id, 'au-new')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'the access token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('deploy sends visibility HiddenMembership only when the canvas asks for it', async () => {
  const { calls, restore } = routeFetch([
    { url: AU_LIST, respond: collection([]) },
    ...nameMapRoutes(),
    { url: AU_CREATE, method: 'POST', respond: created({ id: 'au-new' }) },
  ])
  try {
    await deploy(deployContext([unitItem({ visibility: 'hiddenmembership' })]))

    assert.equal(bodyOf(writeCalls(calls)[0])?.visibility, 'HiddenMembership')
  } finally {
    restore()
  }
})

test('deploy updates an existing unit and records its LIVE prior fields', async () => {
  const { calls, restore } = routeFetch([
    { url: AU_LIST, respond: collection([liveUnit()]) },
    ...nameMapRoutes(),
    { url: AU_ITEM, method: 'PATCH', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(deployContext([unitItem({ description: 'Western offices' })]))

    const patch = writeCalls(calls).find((c) => c.method === 'PATCH')
    assert.ok(patch, 'an existing unit is updated, not duplicated')
    assert.ok(patch.url.endsWith(`${BASE}/au-1`))
    assert.deepEqual(bodyOf(patch), {
      displayName: 'West Region',
      description: 'Western offices',
      visibility: null,
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    // The prior snapshot is the tenant's own values — including the
    // HiddenMembership this deploy is about to clear.
    assert.deepEqual(entries[0].prior, {
      displayName: 'West Region',
      description: 'Old description',
      visibility: 'HiddenMembership',
    })
    assert.notDeepEqual(entries[0].prior, bodyOf(patch))
  } finally {
    restore()
  }
})

test('deploy adds a declared member by $ref and records that IT added it', async () => {
  const { calls, restore } = routeFetch([
    { url: MEMBER_ADD, method: 'POST', respond: NO_CONTENT },
    { url: MEMBER_LIST, method: 'GET', respond: collection([]) },
    { url: AU_LIST, respond: collection([liveUnit()]) },
    ...nameMapRoutes({ users: [{ id: ADA, displayName: 'Ada Lovelace', userPrincipalName: 'ada@contoso.com' }] }),
    { url: AU_ITEM, method: 'PATCH', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(deployContext([unitItem({ members: ['Ada Lovelace'] })]))

    const add = writeCalls(calls).find((c) => c.method === 'POST')
    assert.ok(add, 'expected a POST to members/$ref')
    assert.ok(add.url.endsWith(`${BASE}/au-1/members/$ref`))
    assert.deepEqual(bodyOf(add), { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${ADA}` })

    const entries = (result.rollbackData as { entries: Array<{ members: Array<Record<string, unknown>> }> }).entries
    assert.deepEqual(entries[0].members, [{ id: ADA, existed: false }])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a member already in the unit is tracked as pre-existing and not re-added', async () => {
  const { calls, restore } = routeFetch([
    { url: MEMBER_LIST, method: 'GET', respond: collection([{ id: ADA }]) },
    { url: AU_LIST, respond: collection([liveUnit()]) },
    ...nameMapRoutes({ users: [{ id: ADA, displayName: 'Ada Lovelace' }] }),
    { url: AU_ITEM, method: 'PATCH', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(deployContext([unitItem({ members: ['Ada Lovelace'] })]))

    assert.equal(
      writeCalls(calls).filter((c) => c.url.includes('/$ref')).length,
      0,
      'a membership that already exists must not be written again',
    )
    const entries = (result.rollbackData as { entries: Array<{ members: Array<Record<string, unknown>> }> }).entries
    // existed:true is what stops rollback evicting somebody else's member.
    assert.deepEqual(entries[0].members, [{ id: ADA, existed: true }])
  } finally {
    restore()
  }
})

test('a member this app added and no longer declares is de-linked with a trailing /$ref', async () => {
  const { calls, restore } = routeFetch([
    { url: MEMBER_REMOVE, method: 'DELETE', respond: NO_CONTENT },
    { url: MEMBER_LIST, method: 'GET', respond: collection([{ id: ADA }, { id: 'u-theirs' }]) },
    { url: AU_LIST, respond: collection([liveUnit()]) },
    ...nameMapRoutes(),
    { url: AU_ITEM, method: 'PATCH', respond: NO_CONTENT },
  ])
  try {
    await deploy(
      deployContext([unitItem({ members: [] })], {
        priorRollbackData: {
          entries: [
            {
              name: 'West Region',
              existed: true,
              id: 'au-1',
              prior: {},
              members: [
                { id: ADA, existed: false },
                { id: 'u-theirs', existed: true },
              ],
            },
          ],
        },
      }),
    )

    const removes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.deepEqual(
      removes.map((c) => c.url.replace(/^.*\/v1\.0/, '')),
      [`${BASE}/au-1/members/${ADA}/$ref`],
      'a member that pre-dated this app must survive, and the trailing /$ref keeps this a de-link',
    )
  } finally {
    restore()
  }
})

test('an unresolvable member name leaves the membership completely untouched', async () => {
  const { calls, restore } = routeFetch([
    { url: MEMBER_LIST, method: 'GET', respond: collection([]) },
    { url: AU_LIST, respond: collection([liveUnit()]) },
    ...nameMapRoutes(),
    { url: AU_ITEM, method: 'PATCH', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(deployContext([unitItem({ members: ['Ghost User'] })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown member\(s\) Ghost User/)
    assert.equal(
      vendorCalls(calls).filter((c) => c.url.includes('/members')).length,
      0,
      'membership must not be half-applied — nor even read — while one member cannot be resolved',
    )
    const entries = (result.rollbackData as { entries: Array<{ members: unknown[] }> }).entries
    assert.deepEqual(entries[0].members, [], 'membership stays as last tracked, not as a partial guess')
  } finally {
    restore()
  }
})

test('deploy reports a rejected create rather than throwing, and leaks no secret', async () => {
  const { restore } = routeFetch([
    { url: AU_LIST, respond: collection([]) },
    ...nameMapRoutes(),
    {
      url: AU_CREATE,
      method: 'POST',
      respond: graphError(400, 'Another object with the same value for property displayName already exists.', 'Request_BadRequest'),
    },
  ])
  try {
    const result = await deploy(deployContext([unitItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Some administrative units failed/)
    assert.match(String(result.message), /displayName already exists/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes a unit it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: AU_LIST, respond: collection([]) },
    ...nameMapRoutes(),
    { url: AU_ITEM, method: 'DELETE', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired Region', existed: false, id: 'au-old' },
            { name: 'Pre-existing Region', existed: true, id: 'au-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only a unit this app created may be deleted')
    assert.ok(deletes[0].url.endsWith(`${BASE}/au-old`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
