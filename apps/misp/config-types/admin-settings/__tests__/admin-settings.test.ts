import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { assertSettingSaved, normalizeYesNo } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the MISP REST API via node:https inside mispApi, which
 * is impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'MISP.host_org_id', value: '1', force: 'no' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a non-dotted name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'hostorgid' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate accepts a deeply-nested dotted name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'Plugin.ZeroMQ_enable' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a missing value', async () => {
  const res = await validate(ctxOf([{ ...good, value: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_VALUE'))
})

test('validate rejects an invalid force value', async () => {
  const res = await validate(ctxOf([{ ...good, force: 'maybe' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FORCE'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, value: '2' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('assertSettingSaved throws when saved is false', () => {
  assert.throws(() => assertSettingSaved('MISP.host_org_id', { saved: false, message: 'nope' }))
})

test('assertSettingSaved does not throw on success', () => {
  assert.doesNotThrow(() => assertSettingSaved('MISP.host_org_id', { saved: true }))
})

test('normalizeYesNo handles strings and booleans', () => {
  assert.equal(normalizeYesNo('yes'), true)
  assert.equal(normalizeYesNo('no'), false)
  assert.equal(normalizeYesNo(true), true)
})
