import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import validate from '../validate'
import { buildEdgeWorkerBody, edgeWorkerPath, edgeWorkersFromResponse, findEdgeWorker, readEdgeWorkerFields } from '../_shared'

/**
 * The deploy/rollback/drift handlers apply over the EdgeWorkers API via fetch
 * inside akamaiApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers (network-free). The EdgeGrid
 * signer itself is covered in lib/__tests__/akamaiApi.test.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodItem = { name: 'my_edgeworker', groupId: 12345, resourceTierId: 200 }

// --- validate ---------------------------------------------------------------

test('validate accepts a good EdgeWorker', async () => {
  const res = await validate(ctxOf([goodItem]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...goodItem, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a non-positive group id', async () => {
  const res = await validate(ctxOf([{ ...goodItem, groupId: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_GROUP_ID'))
})

test('validate rejects a non-positive resource tier id', async () => {
  const res = await validate(ctxOf([{ ...goodItem, resourceTierId: -1 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RESOURCE_TIER'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([goodItem, { ...goodItem }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('edgeWorkersFromResponse unwraps the { edgeWorkerIds: [...] } envelope', () => {
  assert.deepEqual(edgeWorkersFromResponse({ edgeWorkerIds: [{ name: 'a' }] }), [{ name: 'a' }])
  assert.deepEqual(edgeWorkersFromResponse([{ name: 'b' }]), [{ name: 'b' }])
  assert.deepEqual(edgeWorkersFromResponse(null), [])
})

test('findEdgeWorker matches by name case-insensitively', () => {
  const list = [{ name: 'Alpha', edgeWorkerId: 1 }, { name: 'Beta', edgeWorkerId: 2 }]
  assert.equal(findEdgeWorker(list, 'beta')?.edgeWorkerId, 2)
  assert.equal(findEdgeWorker(list, 'missing'), null)
})

test('readEdgeWorkerFields normalizes an item', () => {
  assert.deepEqual(readEdgeWorkerFields(goodItem), { name: 'my_edgeworker', groupId: 12345, resourceTierId: 200 })
})

test('buildEdgeWorkerBody shapes the create/update body', () => {
  assert.deepEqual(buildEdgeWorkerBody(readEdgeWorkerFields(goodItem)), { name: 'my_edgeworker', groupId: 12345, resourceTierId: 200 })
})

test('edgeWorkerPath shapes the endpoint', () => {
  assert.equal(edgeWorkerPath(42), '/edgeworkers/v1/ids/42')
})
