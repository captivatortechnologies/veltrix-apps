import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { EVENT_BREAKER, parseRules, buildEventBreakerRecord } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  id: 'access-logs-v1',
  worker_group: 'default',
  lib: 'custom',
  min_raw_length: 256,
  rules: '[{"name":"nginx","type":"regex","condition":"true","eventBreakerRegex":"/\\n/"}]',
}

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects rules that are not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, rules: '{ not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate rejects rules that are not an array', async () => {
  const res = await validate(ctxOf([{ ...good, rules: '{ "name": "x" }' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate warns on an empty rules array', async () => {
  const res = await validate(ctxOf([{ ...good, rules: '[]' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_RULES'))
})

test('validate accepts a good ruleset', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
  assert.equal(res.warnings.length, 0)
})

test('parseRules accepts a JSON array and rejects non-arrays', () => {
  assert.equal(parseRules('[]').error, null)
  assert.ok(parseRules('{}').error)
  assert.ok(parseRules('  ').error)
})

test('buildEventBreakerRecord builds the exact EventBreakerRuleset shape', () => {
  const spec = buildEventBreakerRecord({ ...good, description: 'desc', tags: 'nginx' }, {})
  assert.equal(spec.error, null)
  assert.deepEqual(spec.body, {
    id: 'access-logs-v1',
    lib: 'custom',
    rules: JSON.parse(good.rules),
    description: 'desc',
    tags: 'nginx',
    minRawLength: 256,
  })
})

test('EVENT_BREAKER targets the lib/breakers collection', () => {
  assert.equal(EVENT_BREAKER.resource, 'lib/breakers')
})
