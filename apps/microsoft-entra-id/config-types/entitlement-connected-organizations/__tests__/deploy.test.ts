// ============================================================================
// deploy for Entra entitlement-management CONNECTED ORGANIZATIONS, driven end
// to end against a fake Microsoft Graph.
//
// A connected organization names an outside tenant or domain whose users may
// request access packages from this directory. Two fields decide how far that
// reaches:
//   * `state` — "configured" puts the organization into the pool every policy
//     scoped to allConfiguredConnectedOrganizationUsers hands access to;
//     "proposed" leaves it inert.
//   * `identitySources` — WHICH outside tenant/domain the organization actually
//     matches. Send the wrong one and the wrong company's users can request.
// Both are asserted on the wire below, not just "a request happened".
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
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
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

const BASE = '/identityGovernance/entitlementManagement/connectedOrganizations'

/** An azureActiveDirectoryTenant identity source, as the canvas stores it (raw JSON text). */
const PARTNER_SOURCE = {
  '@odata.type': '#microsoft.graph.azureActiveDirectoryTenant',
  tenantId: 'aaaabbbb-0000-cccc-1111-dddd2222eeee',
  displayName: 'Contoso',
}

function liveOrg(over: Record<string, unknown> = {}) {
  return {
    id: 'org-1',
    displayName: 'Contoso',
    description: 'Old description',
    state: 'proposed',
    identitySources: [{ '@odata.type': '#microsoft.graph.domainIdentitySource', domainName: 'old.example' }],
    ...over,
  }
}

function orgItem(fields: Record<string, unknown> = {}, id?: string) {
  return item(
    'Contoso',
    {
      name: 'Contoso',
      description: 'Contoso partner tenant',
      state: 'configured',
      identitySources: JSON.stringify([PARTNER_SOURCE]),
      ...fields,
    },
    id,
  )
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([orgItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach Graph without a credential')
  } finally {
    restore()
  }
})

test('deploy refuses when the tenant id setting is missing', async () => {
  // Client-credentials has no token endpoint without the directory (tenant) id,
  // so this must fail closed BEFORE any network call.
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([orgItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    graphError(403, 'Insufficient privileges to complete the operation.'),
  ])
  try {
    const result = await deploy(deployContext([orgItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list connected organizations/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a deploy that cannot see the live organizations must not create or patch any',
    )
  } finally {
    restore()
  }
})

test('deploy authenticates first, then creates the organization with exactly the declared identity source', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'org-new' })])
  try {
    const result = await deploy(deployContext([orgItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const write = graphCalls.find((c) => c.method === 'POST')
    assert.ok(write, 'expected a POST creating the connected organization')
    assert.ok(write.url.endsWith(BASE))

    assert.deepEqual(bodyOf(write), {
      displayName: 'Contoso',
      description: 'Contoso partner tenant',
      state: 'configured',
      identitySources: [PARTNER_SOURCE],
    })

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries, [{ itemId: undefined, name: 'Contoso', existed: false, id: 'org-new' }])
    assert.equal(leaksSecret(result), false, 'the token must not reach the result or rollbackData')
  } finally {
    restore()
  }
})

test('a "proposed" organization is sent as proposed, never promoted to configured', async () => {
  // "configured" is the state that adds the organization to the pool every
  // allConfiguredConnectedOrganizationUsers policy grants access to.
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'org-new' })])
  try {
    await deploy(deployContext([orgItem({ state: 'proposed' })]))

    const body = bodyOf(writeCalls(calls)[0])
    assert.equal(body?.state, 'proposed')
    assert.notEqual(body?.state, 'configured')
  } finally {
    restore()
  }
})

test('an organization with no declared identity sources is sent an empty array, not omitted', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'org-new' })])
  try {
    await deploy(deployContext([orgItem({ identitySources: '' })]))

    const body = bodyOf(writeCalls(calls)[0])
    assert.deepEqual(body?.identitySources, [], 'an omitted array would leave a stale source in place')
  } finally {
    restore()
  }
})

test('deploy updates an organization that already exists and records its LIVE prior state', async () => {
  const live = liveOrg()
  const { calls, restore } = recordFetch([TOKEN, collection([live]), ok({})])
  try {
    const result = await deploy(deployContext([orgItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'an existing organization is updated, not duplicated')
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith(`${BASE}/org-1`))
    assert.deepEqual(bodyOf(writes[0]), {
      displayName: 'Contoso',
      description: 'Contoso partner tenant',
      state: 'configured',
      identitySources: [PARTNER_SOURCE],
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 'org-1')
    // The prior is the LIVE object read off Graph — the old state and the old
    // identity source — not the desired canvas values.
    assert.deepEqual(entries[0].prior, {
      displayName: 'Contoso',
      description: 'Old description',
      state: 'proposed',
      identitySources: live.identitySources,
    })
    assert.notDeepEqual(entries[0].prior, bodyOf(writes[0]))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('deploy reports a rejected write rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    graphError(400, 'The tenant id in the identity source could not be resolved.', 'BadRequest'),
  ])
  try {
    const result = await deploy(deployContext([orgItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /could not be resolved/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes an organization it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired partner', existed: false, id: 'org-old' },
            { name: 'Pre-existing partner', existed: true, id: 'org-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, 'only the organization this app created may be deleted')
    assert.ok(deletes[0].url.endsWith(`${BASE}/org-old`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})
