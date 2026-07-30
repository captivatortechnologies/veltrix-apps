import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the Fleet REST API via node:https inside fleetApi,
 * which is impractical to mock here. Tests focus on validate.ts, which is pure
 * and network-free. agent-config is a singleton: agentOptions must be valid JSON.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: 'agent-options', fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  agentOptions: '{"config":{"options":{"logger_plugin":"tls"}}}',
  comment: 'baseline agent options',
}

test('validate rejects invalid JSON agent options', async () => {
  const res = await validate(ctxOf([{ ...good, agentOptions: '{not valid json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_JSON'))
})

test('validate rejects empty agent options', async () => {
  const res = await validate(ctxOf([{ ...good, agentOptions: '   ' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_AGENT_OPTIONS'))
})

test('validate accepts valid JSON agent options', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns when more than one item (singleton)', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'SINGLETON'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})
