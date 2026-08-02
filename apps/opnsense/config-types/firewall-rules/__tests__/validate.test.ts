import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildFilterRuleBody,
  extractFilterRuleSpecs,
  isValidAction,
  isValidDirection,
  isValidIpProtocol,
  isValidStateType,
  snapshotLive,
  strList,
} from '../_shared'
import type { LiveFilterRule } from '../../../lib/opnsenseApi'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'opnsense',
    customerId: 'cust-1',
    configTypeId: 'firewall-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'opnsense',
      entityType: 'firewall-rules',
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

const validRule = { description: 'Allow LAN to WAN', action: 'pass', direction: 'out', interface: ['lan'] }

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

test('rejects an invalid action', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, action: 'allow' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('action') && e.code === 'invalid_value'))
})

test('rejects an invalid direction', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, direction: 'sideways' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('direction')))
})

test('rejects the deprecated inet46 ip protocol (not offered)', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, ipprotocol: 'inet46' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('ipprotocol')))
})

test('rejects a sequence outside 1-999999', async () => {
  const tooLow = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, sequence: 0 } }]))
  assert.equal(tooLow.valid, false)
  const tooHigh = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, sequence: 1000000 } }]))
  assert.equal(tooHigh.valid, false)
})

test('rejects an embedded comma in a comma-joined list field', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, interface: ['lan,wan'] } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'invalid_entry'))
})

test('warns (does not error) when multiple interfaces make a floating rule', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, interface: ['lan', 'wan'] } }]))
  assert.equal(result.valid, true)
  assert.ok(result.warnings.some((w) => w.code === 'floating_rule'))
})

test('extractFilterRuleSpecs applies field defaults and falls back to item.name for a missing id', () => {
  const [spec] = extractFilterRuleSpecs(makeCtx([{ name: 'fallback-name', fields: { description: 'x' } }]).canvas)
  assert.equal(spec.itemId, 'fallback-name')
  assert.equal(spec.action, 'pass')
  assert.equal(spec.direction, 'in')
  assert.equal(spec.ipprotocol, 'inet')
  assert.deepEqual(spec.sourceNet, ['any'])
  assert.deepEqual(spec.destinationNet, ['any'])
  assert.equal(spec.statetype, 'keep')
  assert.equal(spec.sequence, 1)
})

test('strList handles arrays, comma strings and blanks', () => {
  assert.deepEqual(strList(['a', ' b ', '']), ['a', 'b'])
  assert.deepEqual(strList('a, b'), ['a', 'b'])
  assert.deepEqual(strList(undefined), [])
})

test('isValidAction / isValidDirection / isValidIpProtocol / isValidStateType', () => {
  assert.equal(isValidAction('pass'), true)
  assert.equal(isValidAction('allow'), false)
  assert.equal(isValidDirection('any'), true)
  assert.equal(isValidDirection('sideways'), false)
  assert.equal(isValidIpProtocol('inet'), true)
  assert.equal(isValidIpProtocol('inet46'), false)
  assert.equal(isValidStateType('synproxy'), true)
  assert.equal(isValidStateType('bogus'), false)
})

test('buildFilterRuleBody joins list fields with commas and resolves category uuids', () => {
  const [spec] = extractFilterRuleSpecs(
    makeCtx([{ id: 'a', name: 'a', fields: { description: 'x', interface: ['lan', 'opt1'], source_net: ['10.0.0.0/24'] } }]).canvas,
  )
  const body = buildFilterRuleBody(spec, ['uuid-1', 'uuid-2'])
  assert.equal(body.interface, 'lan,opt1')
  assert.equal(body.source_net, '10.0.0.0/24')
  assert.equal(body.categories, 'uuid-1,uuid-2')
  assert.equal(body.description, 'x')
})

test('snapshotLive carries a searchRule row into a setRule-ready body', () => {
  const live: LiveFilterRule = { uuid: 'u1', enabled: '1', action: 'pass', interface: 'lan', direction: 'out', description: 'x' }
  const body = snapshotLive(live)
  assert.equal(body.action, 'pass')
  assert.equal(body.interface, 'lan')
  assert.equal(body.direction, 'out')
  assert.equal(body.description, 'x')
})
