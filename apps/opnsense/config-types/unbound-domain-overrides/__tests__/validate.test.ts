import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildDomainOverrideBody, domainOverrideKey, extractDomainOverrideSpecs, snapshotLive } from '../_shared'
import type { LiveDomainOverride } from '../../../lib/unboundApi'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'opnsense',
    customerId: 'cust-1',
    configTypeId: 'unbound-domain-overrides',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'opnsense',
      entityType: 'unbound-domain-overrides',
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

const validOverride = { domain: 'internal.example.com', server: '10.0.0.53' }

test('rejects an empty canvas', async () => {
  const result = await validate(makeCtx([]))
  assert.equal(result.valid, false)
  assert.equal(result.errors[0].code, 'empty_canvas')
})

test('validates a well-formed domain override', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: validOverride }]))
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
})

test('requires a domain', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { domain: '', server: '10.0.0.53' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('domain') && e.code === 'required'))
})

test('requires a server', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { domain: 'example.com' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('server')))
})

test('rejects a duplicate domain (case-insensitive)', async () => {
  const result = await validate(
    makeCtx([
      { id: 'a', name: 'a', fields: validOverride },
      { id: 'b', name: 'b', fields: { ...validOverride, domain: 'Internal.Example.com' } },
    ]),
  )
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'duplicate_name'))
})

test('rejects a port outside 1-65535', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validOverride, port: 70000 } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('port')))
})

test('extractDomainOverrideSpecs applies defaults and falls back to item.name', () => {
  const [spec] = extractDomainOverrideSpecs(makeCtx([{ name: 'fallback.example.com', fields: { server: '10.0.0.53' } }]).canvas)
  assert.equal(spec.domain, 'fallback.example.com')
  assert.equal(spec.enabled, true)
  assert.equal(spec.forwardFirst, false)
})

test('domainOverrideKey is case-insensitive', () => {
  assert.equal(domainOverrideKey('Example.COM'), domainOverrideKey('example.com'))
})

test('buildDomainOverrideBody / snapshotLive round-trip the same body shape', () => {
  const [spec] = extractDomainOverrideSpecs(makeCtx([{ id: 'a', name: 'a', fields: validOverride }]).canvas)
  const body = buildDomainOverrideBody(spec)
  assert.equal(body.domain, 'internal.example.com')
  assert.equal(body.server, '10.0.0.53')

  const live: LiveDomainOverride = { uuid: 'u1', domain: 'internal.example.com', server: '10.0.0.53', type: 'forward' }
  assert.equal(snapshotLive(live).server, '10.0.0.53')
})
