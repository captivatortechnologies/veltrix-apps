import { buildCreateBody, resolveAssignment, type ResolvedAssignment } from '../deploy'
import { assignmentKey } from '../validate'

const ROLE_ID = '62e90394-69f5-4237-9190-012177145e10'
const PRINCIPAL_ID = '071cc716-8147-4397-a5ba-b2105951cc0b'
const AU_ID = '5d107bba-d8e2-4e13-b6ae-884be90e5d1a'

const maps = {
  role: new Map([['global administrator', ROLE_ID]]),
  principal: { user: new Map([['ada lovelace', PRINCIPAL_ID]]), group: new Map(), servicePrincipal: new Map() },
  scope: { administrativeUnit: new Map([['west region', AU_ID]]), application: new Map() },
}

describe('resolveAssignment — id-aware, backward compatible with hand-typed names', () => {
  it('passes picker-stored GUIDs/scope through unchanged, without consulting any map', () => {
    const { resolved, missing } = resolveAssignment(
      { roleDefinitionId: ROLE_ID, principalId: PRINCIPAL_ID, directoryScopeId: '/' },
      maps
    )
    expect(resolved).toEqual({ roleDefinitionId: ROLE_ID, principalId: PRINCIPAL_ID, directoryScopeId: '/' })
    expect(missing).toEqual([])
  })

  it('resolves hand-typed role/principal/scope display names via the live maps', () => {
    const { resolved, missing } = resolveAssignment(
      { roleDefinitionId: 'Global Administrator', principalId: 'Ada Lovelace', directoryScopeId: 'West Region' },
      maps
    )
    expect(resolved).toEqual({
      roleDefinitionId: ROLE_ID,
      principalId: PRINCIPAL_ID,
      directoryScopeId: `/administrativeUnits/${AU_ID}`,
    })
    expect(missing).toEqual([])
  })

  it('defaults an empty scope to tenant-wide "/"', () => {
    const { resolved } = resolveAssignment({ roleDefinitionId: ROLE_ID, principalId: PRINCIPAL_ID, directoryScopeId: '' }, maps)
    expect(resolved.directoryScopeId).toBe('/')
  })

  it('collects every unresolvable reference as missing', () => {
    const { missing } = resolveAssignment(
      { roleDefinitionId: 'Ghost Role', principalId: 'Ghost User', directoryScopeId: 'Ghost Scope' },
      maps
    )
    expect(missing).toEqual(['Ghost Role', 'Ghost User', 'Ghost Scope'])
  })
})

describe('buildCreateBody', () => {
  it('builds the full resolved tuple, defaulting an empty scope to "/"', () => {
    const resolved: ResolvedAssignment = { roleDefinitionId: ROLE_ID, principalId: PRINCIPAL_ID, directoryScopeId: '' }
    expect(buildCreateBody(resolved)).toEqual({
      roleDefinitionId: ROLE_ID,
      principalId: PRINCIPAL_ID,
      directoryScopeId: '/',
    })
  })

  it('forwards an administrative-unit scope unchanged', () => {
    const resolved: ResolvedAssignment = {
      roleDefinitionId: ROLE_ID,
      principalId: PRINCIPAL_ID,
      directoryScopeId: `/administrativeUnits/${AU_ID}`,
    }
    expect(buildCreateBody(resolved).directoryScopeId).toBe(`/administrativeUnits/${AU_ID}`)
  })
})

describe('assignmentKey uses the RESOLVED tuple, so two different spellings of the same target match', () => {
  it('produces the same key whether the spec was hand-typed or picker-selected', () => {
    const fromPicker = resolveAssignment({ roleDefinitionId: ROLE_ID, principalId: PRINCIPAL_ID, directoryScopeId: '/' }, maps)
    const fromHandTyped = resolveAssignment(
      { roleDefinitionId: 'Global Administrator', principalId: 'Ada Lovelace', directoryScopeId: '/' },
      maps
    )
    expect(assignmentKey(fromPicker.resolved)).toBe(assignmentKey(fromHandTyped.resolved))
  })
})

// ============================================================================
// deploy, end to end against a fake Microsoft Graph.
//
// A unifiedRoleAssignment IS a privilege grant — Global Administrator to a
// principal, tenant-wide. There is no PATCH on the resource, so every mistake
// here is a create or a delete: a duplicate grant, or a revoked one. The
// assertions below are about the two ways that goes wrong in production — a
// truncated listing making an existing grant look missing, and reconcile
// deleting a grant the canvas still declares.
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
  page,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

const ASSIGNMENTS = /\/roleManagement\/directory\/roleAssignments$/
const ONE_ASSIGNMENT = /\/roleManagement\/directory\/roleAssignments\/[^/?]+$/
const ROLE_DEFS = /\/roleDefinitions\?/
const USERS = /\/users\?/

const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10'
const ADA = '071cc716-8147-4397-a5ba-b2105951cc0b'

/** One canvas item granting Global Administrator tenant-wide. */
function grant(fields: Record<string, unknown> = {}) {
  return item('Global admin for Ada', {
    roleDefinitionId: GLOBAL_ADMIN,
    principalId: ADA,
    label: 'Global admin for Ada',
    ...fields,
  })
}

const KEY = `${GLOBAL_ADMIN}|${ADA}|/`.toLowerCase()

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([grant()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed assignment listing stops the deploy before it grants anything', async () => {
  const { calls, restore } = routeFetch([
    { url: ASSIGNMENTS, method: 'GET', respond: graphError(403, 'Insufficient privileges to complete the operation.') },
  ])
  try {
    const result = await deploy(deployContext([grant()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list role assignments/)
    assert.equal(writeCalls(calls).length, 0, 'a deploy that cannot see live grants must not create one')
  } finally {
    restore()
  }
})

test('a TRUNCATED listing refuses to reconcile rather than duplicate a privileged grant', async () => {
  // Every page carries a nextLink, so the page budget runs out with more to
  // read. An existing grant could be sitting on an unread page.
  const { calls, restore } = routeFetch([
    {
      url: ASSIGNMENTS,
      method: 'GET',
      respond: page([], 'https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments'),
    },
  ])
  try {
    const result = await deploy(deployContext([grant()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /truncated/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates the declared tuple, scoped to the tenant root', async () => {
  const { calls, restore } = routeFetch([
    { url: ASSIGNMENTS, method: 'GET', respond: collection([]) },
    { url: ASSIGNMENTS, method: 'POST', respond: created({ id: 'ra-new' }) },
  ])
  try {
    const result = await deploy(deployContext([grant()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const post = graphCalls.find((c) => c.method === 'POST')
    assert.ok(post, 'expected a POST creating the assignment')
    assert.deepEqual(bodyOf(post), {
      roleDefinitionId: GLOBAL_ADMIN,
      principalId: ADA,
      directoryScopeId: '/',
    })
    assert.equal(result.success, true)

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, false, 'a grant this app created must be revocable')
    assert.equal(entries[0].id, 'ra-new')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy resolves a hand-typed role and principal name to their live ids', async () => {
  const { calls, restore } = routeFetch([
    { url: ASSIGNMENTS, method: 'GET', respond: collection([]) },
    { url: ROLE_DEFS, respond: collection([{ id: GLOBAL_ADMIN, displayName: 'Global Administrator' }]) },
    { url: USERS, respond: collection([{ id: ADA, displayName: 'Ada Lovelace', userPrincipalName: 'ada@contoso.com' }]) },
    { url: ASSIGNMENTS, method: 'POST', respond: created({ id: 'ra-new' }) },
  ])
  try {
    await deploy(
      deployContext([grant({ roleDefinitionId: 'Global Administrator', principalId: 'ada@contoso.com' })]),
    )

    const post = writeCalls(calls).find((c) => c.method === 'POST')
    assert.ok(post)
    assert.deepEqual(bodyOf(post), {
      roleDefinitionId: GLOBAL_ADMIN,
      principalId: ADA,
      directoryScopeId: '/',
    })
  } finally {
    restore()
  }
})

test('a tuple that already exists is a no-op — the immutable object is never rewritten', async () => {
  const { calls, restore } = routeFetch([
    {
      url: ASSIGNMENTS,
      method: 'GET',
      respond: collection([
        { id: 'ra-live', roleDefinitionId: GLOBAL_ADMIN, principalId: ADA, directoryScopeId: '/' },
      ]),
    },
  ])
  try {
    const result = await deploy(deployContext([grant()]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    // existed:true is what stops rollback revoking a grant that pre-dated us.
    assert.deepEqual(entries, [{ itemId: undefined, name: KEY, existed: true, id: 'ra-live' }])
  } finally {
    restore()
  }
})

test('provenance is sticky — a grant this app created stays revocable across a later deploy', async () => {
  const { restore } = routeFetch([
    {
      url: ASSIGNMENTS,
      method: 'GET',
      respond: collection([
        { id: 'ra-live', roleDefinitionId: GLOBAL_ADMIN, principalId: ADA, directoryScopeId: '/' },
      ]),
    },
  ])
  try {
    const result = await deploy(
      deployContext([grant()], {
        priorRollbackData: { entries: [{ name: KEY, existed: false, id: 'ra-live' }] },
      }),
    )

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(
      entries[0].existed,
      false,
      'a privileged grant must not become un-revocable just because it survived an intervening deploy',
    )
  } finally {
    restore()
  }
})

test('an unresolvable principal fails the item without granting anything', async () => {
  const { calls, restore } = routeFetch([{ url: ASSIGNMENTS, method: 'GET', respond: collection([]) }])
  try {
    const result = await deploy(deployContext([grant({ principalId: 'Ghost User' })]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown target\(s\) Ghost User/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('reconcile revokes a grant this app created and no longer declares', async () => {
  const { calls, restore } = routeFetch([
    { url: ASSIGNMENTS, method: 'GET', respond: collection([]) },
    { url: ONE_ASSIGNMENT, method: 'DELETE', respond: NO_CONTENT },
  ])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'stale|tuple|/', existed: false, id: 'ra-stale' },
            { name: 'pre|existing|/', existed: true, id: 'ra-theirs' },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only a grant this app created may be revoked')
    assert.ok(deletes[0].url.includes('/roleAssignments/ra-stale'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a grant whose reference failed to resolve this run is NOT revoked by reconcile', async () => {
  // A typo or a briefly unreadable directory must not silently revoke a
  // privileged assignment the canvas still declares — only removing the item does.
  const { calls, restore } = routeFetch([{ url: ASSIGNMENTS, method: 'GET', respond: collection([]) }])
  try {
    const result = await deploy(
      deployContext([item('Global admin for Ada', { roleDefinitionId: GLOBAL_ADMIN, principalId: 'Ghost User' }, 'canvas-item-1')], {
        priorRollbackData: { entries: [{ itemId: 'canvas-item-1', name: KEY, existed: false, id: 'ra-live' }] },
      }),
    )

    assert.equal(result.success, false)
    assert.equal(
      writeCalls(calls).filter((c) => c.method === 'DELETE').length,
      0,
      'a transient resolution failure must never revoke a still-declared grant',
    )
  } finally {
    restore()
  }
})

test('deploy reports a rejected create rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: ASSIGNMENTS, method: 'GET', respond: collection([]) },
    { url: ASSIGNMENTS, method: 'POST', respond: graphError(400, 'The role assignment already exists.', 'Request_BadRequest') },
  ])
  try {
    const result = await deploy(deployContext([grant()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already exists/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
