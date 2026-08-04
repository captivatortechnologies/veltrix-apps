import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildPipeBody, extractPipeSpecs, isValidBandwidthMetric, isValidMask, isValidScheduler, pipeKey, snapshotLive } from '../_shared'
import type { LivePipe } from '../../../lib/trafficShaperApi'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'opnsense',
    customerId: 'cust-1',
    configTypeId: 'traffic-shaper-pipes',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'opnsense',
      entityType: 'traffic-shaper-pipes',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const validPipe = { description: 'Guest downstream cap', bandwidth: 10, bandwidthMetric: 'Mbit' }

test('rejects an empty canvas', async () => {
  const result = await validate(makeCtx([]))
  assert.equal(result.valid, false)
  assert.equal(result.errors[0].code, 'empty_canvas')
})

test('validates a well-formed pipe', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: validPipe }]))
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
})

test('requires a description', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { description: '', bandwidth: 10, bandwidthMetric: 'Mbit' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('description') && e.code === 'required'))
})

test('rejects a duplicate description (case-insensitive)', async () => {
  const result = await validate(
    makeCtx([
      { id: 'a', name: 'a', fields: validPipe },
      { id: 'b', name: 'b', fields: { ...validPipe, description: 'GUEST DOWNSTREAM CAP' } },
    ]),
  )
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'duplicate_name'))
})

test('rejects a non-positive bandwidth', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validPipe, bandwidth: 0 } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('bandwidth')))
})

test('rejects an invalid bandwidth metric', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validPipe, bandwidthMetric: 'Tbit' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('bandwidthMetric')))
})

test('rejects CoDel and PIE enabled together', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validPipe, codel_enable: true, pie_enable: true } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'conflicting_value'))
})

test('extractPipeSpecs applies defaults', () => {
  const [spec] = extractPipeSpecs(makeCtx([{ id: 'a', name: 'a', fields: { description: 'x', bandwidth: 5 } }]).canvas)
  assert.equal(spec.bandwidthMetric, 'Kbit')
  assert.equal(spec.mask, 'none')
  assert.equal(spec.enabled, true)
})

test('pipeKey is case-insensitive', () => {
  assert.equal(pipeKey('Guest Cap'), pipeKey('guest cap'))
})

test('isValidBandwidthMetric / isValidMask / isValidScheduler', () => {
  assert.equal(isValidBandwidthMetric('Mbit'), true)
  assert.equal(isValidBandwidthMetric('Tbit'), false)
  assert.equal(isValidMask('src-ip'), true)
  assert.equal(isValidMask('bogus'), false)
  assert.equal(isValidScheduler(''), true)
  assert.equal(isValidScheduler('fq_codel'), true)
  assert.equal(isValidScheduler('bogus'), false)
})

test('buildPipeBody never includes a number/origin field', () => {
  const [spec] = extractPipeSpecs(makeCtx([{ id: 'a', name: 'a', fields: validPipe }]).canvas)
  const body = buildPipeBody(spec)
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'number'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'origin'), false)
  assert.equal(body.bandwidth, '10')
  assert.equal(body.bandwidthMetric, 'Mbit')
})

test('snapshotLive carries a searchPipes row into a setPipe-ready body', () => {
  const live: LivePipe = { uuid: 'u1', description: 'Guest downstream cap', bandwidth: '10', bandwidthMetric: 'Mbit', enabled: '1' }
  assert.equal(snapshotLive(live).bandwidth, '10')
})
