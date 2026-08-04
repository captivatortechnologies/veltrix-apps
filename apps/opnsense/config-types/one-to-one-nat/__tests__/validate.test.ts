import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildOneToOneRuleBody, extractOneToOneRuleSpecs, isValidNatReflection, isValidType, snapshotLive } from '../_shared'
import type { LiveOneToOneRule } from '../../../lib/oneToOneNatApi'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'opnsense',
    customerId: 'cust-1',
    configTypeId: 'one-to-one-nat',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'opnsense',
      entityType: 'one-to-one-nat',
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

const validRule = { description: 'DMZ web server', interface: 'wan', source_net: '10.0.0.5', external: '203.0.113.10' }

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

test('requires a source network', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, source_net: '' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('source_net')))
})

test('requires an external address', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, external: '' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('external')))
})

test('rejects an invalid type', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, type: 'bogus' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('type')))
})

test('rejects an invalid nat reflection value', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, natreflection: 'maybe' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('natreflection')))
})

test('rejects a sequence outside 1-999999', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, sequence: 0 } }]))
  assert.equal(result.valid, false)
})

test('extractOneToOneRuleSpecs applies field defaults and falls back to item.name for a missing id', () => {
  const [spec] = extractOneToOneRuleSpecs(makeCtx([{ name: 'fallback-name', fields: { description: 'x' } }]).canvas)
  assert.equal(spec.itemId, 'fallback-name')
  assert.equal(spec.interfaceName, 'wan')
  assert.equal(spec.type, 'binat')
  assert.equal(spec.destinationNet, 'any')
  assert.equal(spec.sequence, 1)
})

test('isValidType / isValidNatReflection', () => {
  assert.equal(isValidType('binat'), true)
  assert.equal(isValidType('nat'), true)
  assert.equal(isValidType('bogus'), false)
  assert.equal(isValidNatReflection(''), true)
  assert.equal(isValidNatReflection('enable'), true)
  assert.equal(isValidNatReflection('maybe'), false)
})

test('buildOneToOneRuleBody resolves category uuids', () => {
  const [spec] = extractOneToOneRuleSpecs(
    makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, categories: ['DMZ'] } }]).canvas,
  )
  const body = buildOneToOneRuleBody(spec, ['uuid-1'])
  assert.equal(body.categories, 'uuid-1')
  assert.equal(body.external, '203.0.113.10')
  assert.equal(body.description, 'DMZ web server')
})

test('snapshotLive carries a searchRule row into a setRule-ready body', () => {
  const live: LiveOneToOneRule = { uuid: 'u1', enabled: '1', interface: 'wan', external: '203.0.113.10', description: 'x' }
  const body = snapshotLive(live)
  assert.equal(body.interface, 'wan')
  assert.equal(body.external, '203.0.113.10')
  assert.equal(body.description, 'x')
})
