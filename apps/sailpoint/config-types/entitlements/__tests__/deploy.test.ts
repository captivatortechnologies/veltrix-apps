// ============================================================================
// deploy for the ISC entitlement governance overlay.
//
// Entitlements are discovered by aggregation; this app never creates or deletes
// one. Everything therefore hinges on matching the RIGHT entitlement before
// writing: one name can exist on several sources, and twice on one source under
// different schema attributes. A wrong match marks somebody else's group
// requestable and privileged.
//
// The three refusals below — source not found, nothing matched, more than one
// matched — all have to happen before any write.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  callsWithMethod,
  deployContext,
  iscError,
  leaksSecret,
  listPage,
  ok,
  pathOf,
  recordFetch,
  resource,
  writeCalls,
} from '../../../lib/__tests__/fakeIsc'
import { MISSING_CREDENTIAL_MESSAGE } from '../../../lib/isc'
import deploy from '../deploy'
import {
  ENTITLEMENTS,
  ENTITLEMENT_ID,
  NAME,
  PRIOR,
  SOURCE_ID,
  entitlementItem,
  inSyncEntitlement,
  liveEntitlement,
  parentSource,
} from './fixtures'

type Entries = Array<Record<string, unknown>>

function entriesOf(result: { rollbackData?: unknown }): Entries {
  return ((result.rollbackData as { entries?: Entries } | undefined)?.entries ?? []) as Entries
}

test('entitlements deploy: refuses without a credential instead of calling ISC', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([entitlementItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.equal(result.message, MISSING_CREDENTIAL_MESSAGE)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('entitlements deploy: refuses when the tenant setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([entitlementItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('entitlements deploy: a failed source listing stops the deploy before it writes', async () => {
  const { calls, restore } = recordFetch([TOKEN, iscError(500, 'upstream failure')])
  try {
    const result = await deploy(deployContext([entitlementItem()]))

    assert.equal(result.success, false)
    assert.match(result.message, /Failed to list sources/i)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('entitlements deploy: reports a source it cannot find, without writing', async () => {
  const { calls, restore } = recordFetch([TOKEN, listPage([])])
  try {
    const result = await deploy(deployContext([entitlementItem()]))

    assert.equal(result.success, false)
    assert.match(result.message, /source "Active Directory" not found/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('entitlements deploy: refuses when nothing matches — it never creates an entitlement', async () => {
  // An entitlement has to be discovered by aggregation first. Creating one here
  // would invent access that no directory actually grants.
  const { calls, restore } = recordFetch([TOKEN, listPage([parentSource()]), listPage([])])
  try {
    const result = await deploy(deployContext([entitlementItem()]))

    assert.equal(result.success, false)
    assert.match(result.message, /no matching entitlement found/)
    assert.equal(writeCalls(calls).length, 0, 'an unmatched entitlement must not be created')
  } finally {
    restore()
  }
})

test('entitlements deploy: refuses when more than one entitlement matches', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    listPage([parentSource()]),
    listPage([liveEntitlement(), liveEntitlement({ id: 'ent-other', attribute: 'memberOfOther' })]),
  ])
  try {
    const result = await deploy(deployContext([entitlementItem()]))

    assert.equal(result.success, false)
    assert.match(result.message, /multiple entitlements match/)
    assert.equal(writeCalls(calls).length, 0, 'an ambiguous match must not be written to')
  } finally {
    restore()
  }
})

test('entitlements deploy: refuses when the lookup itself fails', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    listPage([parentSource()]),
    iscError(403, 'not authorized to read entitlements'),
  ])
  try {
    const result = await deploy(deployContext([entitlementItem()]))

    assert.equal(result.success, false)
    assert.ok(result.message.includes('not authorized to read entitlements'), result.message)
    assert.equal(writeCalls(calls).length, 0, 'a failed lookup must not become a blind write')
  } finally {
    restore()
  }
})

test('entitlements deploy: scopes the lookup to the source, the name and the attribute', async () => {
  const { calls, restore } = recordFetch([TOKEN, listPage([parentSource()]), listPage([liveEntitlement()]), ok({})])
  try {
    await deploy(deployContext([entitlementItem()]))

    const lookup = calls.find((c) => c.url.includes('filters='))
    assert.ok(lookup, 'expected a filtered entitlement lookup')
    const filter = decodeURIComponent(lookup.url)
    assert.ok(filter.includes(`source.id eq "${SOURCE_ID}"`), filter)
    assert.ok(filter.includes(`name eq "${NAME}"`), filter)
    assert.ok(filter.includes('attribute eq "memberOf"'), filter)
  } finally {
    restore()
  }
})

test('entitlements deploy: overlays the matched entitlement and records the LIVE prior', async () => {
  const { calls, restore } = recordFetch([TOKEN, listPage([parentSource()]), listPage([liveEntitlement()]), ok({})])
  try {
    const result = await deploy(deployContext([entitlementItem()]))

    assert.equal(result.success, true, result.message)
    assertAuthenticatedFirst(assert, calls)

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH')
    assert.equal(pathOf(writes[0]), `${ENTITLEMENTS}/${ENTITLEMENT_ID}`)
    const ops = bodyOf(writes[0]) as Array<{ path: string; value: unknown }>
    assert.equal(ops.find((o) => o.path === '/requestable')?.value, true)
    assert.equal(ops.find((o) => o.path === '/privileged')?.value, true)
    assert.deepEqual(ops.find((o) => o.path === '/manuallyUpdatedFields')?.value, {
      DISPLAY_NAME: true,
      DESCRIPTION: true,
    })

    const entries = entriesOf(result)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].entitlementId, ENTITLEMENT_ID)
    assert.deepEqual(entries[0].prior, PRIOR)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('entitlements deploy: leaves the owner alone when the canvas declares none', async () => {
  // Blank means "not managed here", not "clear it". Clearing an owner removes
  // whoever approvals route to.
  const { calls, restore } = recordFetch([TOKEN, listPage([parentSource()]), listPage([liveEntitlement()]), ok({})])
  try {
    await deploy(deployContext([entitlementItem({ ownerId: '' })]))

    const ops = bodyOf(writeCalls(calls)[0]) as Array<{ path: string }>
    assert.equal(ops.some((o) => o.path === '/owner'), false, 'an undeclared owner must not be written')
  } finally {
    restore()
  }
})

test('entitlements deploy: reuses the id it cached last time instead of looking up again', async () => {
  const { calls, restore } = recordFetch([TOKEN, listPage([parentSource()]), resource(liveEntitlement()), ok({})])
  try {
    const renamed = { ...entitlementItem({ name: 'Finance-RW (renamed)' }), id: 'canvas-item-1' }
    const result = await deploy(
      deployContext([renamed], {
        priorRollbackData: {
          entries: [
            {
              itemId: 'canvas-item-1',
              sourceName: 'Active Directory',
              name: NAME,
              attribute: 'memberOf',
              entitlementId: ENTITLEMENT_ID,
              prior: PRIOR,
            },
          ],
        },
      }),
    )

    assert.equal(result.success, true, result.message)
    assert.equal(
      calls.some((c) => c.url.includes('filters=')),
      false,
      'a cached id that is still on the same source needs no lookup',
    )
    assert.equal(pathOf(writeCalls(calls)[0]), `${ENTITLEMENTS}/${ENTITLEMENT_ID}`)
  } finally {
    restore()
  }
})

test('entitlements deploy: falls back to a lookup when the cached id moved source', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    listPage([parentSource()]),
    resource(liveEntitlement({ id: 'ent-elsewhere', source: { id: 'src-somewhere-else' } })),
    listPage([liveEntitlement()]),
    ok({}),
  ])
  try {
    const cached = { ...entitlementItem(), id: 'canvas-item-1' }
    const result = await deploy(
      deployContext([cached], {
        priorRollbackData: {
          entries: [
            {
              itemId: 'canvas-item-1',
              sourceName: 'Active Directory',
              name: NAME,
              attribute: 'memberOf',
              entitlementId: 'ent-elsewhere',
              prior: PRIOR,
            },
          ],
        },
      }),
    )

    assert.equal(result.success, true, result.message)
    assert.ok(calls.some((c) => c.url.includes('filters=')), 'a stale cached id must fall back to a lookup')
    assert.equal(
      pathOf(writeCalls(calls)[0]),
      `${ENTITLEMENTS}/${ENTITLEMENT_ID}`,
      'the write must go to the entitlement on the declared source, not the cached one',
    )
  } finally {
    restore()
  }
})

test('entitlements deploy: reverts an overlay it applied and no longer declares', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    listPage([parentSource()]),
    listPage([liveEntitlement()]),
    ok({}),
    ok({}),
  ])
  try {
    const result = await deploy(
      deployContext([entitlementItem()], {
        priorRollbackData: {
          entries: [
            {
              sourceName: 'Active Directory',
              name: 'Retired-Group',
              attribute: 'memberOf',
              entitlementId: 'ent-retired',
              prior: { ...PRIOR, name: 'Retired-Group' },
            },
          ],
        },
      }),
    )

    assert.equal(result.success, true, result.message)
    const writes = writeCalls(calls)
    assert.equal(writes.length, 2)
    assert.equal(pathOf(writes[1]), `${ENTITLEMENTS}/ent-retired`)
    assert.equal(
      callsWithMethod(calls, 'DELETE').length,
      0,
      'undeclaring reverts the overlay — it never deletes the entitlement',
    )
  } finally {
    restore()
  }
})

test('entitlements deploy: reports a rejected overlay rather than throwing', async () => {
  const { restore } = recordFetch([
    TOKEN,
    listPage([parentSource()]),
    listPage([inSyncEntitlement()]),
    iscError(400, 'the segment id is not valid'),
  ])
  try {
    const result = await deploy(deployContext([entitlementItem()]))

    assert.equal(result.success, false)
    assert.ok(result.message.includes('the segment id is not valid'), result.message)
    assert.ok(result.rollbackData)
  } finally {
    restore()
  }
})
