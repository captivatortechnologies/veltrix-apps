import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildSourceNatRuleBody, extractSourceNatRuleSpecs, isValidIpProtocol, modeHonorsManualRules, snapshotLive, strList } from '../_shared'
import type { LiveSourceNatRule } from '../../../lib/opnsenseApi'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'opnsense',
    customerId: 'cust-1',
    configTypeId: 'source-nat',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'opnsense',
      entityType: 'source-nat',
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

const validRule = { description: 'NAT LAN to WAN1', interface: 'lan', target: '203.0.113.5' }

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

test('requires an interface', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, interface: '' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('interface') && e.code === 'required'))
})

test('rejects a comma-separated interface (single value only)', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, interface: 'lan,wan' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('interface') && e.code === 'invalid_entry'))
})

test('rejects an invalid ip protocol', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, ipprotocol: 'inet46' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('ipprotocol')))
})

test('rejects a sequence outside 1-999999', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, sequence: -1 } }]))
  assert.equal(result.valid, false)
})

test('warns when nonat is combined with a target', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRule, nonat: true } }]))
  assert.equal(result.valid, true)
  assert.ok(result.warnings.some((w) => w.code === 'ignored_field'))
})

test('extractSourceNatRuleSpecs applies field defaults and falls back to item.name for a missing id', () => {
  const [spec] = extractSourceNatRuleSpecs(makeCtx([{ name: 'fallback-name', fields: { description: 'x' } }]).canvas)
  assert.equal(spec.itemId, 'fallback-name')
  assert.equal(spec.interfaceName, 'lan')
  assert.equal(spec.ipprotocol, 'inet')
  assert.equal(spec.sourceNet, 'any')
  assert.equal(spec.destinationNet, 'any')
  assert.equal(spec.sequence, 1)
})

test('strList handles arrays, comma strings and blanks', () => {
  assert.deepEqual(strList(['a', ' b ']), ['a', 'b'])
  assert.deepEqual(strList('a, b'), ['a', 'b'])
  assert.deepEqual(strList(undefined), [])
})

test('isValidIpProtocol accepts inet/inet6 only', () => {
  assert.equal(isValidIpProtocol('inet'), true)
  assert.equal(isValidIpProtocol('inet6'), true)
  assert.equal(isValidIpProtocol('inet46'), false)
})

test('modeHonorsManualRules is true only for hybrid/advanced', () => {
  assert.equal(modeHonorsManualRules('hybrid'), true)
  assert.equal(modeHonorsManualRules('advanced'), true)
  assert.equal(modeHonorsManualRules('automatic'), false)
  assert.equal(modeHonorsManualRules('disabled'), false)
  assert.equal(modeHonorsManualRules(null), false)
})

test('buildSourceNatRuleBody keeps single-value fields single and resolves category uuids', () => {
  const [spec] = extractSourceNatRuleSpecs(
    makeCtx([{ id: 'a', name: 'a', fields: { description: 'x', interface: 'wan', target: '203.0.113.5', categories: ['DMZ'] } }]).canvas,
  )
  const body = buildSourceNatRuleBody(spec, ['uuid-1'])
  assert.equal(body.interface, 'wan')
  assert.equal(body.target, '203.0.113.5')
  assert.equal(body.categories, 'uuid-1')
  assert.equal(body['endpoint-independent'], '0')
})

test('snapshotLive carries a searchRule row into a setRule-ready body', () => {
  const live: LiveSourceNatRule = { uuid: 'u1', enabled: '1', interface: 'lan', target: '203.0.113.5', description: 'x' }
  const body = snapshotLive(live)
  assert.equal(body.interface, 'lan')
  assert.equal(body.target, '203.0.113.5')
  assert.equal(body.description, 'x')
})
