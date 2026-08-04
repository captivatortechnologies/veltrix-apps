import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { normalizeItem, parseLabelList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the Fleet REST API via node:https inside fleetApi,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared.ts helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.identifier ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodFma = {
  sourceType: 'fleet_maintained',
  identifier: '3',
  platform: 'darwin',
  teamId: '2',
  selfService: 'yes',
}

const goodAppStore = {
  sourceType: 'app_store',
  identifier: '497799835',
  platform: 'ios',
  teamId: '2',
  selfService: 'yes',
}

test('validate rejects an unknown source type', async () => {
  const res = await validate(ctxOf([{ ...goodFma, sourceType: 'apt' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SOURCE'))
})

test('validate rejects a non-numeric Fleet-maintained identifier', async () => {
  const res = await validate(ctxOf([{ ...goodFma, identifier: 'slack' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_IDENTIFIER'))
})

test('validate accepts a non-numeric App Store identifier (Android package name)', async () => {
  const res = await validate(ctxOf([{ ...goodAppStore, identifier: 'com.slack.android' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a non-numeric team id', async () => {
  const res = await validate(ctxOf([{ ...goodFma, teamId: 'prod' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TEAM_ID'))
})

test('validate requires self-service when platform is android', async () => {
  const res = await validate(ctxOf([{ ...goodAppStore, platform: 'android', selfService: 'no' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'SELF_SERVICE_REQUIRED_ANDROID'))
})

test('validate requires an auto-update window when auto-update is enabled', async () => {
  const res = await validate(ctxOf([{ ...goodAppStore, autoUpdateEnabled: 'yes' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_AUTO_UPDATE_WINDOW'))
})

test('validate accepts a valid auto-update window', async () => {
  const res = await validate(
    ctxOf([{ ...goodAppStore, autoUpdateEnabled: 'yes', autoUpdateWindowStart: '00:00', autoUpdateWindowEnd: '04:00' }]),
  )
  assert.equal(res.valid, true)
})

test('validate warns when auto-update is set on a Fleet-maintained app', async () => {
  const res = await validate(ctxOf([{ ...goodFma, autoUpdateEnabled: 'yes', autoUpdateWindowStart: '00:00', autoUpdateWindowEnd: '04:00' }]))
  assert.ok(res.warnings.some((w) => w.code === 'AUTO_UPDATE_IGNORED'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared.ts -------------------------------------------------------------

test('normalizeItem defaults teamId to 0 and coerces booleans from yes/no', () => {
  const item = normalizeItem({ sourceType: 'fleet_maintained', identifier: '3' })
  assert.equal(item.teamId, 0)
  assert.equal(item.selfService, false)
  assert.equal(item.sourceType, 'fleet_maintained')
})

test('parseLabelList trims and drops empty entries', () => {
  assert.deepEqual(parseLabelList(' Productivity ,, Security '), ['Productivity', 'Security'])
})
