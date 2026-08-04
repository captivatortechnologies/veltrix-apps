import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildHostOverrideBody, extractHostOverrideSpecs, hostOverrideKey, isValidRecordType, snapshotLive } from '../_shared'
import type { LiveHostOverride } from '../../../lib/unboundApi'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'opnsense',
    customerId: 'cust-1',
    configTypeId: 'unbound-host-overrides',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'opnsense',
      entityType: 'unbound-host-overrides',
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

const validHost = { hostname: 'printer', domain: 'example.com', rr: 'A', server: '10.0.0.5' }

test('rejects an empty canvas', async () => {
  const result = await validate(makeCtx([]))
  assert.equal(result.valid, false)
  assert.equal(result.errors[0].code, 'empty_canvas')
})

test('validates a well-formed A record host override', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: validHost }]))
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
})

test('requires a hostname and domain', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: '', fields: { hostname: '', rr: 'A', server: '10.0.0.5' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('hostname')))
  assert.ok(result.errors.some((e) => e.field.includes('domain')))
})

test('rejects a duplicate hostname+domain pair (case-insensitive)', async () => {
  const result = await validate(
    makeCtx([
      { id: 'a', name: 'a', fields: validHost },
      { id: 'b', name: 'b', fields: { ...validHost, hostname: 'Printer' } },
    ]),
  )
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'duplicate_name'))
})

test('requires server for an A/AAAA record', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { hostname: 'h', domain: 'd', rr: 'A' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('server')))
})

test('requires mxprio and mx for an MX record', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { hostname: 'h', domain: 'd', rr: 'MX' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('mxprio')))
  assert.ok(result.errors.some((e) => e.field.includes('mx')))
})

test('requires txtdata for a TXT record', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { hostname: 'h', domain: 'd', rr: 'TXT' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('txtdata')))
})

test('rejects an invalid record type', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validHost, rr: 'CNAME' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('rr')))
})

test('extractHostOverrideSpecs applies defaults', () => {
  const [spec] = extractHostOverrideSpecs(makeCtx([{ id: 'a', name: 'a', fields: { hostname: 'h', domain: 'd' } }]).canvas)
  assert.equal(spec.rr, 'A')
  assert.equal(spec.addPtr, true)
  assert.equal(spec.enabled, true)
})

test('hostOverrideKey is case-insensitive', () => {
  assert.equal(hostOverrideKey('Printer', 'Example.COM'), hostOverrideKey('printer', 'example.com'))
})

test('isValidRecordType accepts A/AAAA/MX/TXT only', () => {
  assert.equal(isValidRecordType('A'), true)
  assert.equal(isValidRecordType('TXT'), true)
  assert.equal(isValidRecordType('CNAME'), false)
})

test('buildHostOverrideBody / snapshotLive round-trip the same body shape', () => {
  const [spec] = extractHostOverrideSpecs(makeCtx([{ id: 'a', name: 'a', fields: validHost }]).canvas)
  const body = buildHostOverrideBody(spec)
  assert.equal(body.hostname, 'printer')
  assert.equal(body.domain, 'example.com')
  assert.equal(body.server, '10.0.0.5')

  const live: LiveHostOverride = { uuid: 'u1', hostname: 'printer', domain: 'example.com', rr: 'A', server: '10.0.0.5' }
  assert.equal(snapshotLive(live).server, '10.0.0.5')
})
