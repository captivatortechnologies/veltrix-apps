import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the MISP REST API via node:https inside mispApi, which
 * is impractical to mock here. Tests focus on validate.ts, which is pure and
 * network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.namespace ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { namespace: 'tlp', state: 'enabled', comment: 'Traffic Light Protocol' }

test('validate rejects a missing namespace', async () => {
  const res = await validate(ctxOf([{ ...good, namespace: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAMESPACE'))
})

test('validate rejects an unknown state', async () => {
  const res = await validate(ctxOf([{ ...good, state: 'on' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_STATE'))
})

test('validate warns on a duplicate namespace', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAMESPACE'))
})

test('validate accepts a good taxonomy for each state', async () => {
  for (const state of ['enabled', 'disabled']) {
    const res = await validate(ctxOf([{ ...good, state }]))
    assert.equal(res.valid, true, `expected ${state} to be valid`)
    assert.equal(res.errors.length, 0)
  }
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})
