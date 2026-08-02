import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildCategoryBody, categoryKey, extractCategorySpecs, isSystemManaged, isValidColor, snapshotLive } from '../_shared'
import type { LiveCategory } from '../../../lib/opnsenseApi'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'opnsense',
    customerId: 'cust-1',
    configTypeId: 'firewall-categories',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'opnsense',
      entityType: 'firewall-categories',
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

test('rejects an empty canvas', async () => {
  const result = await validate(makeCtx([]))
  assert.equal(result.valid, false)
  assert.equal(result.errors[0].code, 'empty_canvas')
})

test('validates a well-formed category', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { name: 'DMZ', color: 'FF8800' } }]))
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
})

test('accepts a category with no color', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { name: 'DMZ' } }]))
  assert.equal(result.valid, true)
})

test('rejects a missing name', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: '', fields: { color: 'FF0000' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'required' && e.field.includes('name')))
})

test('rejects a name containing a comma', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { name: 'DMZ,Guest' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'invalid_name'))
})

test('rejects duplicate category names (case-sensitive)', async () => {
  const result = await validate(
    makeCtx([
      { id: 'a', name: 'a', fields: { name: 'DMZ' } },
      { id: 'b', name: 'b', fields: { name: 'DMZ' } },
    ]),
  )
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'duplicate_name'))
})

test('allows same name with different casing (case-sensitive identity)', async () => {
  const result = await validate(
    makeCtx([
      { id: 'a', name: 'a', fields: { name: 'DMZ' } },
      { id: 'b', name: 'b', fields: { name: 'dmz' } },
    ]),
  )
  assert.equal(result.valid, true)
})

test('rejects an invalid color', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { name: 'DMZ', color: 'not-a-color' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'invalid_color'))
})

test('isValidColor accepts 6 hex digits or blank', () => {
  assert.equal(isValidColor(''), true)
  assert.equal(isValidColor('FF8800'), true)
  assert.equal(isValidColor('ff8800'), true)
  assert.equal(isValidColor('FF88'), false)
  assert.equal(isValidColor('GGGGGG'), false)
})

test('extractCategorySpecs trims and normalizes color casing', () => {
  const [spec] = extractCategorySpecs(makeCtx([{ id: 'a', name: 'a', fields: { name: '  DMZ  ', color: '#ff8800' } }]).canvas)
  assert.equal(spec.name, 'DMZ')
  assert.equal(spec.color, 'FF8800')
  assert.equal(categoryKey('  DMZ '), 'DMZ')
})

test('isSystemManaged reads the live auto flag', () => {
  assert.equal(isSystemManaged({ uuid: 'u1', auto: '1' }), true)
  assert.equal(isSystemManaged({ uuid: 'u1', auto: '0' }), false)
  assert.equal(isSystemManaged({ uuid: 'u1' }), false)
})

test('buildCategoryBody / snapshotLive round-trip the same body shape', () => {
  const [spec] = extractCategorySpecs(makeCtx([{ id: 'a', name: 'a', fields: { name: 'DMZ', color: 'FF8800' } }]).canvas)
  const body = buildCategoryBody(spec)
  assert.deepEqual(body, { name: 'DMZ', color: 'FF8800' })

  const live: LiveCategory = { uuid: 'u1', name: 'DMZ', color: 'FF8800' }
  assert.deepEqual(snapshotLive(live), { name: 'DMZ', color: 'FF8800' })
})
