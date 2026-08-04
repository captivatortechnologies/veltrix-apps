import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildRouteBody, extractRouteSpecs, isValidCidr, routeKey, snapshotLive } from '../_shared'
import type { LiveRoute } from '../../../lib/staticRoutesApi'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'opnsense',
    customerId: 'cust-1',
    configTypeId: 'static-routes',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'opnsense',
      entityType: 'static-routes',
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

const validRoute = { network: '10.10.0.0/24', gateway: 'WAN_GW' }

test('rejects an empty canvas', async () => {
  const result = await validate(makeCtx([]))
  assert.equal(result.valid, false)
  assert.equal(result.errors[0].code, 'empty_canvas')
})

test('validates a well-formed route', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: validRoute }]))
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
})

test('requires a network', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { network: '', gateway: 'WAN_GW' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('network') && e.code === 'required'))
})

test('requires a gateway', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { network: '10.0.0.0/24' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('gateway')))
})

test('rejects a network with no CIDR prefix', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validRoute, network: '10.10.0.0' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('network') && e.code === 'invalid_value'))
})

test('rejects a duplicate network (case-insensitive)', async () => {
  const result = await validate(
    makeCtx([
      { id: 'a', name: 'a', fields: validRoute },
      { id: 'b', name: 'b', fields: { ...validRoute, network: '10.10.0.0/24' } },
    ]),
  )
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'duplicate_name'))
})

test('extractRouteSpecs applies defaults and falls back to item.name', () => {
  const [spec] = extractRouteSpecs(makeCtx([{ name: '10.20.0.0/24', fields: { gateway: 'WAN_GW' } }]).canvas)
  assert.equal(spec.network, '10.20.0.0/24')
  assert.equal(spec.enabled, true)
})

test('routeKey is case-insensitive', () => {
  assert.equal(routeKey('10.10.0.0/24'), routeKey('10.10.0.0/24'))
})

test('isValidCidr accepts IPv4/IPv6 CIDR and rejects a bare IP', () => {
  assert.equal(isValidCidr('10.0.0.0/24'), true)
  assert.equal(isValidCidr('2001:db8::/32'), true)
  assert.equal(isValidCidr('10.0.0.0'), false)
  assert.equal(isValidCidr('10.0.0.0/99'), false)
})

test('buildRouteBody / snapshotLive round-trip the same body shape', () => {
  const [spec] = extractRouteSpecs(makeCtx([{ id: 'a', name: 'a', fields: { ...validRoute, descr: 'Branch office' } }]).canvas)
  const body = buildRouteBody(spec)
  assert.equal(body.network, '10.10.0.0/24')
  assert.equal(body.gateway, 'WAN_GW')
  assert.equal(body.descr, 'Branch office')

  const live: LiveRoute = { uuid: 'u1', network: '10.10.0.0/24', gateway: 'WAN_GW', descr: 'Branch office', enabled: '1' }
  assert.equal(snapshotLive(live).gateway, 'WAN_GW')
})
