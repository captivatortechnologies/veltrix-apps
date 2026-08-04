import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildShaperRuleBody, extractShaperRuleSpecs, isValidDirection, isValidProtocol, snapshotLive, strList } from '../_shared'
import type { LiveShaperRule } from '../../../lib/trafficShaperApi'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'opnsense',
    customerId: 'cust-1',
    configTypeId: 'traffic-shaper-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'opnsense',
      entityType: 'traffic-shaper-rules',
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

const validRule = { description: 'Guest downstream', interface: 'lan', target_name: 'Guest downstream cap' }

test('rejects an empty canvas', async () => {
  const result = await validate(makeCtx([]))
  assert.equal(result.valid, false)
  assert.equal(result.errors[0].code, 'empty_canvas')
})

test('validates a well-formed rule', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: validRule }]))
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
})

test('requires a description', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, description: '' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'required' && e.field.includes('description')))
})

test('requires a target_name', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, target_name: '' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('target_name')))
})

test('rejects an unrecognized protocol', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, proto: 'sctp' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('proto')))
})

test('rejects an invalid direction', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, direction: 'sideways' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('direction')))
})

test('rejects a sequence outside 1-1000000', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, sequence: 0 } }]))
  assert.equal(result.valid, false)
})

test('rejects an embedded comma in a comma-joined list field', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, source: ['10.0.0.1,10.0.0.2'] } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'invalid_entry'))
})

test('extractShaperRuleSpecs applies defaults and falls back to item.name for a missing id', () => {
  const [spec] = extractShaperRuleSpecs(makeCtx([{ name: 'fallback-name', fields: { description: 'x', target_name: 't' } }]).canvas)
  assert.equal(spec.itemId, 'fallback-name')
  assert.equal(spec.proto, 'ip')
  assert.equal(spec.interfaceName, 'wan')
  assert.deepEqual(spec.source, ['any'])
  assert.deepEqual(spec.destination, ['any'])
})

test('strList handles arrays, comma strings and blanks', () => {
  assert.deepEqual(strList(['a', ' b ']), ['a', 'b'])
  assert.deepEqual(strList(undefined), [])
})

test('isValidProtocol / isValidDirection', () => {
  assert.equal(isValidProtocol('tcp'), true)
  assert.equal(isValidProtocol('sctp'), false)
  assert.equal(isValidDirection(''), true)
  assert.equal(isValidDirection('in'), true)
  assert.equal(isValidDirection('sideways'), false)
})

test('buildShaperRuleBody joins list fields with commas and resolves the target uuid', () => {
  const [spec] = extractShaperRuleSpecs(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, source: ['10.0.0.0/24'] } }]).canvas)
  const body = buildShaperRuleBody(spec, 'target-uuid-1')
  assert.equal(body.source, '10.0.0.0/24')
  assert.equal(body.target, 'target-uuid-1')
  assert.equal(body.description, 'Guest downstream')
})

test('snapshotLive carries a searchRules row into a setRule-ready body', () => {
  const live: LiveShaperRule = { uuid: 'u1', enabled: '1', interface: 'lan', target: 'target-uuid-1', description: 'x' }
  const body = snapshotLive(live)
  assert.equal(body.interface, 'lan')
  assert.equal(body.target, 'target-uuid-1')
})
