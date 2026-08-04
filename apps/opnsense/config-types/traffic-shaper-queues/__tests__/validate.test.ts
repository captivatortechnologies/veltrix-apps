import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildQueueBody, extractQueueSpecs, isValidMask, queueKey, snapshotLive } from '../_shared'
import type { LiveQueue } from '../../../lib/trafficShaperApi'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'opnsense',
    customerId: 'cust-1',
    configTypeId: 'traffic-shaper-queues',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'opnsense',
      entityType: 'traffic-shaper-queues',
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

const validQueue = { description: 'Guest queue', pipe_name: 'Guest downstream cap', weight: 50 }

test('rejects an empty canvas', async () => {
  const result = await validate(makeCtx([]))
  assert.equal(result.valid, false)
  assert.equal(result.errors[0].code, 'empty_canvas')
})

test('validates a well-formed queue', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: validQueue }]))
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
})

test('requires a description', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { description: '', pipe_name: 'x' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('description') && e.code === 'required'))
})

test('requires a pipe_name', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { description: 'x' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('pipe_name')))
})

test('rejects a weight outside 1-100', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validQueue, weight: 0 } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('weight')))
})

test('rejects CoDel and PIE enabled together', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validQueue, codel_enable: true, pie_enable: true } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'conflicting_value'))
})

test('extractQueueSpecs applies defaults', () => {
  const [spec] = extractQueueSpecs(makeCtx([{ id: 'a', name: 'a', fields: { description: 'x', pipe_name: 'p' } }]).canvas)
  assert.equal(spec.weight, 100)
  assert.equal(spec.mask, 'none')
})

test('queueKey is case-insensitive', () => {
  assert.equal(queueKey('Guest Queue'), queueKey('guest queue'))
})

test('isValidMask', () => {
  assert.equal(isValidMask('dst-ip6'), true)
  assert.equal(isValidMask('bogus'), false)
})

test('buildQueueBody resolves the pipe reference to the supplied uuid', () => {
  const [spec] = extractQueueSpecs(makeCtx([{ id: 'a', name: 'a', fields: validQueue }]).canvas)
  const body = buildQueueBody(spec, 'pipe-uuid-1')
  assert.equal(body.pipe, 'pipe-uuid-1')
  assert.equal(body.weight, '50')
  assert.equal(body.description, 'Guest queue')
})

test('snapshotLive carries a searchQueues row into a setQueue-ready body', () => {
  const live: LiveQueue = { uuid: 'u1', description: 'Guest queue', pipe: 'pipe-uuid-1', weight: '50', enabled: '1' }
  assert.equal(snapshotLive(live).pipe, 'pipe-uuid-1')
})
