import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildIndexSetBody,
  buildRotationStrategy,
  buildRetentionStrategy,
  indexSetsFromList,
  findIndexSet,
  ROTATION_STRATEGIES,
  RETENTION_STRATEGIES,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Graylog REST API via
 * node:https inside graylogApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers (strategy building, body assembly,
 * identity matching).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.title ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  title: 'Firewall',
  description: 'firewall logs',
  index_prefix: 'firewall',
  rotation_strategy: 'msgcount',
  rotation_value: '20000000',
  retention_strategy: 'delete',
  retention_max_indices: 20,
  shards: 4,
  replicas: 0,
}

test('validate accepts a well-formed index set', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing title', async () => {
  const res = await validate(ctxOf([{ ...good, title: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TITLE'))
})

test('validate rejects an invalid index prefix', async () => {
  const res = await validate(ctxOf([{ ...good, index_prefix: 'Firewall Logs' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_INDEX_PREFIX'))
})

test('validate rejects an unknown rotation strategy', async () => {
  const res = await validate(ctxOf([{ ...good, rotation_strategy: 'weekly' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROTATION_STRATEGY'))
})

test('validate rejects a non-positive message-count rotation value', async () => {
  const res = await validate(ctxOf([{ ...good, rotation_value: '0' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROTATION_VALUE'))
})

test('validate rejects a bad ISO-8601 period for time rotation', async () => {
  const res = await validate(ctxOf([{ ...good, rotation_strategy: 'time', rotation_value: '1 day' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROTATION_PERIOD'))
})

test('validate accepts a valid ISO-8601 period for time rotation', async () => {
  const res = await validate(ctxOf([{ ...good, rotation_strategy: 'time', rotation_value: 'P1D' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a non-positive retention count (non-noop)', async () => {
  const res = await validate(ctxOf([{ ...good, retention_max_indices: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RETENTION_VALUE'))
})

test('validate allows the no-op retention strategy without a count', async () => {
  const res = await validate(ctxOf([{ ...good, retention_strategy: 'none', retention_max_indices: 0 }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate index-set title', async () => {
  const res = await validate(ctxOf([good, { ...good, index_prefix: 'firewall2' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TITLE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildRotationStrategy sets the FQCN as class AND type discriminator', () => {
  const r = buildRotationStrategy('msgcount', '5000')
  assert.equal(r.clazz, ROTATION_STRATEGIES.msgcount)
  assert.equal(r.config.type, ROTATION_STRATEGIES.msgcount)
  assert.equal(r.config.max_docs_per_index, 5000)

  const t = buildRotationStrategy('time', 'P7D')
  assert.equal(t.config.type, ROTATION_STRATEGIES.time)
  assert.equal(t.config.rotation_period, 'P7D')
})

test('buildRetentionStrategy carries max_number_of_indices + FQCN type', () => {
  const d = buildRetentionStrategy('delete', '30')
  assert.equal(d.clazz, RETENTION_STRATEGIES.delete)
  assert.equal(d.config.type, RETENTION_STRATEGIES.delete)
  assert.equal(d.config.max_number_of_indices, 30)
})

test('buildIndexSetBody assembles required boilerplate + strategies', () => {
  const { body, error } = buildIndexSetBody(good)
  assert.equal(error, undefined)
  assert.equal(body?.title, 'Firewall')
  assert.equal(body?.index_prefix, 'firewall')
  assert.equal(body?.rotation_strategy_class, ROTATION_STRATEGIES.msgcount)
  assert.equal(body?.retention_strategy_class, RETENTION_STRATEGIES.delete)
  assert.equal(body?.writable, true)
  assert.equal(body?.use_legacy_rotation, true)
  assert.equal(body?.index_analyzer, 'standard')
  assert.equal(body?.shards, 4)
})

test('indexSetsFromList + findIndexSet match by title from the envelope', () => {
  const live = indexSetsFromList({ total: 2, index_sets: [{ id: '1', title: 'Firewall' }, { id: '2', title: 'DNS' }] })
  assert.equal(live.length, 2)
  assert.equal(findIndexSet(live, 'DNS')?.id, '2')
  assert.equal(findIndexSet(live, 'Nope'), null)
})
