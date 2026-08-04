import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, isValidResource, toPolicyBody, policyBodyEquals } from '../_shared'
import type { PipelineContext, CanvasItemSnapshot } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Wazuh REST API via
 * node:https inside wazuhApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'agents_readonly', effect: 'allow', actions: ['agent:read'], resources: ['agent:id:*'] }

test('validate rejects an empty canvas', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects an invalid name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'bad name!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a name over 64 chars', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'a'.repeat(65) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate requires at least one action', async () => {
  const res = await validate(ctxOf([{ ...good, actions: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ACTIONS'))
})

test('validate rejects a malformed action', async () => {
  const res = await validate(ctxOf([{ ...good, actions: ['agentread'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION'))
})

test('validate requires at least one resource', async () => {
  const res = await validate(ctxOf([{ ...good, resources: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_RESOURCES'))
})

test('validate rejects a malformed resource', async () => {
  const res = await validate(ctxOf([{ ...good, resources: ['not-a-resource'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RESOURCE'))
})

test('validate accepts a well-formed policy', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate flags a duplicate name as a warning, not an error', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('isValidResource accepts wildcards and &-combined dimensions', () => {
  assert.equal(isValidResource('*:*:*'), true)
  assert.equal(isValidResource('agent:id:001&group:id:default'), true)
  assert.equal(isValidResource('agent:id'), false)
  assert.equal(isValidResource(''), false)
})

test('specFromItem normalizes effect to allow/deny and reads tag lists', () => {
  const item = { id: 'i0', name: 'x', fields: { name: 'p', effect: 'DENY', actions: 'agent:read, agent:delete', resources: ['agent:id:*'] } } as CanvasItemSnapshot
  const spec = specFromItem(item)
  assert.equal(spec.effect, 'deny')
  assert.deepEqual(spec.actions, ['agent:read', 'agent:delete'])
})

test('toPolicyBody shapes the wire body', () => {
  const body = toPolicyBody(specFromItem({ id: 'i0', name: 'x', fields: good } as CanvasItemSnapshot))
  assert.deepEqual(body, { name: 'agents_readonly', policy: { actions: ['agent:read'], resources: ['agent:id:*'], effect: 'allow' } })
})

test('policyBodyEquals is order-insensitive', () => {
  const a = { actions: ['a', 'b'], resources: ['r1'], effect: 'allow' }
  const b = { actions: ['b', 'a'], resources: ['r1'], effect: 'allow' }
  assert.equal(policyBodyEquals(a, b), true)
  assert.equal(policyBodyEquals(a, { ...b, effect: 'deny' }), false)
})
