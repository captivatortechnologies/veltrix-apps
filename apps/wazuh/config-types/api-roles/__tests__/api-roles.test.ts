import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, diffIdSets, resolveNamesToIds } from '../_shared'
import type { PipelineContext, CanvasItemSnapshot } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Wazuh REST API via
 * node:https inside wazuhApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'soc_analyst', policies: ['agents_readonly'], rules: [] }

test('validate rejects an empty canvas', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects an invalid name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'bad name!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate accepts a well-formed role', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns when a role has no permissions attached', async () => {
  const res = await validate(ctxOf([{ ...good, policies: [], rules: [] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_PERMISSIONS'))
})

test('validate flags a duplicate name as a warning, not an error', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('specFromItem reads comma-separated string tag lists', () => {
  const item = { id: 'i0', name: 'x', fields: { name: 'r', policies: 'a, b', rules: ['c'] } } as CanvasItemSnapshot
  const spec = specFromItem(item)
  assert.deepEqual(spec.policyNames, ['a', 'b'])
  assert.deepEqual(spec.ruleNames, ['c'])
})

test('diffIdSets computes exactly what to add/remove', () => {
  assert.deepEqual(diffIdSets([1, 2, 3], [2, 3, 4]), { toAdd: [4], toRemove: [1] })
  assert.deepEqual(diffIdSets([], [1]), { toAdd: [1], toRemove: [] })
  assert.deepEqual(diffIdSets([1], []), { toAdd: [], toRemove: [1] })
  assert.deepEqual(diffIdSets([1, 2], [1, 2]), { toAdd: [], toRemove: [] })
})

test('resolveNamesToIds resolves known names and throws listing every unknown one', () => {
  const byName = new Map([['a', 1], ['b', 2]])
  assert.deepEqual(resolveNamesToIds(['a', 'b'], byName, 'Policy'), [1, 2])
  assert.throws(() => resolveNamesToIds(['a', 'missing1', 'missing2'], byName, 'Policy'), /missing1, missing2/)
})
