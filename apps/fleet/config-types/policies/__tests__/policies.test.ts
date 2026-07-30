import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the Fleet REST API via node:https inside fleetApi,
 * which is impractical to mock here. Tests focus on validate.ts, which is pure
 * and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Firewall enabled',
  query: 'SELECT 1 FROM alf WHERE global_state >= 1;',
  description: 'Host firewall must be enabled',
  resolution: 'Enable the firewall in System Settings',
  platform: 'darwin',
  critical: 'yes',
  comment: 'baseline hardening',
}

test('validate rejects an unsafe policy name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'bad name/../x' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects an empty query body', async () => {
  const res = await validate(ctxOf([{ ...good, query: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_QUERY'))
})

test('validate rejects an unknown platform', async () => {
  const res = await validate(ctxOf([{ ...good, platform: 'solaris' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PLATFORM'))
})

test('validate rejects an unknown critical choice', async () => {
  const res = await validate(ctxOf([{ ...good, critical: 'maybe' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CRITICAL'))
})

test('validate accepts a good policy (resolution optional, all platforms)', async () => {
  const res = await validate(ctxOf([{ ...good, resolution: '', platform: 'all', critical: 'no' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate name but stays valid', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})
