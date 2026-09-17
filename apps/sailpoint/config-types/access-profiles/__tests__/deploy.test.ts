// ============================================================================
// deploy for ISC access profiles.
//
// An access profile is the bundle of entitlements a role hands out, so the update
// path is the dangerous one: it is a JSON-Patch that replaces `/entitlements`
// wholesale, and the rollback entry it records is the only way back to whatever
// the tenant had. The source is immutable — a same-named profile on a different
// source must be refused, not silently re-parented.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  bodyOf,
  deployContext,
  listPage,
  ok,
  pathOf,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeIsc'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, liveProfile, profileItem } from './fixtures'

registerCollectionDeployContract({
  label: 'access-profiles',
  handler: deploy,
  listPath: '/v3/access-profiles',
  createPath: '/v3/access-profiles',
  updatePath: `/v3/access-profiles/${LIVE_ID}`,
  updateMethod: 'PATCH',
  item: profileItem(),
  live: liveProfile(),
  assertCreateBody: (body) => {
    assert.deepEqual(body, {
      name: NAME,
      description: 'Read/write access to the finance database',
      enabled: true,
      requestable: true,
      owner: { type: 'IDENTITY', id: 'id-owner-current' },
      source: { type: 'SOURCE', id: 'src-finance-db' },
      entitlements: [
        { type: 'ENTITLEMENT', id: 'ent-db-read' },
        { type: 'ENTITLEMENT', id: 'ent-db-write' },
      ],
    })
  },
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
    assert.equal(entry.name, NAME)
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Profile', existed: false, id: 'ap-retired' },
    deletePath: '/v3/access-profiles/ap-retired',
  },
})

test('access-profiles deploy: refuses to re-parent a profile onto a different source', async () => {
  // The source is immutable in ISC. Patching the name onto someone else's profile
  // would silently hand out a different source's entitlements.
  const { calls, restore } = recordFetch([TOKEN, listPage([liveProfile({ source: { id: 'src-somewhere-else' } })])])
  try {
    const result = await deploy(deployContext([profileItem()]))

    assert.equal(result.success, false)
    assert.match(result.message, /source is immutable/)
    assert.equal(writeCalls(calls).length, 0, 'a refused re-parent must not write anything')
  } finally {
    restore()
  }
})

test('access-profiles deploy: patches every managed field, leaving the source alone', async () => {
  const { calls, restore } = recordFetch([TOKEN, listPage([liveProfile()]), ok({})])
  try {
    await deploy(deployContext([profileItem()]))

    const patch = writeCalls(calls)[0]
    assert.equal(pathOf(patch), `/v3/access-profiles/${LIVE_ID}`)
    assert.equal(patch.contentType, 'application/json-patch+json')
    const ops = bodyOf(patch) as Array<{ op: string; path: string; value: unknown }>
    assert.deepEqual(
      ops.map((o) => o.path),
      ['/name', '/description', '/enabled', '/requestable', '/owner', '/entitlements'],
    )
    assert.deepEqual(ops.find((o) => o.path === '/entitlements')?.value, [
      { type: 'ENTITLEMENT', id: 'ent-db-read' },
      { type: 'ENTITLEMENT', id: 'ent-db-write' },
    ])
  } finally {
    restore()
  }
})

test('access-profiles deploy: matches a renamed profile by its recorded id', async () => {
  // The canvas renamed the profile. Without the id recorded last time, the
  // name lookup misses and deploy creates a duplicate instead of renaming.
  const renamed = { ...profileItem({ name: 'Finance DB RW (renamed)' }), id: 'canvas-item-1' }
  const { calls, restore } = recordFetch([TOKEN, listPage([liveProfile()]), ok({})])
  try {
    const result = await deploy(
      deployContext([renamed], {
        priorRollbackData: { entries: [{ itemId: 'canvas-item-1', name: NAME, existed: true, id: LIVE_ID }] },
      }),
    )

    assert.equal(result.success, true, result.message)
    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH')
    assert.equal(pathOf(writes[0]), `/v3/access-profiles/${LIVE_ID}`)
  } finally {
    restore()
  }
})
