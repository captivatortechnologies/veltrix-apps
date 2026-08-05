import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parseStringList, buildIndexTemplateBody } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the Elasticsearch REST API via node:https inside
 * soConsole, which is impractical to mock here. Tests focus on validate.ts and
 * the pure helpers in _shared.ts, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.templateName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

test('validate rejects an unsafe template name', async () => {
  const res = await validate(ctxOf([{ templateName: 'bad name/../x', indexPatterns: ['so-*'], numberOfShards: 1, numberOfReplicas: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate requires at least one index pattern', async () => {
  const res = await validate(ctxOf([{ templateName: 'so-custom', indexPatterns: [], numberOfShards: 1, numberOfReplicas: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PATTERNS'))
})

test('validate rejects an index pattern with unsafe characters', async () => {
  const res = await validate(ctxOf([{ templateName: 'so-custom', indexPatterns: ['so custom!'], numberOfShards: 1, numberOfReplicas: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PATTERN'))
})

test('validate rejects non-positive shard count and negative replica count', async () => {
  const res = await validate(ctxOf([{ templateName: 'so-custom', indexPatterns: ['so-*'], numberOfShards: 0, numberOfReplicas: -1 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SHARDS'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_REPLICAS'))
})

test('validate rejects an unsafe ILM policy name and component template name', async () => {
  const res = await validate(ctxOf([{
    templateName: 'so-custom', indexPatterns: ['so-*'], numberOfShards: 1, numberOfReplicas: 0,
    ilmPolicyName: 'bad name', composedOf: ['bad name'],
  }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ILM_NAME'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_COMPONENT_NAME'))
})

test('validate accepts a good template (numbers as strings too)', async () => {
  const res = await validate(ctxOf([{
    templateName: 'so-custom-syslog', indexPatterns: ['so-custom-syslog-*'],
    numberOfShards: '1', numberOfReplicas: '0', priority: '150', ilmPolicyName: 'so-logs-ilm',
  }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('parseStringList normalizes an array, a comma string and a newline string', () => {
  assert.deepEqual(parseStringList(['a', 'b', 'a']), ['a', 'b'])
  assert.deepEqual(parseStringList('a, b ,a'), ['a', 'b'])
  assert.deepEqual(parseStringList('a\nb\n'), ['a', 'b'])
  assert.deepEqual(parseStringList(undefined), [])
})

test('buildIndexTemplateBody sets flat index.lifecycle.name and omits priority/composed_of when unset', () => {
  const body = buildIndexTemplateBody({
    indexPatterns: ['so-custom-*'], numberOfShards: 2, numberOfReplicas: 1, ilmPolicyName: 'so-logs-ilm',
  })
  assert.deepEqual(body, {
    index_patterns: ['so-custom-*'],
    template: { settings: { number_of_shards: 2, number_of_replicas: 1, 'index.lifecycle.name': 'so-logs-ilm' } },
  })
})

test('buildIndexTemplateBody includes priority and composed_of when set', () => {
  const body = buildIndexTemplateBody({
    indexPatterns: ['so-custom-*'], numberOfShards: 1, numberOfReplicas: 0, priority: 200, composedOf: ['so-ecs-mappings'],
  })
  assert.deepEqual(body, {
    index_patterns: ['so-custom-*'],
    priority: 200,
    composed_of: ['so-ecs-mappings'],
    template: { settings: { number_of_shards: 1, number_of_replicas: 0 } },
  })
})
