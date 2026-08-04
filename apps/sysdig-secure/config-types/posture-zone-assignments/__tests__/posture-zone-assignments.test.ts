import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { normalizeBoolean, splitOrderedList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.zoneName ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { zoneName: 'Production AWS', enabled: true, policyNames: 'CIS AWS Benchmark, Internal Baseline' }

test('validate rejects a missing zone name', async () => {
  const res = await validate(ctxOf([{ ...good, zoneName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ZONE_NAME'))
})

test('validate rejects a duplicate zone name', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_ZONE'))
})

test('validate requires at least one policy name when enabled', async () => {
  const res = await validate(ctxOf([{ ...good, policyNames: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_POLICY_NAMES'))
})

test('validate allows empty policy names when disabled', async () => {
  const res = await validate(ctxOf([{ ...good, enabled: false, policyNames: '' }]))
  assert.equal(res.valid, true)
})

test('validate accepts a good assignment', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('splitOrderedList preserves declared order', () => {
  assert.deepEqual(splitOrderedList('B, A, C'), ['B', 'A', 'C'])
})

test('normalizeBoolean defaults and reads common truthy/falsy forms', () => {
  assert.equal(normalizeBoolean(undefined, true), true)
  assert.equal(normalizeBoolean('no', true), false)
})
