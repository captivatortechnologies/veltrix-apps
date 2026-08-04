import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { enabledFromGet, normalizeBool } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The mutating handlers apply over the Vectra REST API via node:https inside
 * vectraApi, which is impractical to mock here. Tests focus on validate.ts and the
 * pure _shared helpers (state parsing, bool coercion).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.device_serial ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { device_serial: 'SN-12345', enabled: true }

// --- validate ---------------------------------------------------------------

test('validate accepts a good sensor item', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing device_serial', async () => {
  const res = await validate(ctxOf([{ ...good, device_serial: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DEVICE_SERIAL'))
})

test('validate warns on a duplicate device_serial', async () => {
  const res = await validate(ctxOf([good, { ...good, enabled: false }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_DEVICE_SERIAL'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('enabledFromGet reads desired_state, state or enabled, tolerant of type', () => {
  assert.equal(enabledFromGet({ desired_state: true }), true)
  assert.equal(enabledFromGet({ state: 'disabled' }), false)
  assert.equal(enabledFromGet({ enabled: 'enabled' }), true)
  assert.equal(enabledFromGet({}), null)
  assert.equal(enabledFromGet(null), null)
})

test('normalizeBool coerces common truthy values', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool('enabled'), true)
  assert.equal(normalizeBool('false'), false)
  assert.equal(normalizeBool(undefined), false)
})
