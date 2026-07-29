import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the Elasticsearch REST API via node:https inside
 * soConsole, which is impractical to mock here. Tests focus on validate.ts,
 * which is pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.policyName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

test('validate rejects an unsafe policy name', async () => {
  const res = await validate(ctxOf([{ policyName: 'bad name/../x', hotMaxAgeDays: 7, deleteMinAgeDays: 30 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects retention shorter than the hot max age', async () => {
  const res = await validate(ctxOf([{ policyName: 'so-logs-ilm', hotMaxAgeDays: 30, deleteMinAgeDays: 7 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'RETENTION_TOO_SHORT'))
})

test('validate rejects non-positive numbers', async () => {
  const res = await validate(ctxOf([{ policyName: 'so-logs-ilm', hotMaxAgeDays: 0, deleteMinAgeDays: -5 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_HOT_AGE'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RETENTION'))
})

test('validate accepts a good policy (numbers as strings too)', async () => {
  const res = await validate(ctxOf([
    { policyName: 'so-logs-ilm', hotMaxAgeDays: '7', hotMaxPrimaryShardSizeGb: '50', deleteMinAgeDays: '30' },
  ]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a non-positive optional shard size when set', async () => {
  const res = await validate(ctxOf([
    { policyName: 'so-logs-ilm', hotMaxAgeDays: 7, hotMaxPrimaryShardSizeGb: 0, deleteMinAgeDays: 30 },
  ]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SHARD_SIZE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})
