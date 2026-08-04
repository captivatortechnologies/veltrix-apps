import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractTunnelSpecs, liveDeviceType, tunnelCreateBody } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Umbrella Deployments API,
 * which is impractical to mock here. Tests focus on the pure, network-free
 * pieces: validate.ts and the _shared parsing/body-building helpers.
 */
function ctxWith(list: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>): PipelineContext {
  const items = list.map((row, i) => ({ id: row.id ?? `i${i}`, name: row.name ?? String(i), fields: row.fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

const good = { name: 'HQ-Tunnel', deviceType: 'other', pskSecret: 'a-strong-secret-1', idPrefix: 'hq-', siteName: '' }

test('validate accepts a valid tunnel', () => {
  const res = validate(ctxWith([{ fields: good }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', () => {
  const res = validate(ctxWith([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a name', () => {
  const res = validate(ctxWith([{ name: '', fields: { ...good, name: '' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'required' && e.field.endsWith('.name')))
})

test('validate rejects duplicate names', () => {
  const res = validate(ctxWith([{ fields: good }, { fields: { ...good } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'duplicate_name'))
})

test('validate requires a PSK secret', () => {
  const res = validate(ctxWith([{ fields: { ...good, pskSecret: '' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field.endsWith('.pskSecret')))
})

test('validate warns on a short PSK secret', () => {
  const res = validate(ctxWith([{ fields: { ...good, pskSecret: 'short' } }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'weak_secret'))
})

test('extractTunnelSpecs defaults deviceType to "other"', () => {
  const specs = extractTunnelSpecs({
    items: [{ id: 'i1', name: 'Fallback', fields: { name: 'T1', pskSecret: 'secretsecret' } }],
  } as unknown as PipelineContext['canvas'])
  assert.equal(specs[0].deviceType, 'other')
})

test('liveDeviceType reads the nested client.deviceType shape', () => {
  assert.equal(liveDeviceType({ client: { deviceType: 'MERAKI_MX' } }), 'MERAKI_MX')
  assert.equal(liveDeviceType({ deviceType: 'other' }), 'other')
  assert.equal(liveDeviceType({}), '')
})

test('tunnelCreateBody builds the PSK authentication shape', () => {
  const body = tunnelCreateBody({ ...good }, 42) as any
  assert.equal(body.name, 'HQ-Tunnel')
  assert.equal(body.serviceType, 'SIG')
  assert.equal(body.siteOriginId, 42)
  assert.equal(body.authentication.type, 'PSK')
  assert.equal(body.authentication.parameters.secret, 'a-strong-secret-1')
  assert.equal(body.authentication.parameters.idPrefix, 'hq-')
})

test('tunnelCreateBody omits siteOriginId when unresolved', () => {
  const body = tunnelCreateBody({ ...good }, undefined) as any
  assert.equal('siteOriginId' in body, false)
})
