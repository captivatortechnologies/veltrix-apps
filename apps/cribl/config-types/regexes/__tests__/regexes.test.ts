import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { REGEX, buildRegexRecord } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { id: 'ipv4-address', worker_group: 'default', lib: 'custom', regex: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b' }

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects an empty regex', async () => {
  const res = await validate(ctxOf([{ ...good, regex: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate accepts a good regex entry', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate id within the same worker group', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ID'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildRegexRecord builds the full body with optional fields', () => {
  const spec = buildRegexRecord({ ...good, description: 'IPv4 matcher', sample_data: '10.0.0.1', tags: 'network' }, {})
  assert.equal(spec.error, null)
  assert.deepEqual(spec.body, {
    id: 'ipv4-address',
    regex: good.regex,
    lib: 'custom',
    description: 'IPv4 matcher',
    sampleData: '10.0.0.1',
    tags: 'network',
  })
})

test('buildRegexRecord defaults lib to custom', () => {
  const spec = buildRegexRecord({ id: 'x', regex: 'a+' }, {})
  assert.equal(spec.body?.lib, 'custom')
})

test('REGEX targets the lib/regex collection', () => {
  assert.equal(REGEX.resource, 'lib/regex')
})
