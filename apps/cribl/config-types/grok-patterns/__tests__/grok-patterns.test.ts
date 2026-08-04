import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { GROK, buildGrokRecord } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { id: 'custom-app-patterns', worker_group: 'default', content: 'APP_LOG %{GREEDYDATA:message}' }

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects empty content', async () => {
  const res = await validate(ctxOf([{ ...good, content: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate accepts a good pattern file', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildGrokRecord builds a minimal body', () => {
  const spec = buildGrokRecord(good, {})
  assert.equal(spec.error, null)
  assert.deepEqual(spec.body, { id: 'custom-app-patterns', content: good.content })
})

test('GROK targets the lib/grok collection', () => {
  assert.equal(GROK.resource, 'lib/grok')
})
