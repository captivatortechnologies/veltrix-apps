import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { GLOBAL_VAR, GLOBAL_VAR_TYPES, buildGlobalVarRecord } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.id ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { id: 'dynamic_threshold', worker_group: 'default', type: 'expression', lib: 'custom', value: 'rate * 1.5' }

test('validate rejects a missing id', async () => {
  const res = await validate(ctxOf([{ ...good, id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ID'))
})

test('validate rejects an unrecognized type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'symbol' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate rejects args that are not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, args: '{ not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID'))
})

test('validate accepts every documented variable type', async () => {
  for (const type of GLOBAL_VAR_TYPES) {
    const res = await validate(ctxOf([{ ...good, type }]))
    assert.equal(res.valid, true, `expected ${type} to be valid`)
  }
})

test('validate accepts a good expression variable with args', async () => {
  const res = await validate(ctxOf([{ ...good, args: '[{"type":"number","name":"rate"}]' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('buildGlobalVarRecord defaults type to any and lib to custom', () => {
  const spec = buildGlobalVarRecord({ id: 'x', value: '1' }, {})
  assert.equal(spec.body?.type, 'any')
  assert.equal(spec.body?.lib, 'custom')
})

test('buildGlobalVarRecord parses args into an array', () => {
  const spec = buildGlobalVarRecord({ ...good, args: '[{"type":"number","name":"rate"}]' }, {})
  assert.deepEqual(spec.body?.args, [{ type: 'number', name: 'rate' }])
})

test('GLOBAL_VAR targets the lib/vars collection', () => {
  assert.equal(GLOBAL_VAR.resource, 'lib/vars')
})
