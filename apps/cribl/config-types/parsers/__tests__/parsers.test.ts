import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { PARSER, PARSER_TYPES, buildParserRecord } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { id: 'csv-log-parser', worker_group: 'default', type: 'csv', lib: 'custom' }

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects a missing type', async () => {
  const res = await validate(ctxOf([{ ...good, type: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate rejects an unrecognized type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'yaml' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate accepts every documented parser type', async () => {
  for (const type of PARSER_TYPES) {
    const res = await validate(ctxOf([{ ...good, type }]))
    assert.equal(res.valid, true, `expected ${type} to be valid`)
  }
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildParserRecord builds the exact ParserLibEntry shape (additionalProperties: false)', () => {
  const spec = buildParserRecord({ ...good, description: 'CSV parser', tags: 'csv' }, {})
  assert.equal(spec.error, null)
  assert.deepEqual(spec.body, { id: 'csv-log-parser', type: 'csv', lib: 'custom', description: 'CSV parser', tags: 'csv' })
})

test('PARSER targets the lib/parsers collection', () => {
  assert.equal(PARSER.resource, 'lib/parsers')
})
