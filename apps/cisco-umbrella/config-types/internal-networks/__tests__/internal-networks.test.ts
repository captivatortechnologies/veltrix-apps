import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractNetworkSpecs, isIpv4 } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Umbrella Deployments API,
 * which is impractical to mock here. Tests focus on the pure, network-free
 * pieces: validate.ts and the _shared parsing helpers.
 */
function ctxWith(list: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>): PipelineContext {
  const items = list.map((row, i) => ({ id: row.id ?? `i${i}`, name: row.name ?? String(i), fields: row.fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

const good = { name: 'HQ Egress', ipAddress: '203.0.113.10', prefixLength: 32, isDynamic: false }

test('validate accepts a valid static network', () => {
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
  assert.ok(res.errors.some((e) => e.code === 'required'))
})

test('validate rejects a too-long name', () => {
  const res = validate(ctxWith([{ fields: { ...good, name: 'x'.repeat(51) } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'too_long'))
})

test('validate rejects duplicate names', () => {
  const res = validate(ctxWith([{ fields: good }, { fields: { ...good } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'duplicate_name'))
})

test('validate requires an IP for a static network', () => {
  const res = validate(ctxWith([{ fields: { ...good, ipAddress: '' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'required'))
})

test('validate allows a dynamic network with no IP', () => {
  const res = validate(ctxWith([{ fields: { name: 'Roaming', ipAddress: '', prefixLength: 32, isDynamic: true } }]))
  assert.equal(res.valid, true)
})

test('validate rejects an invalid IP', () => {
  const res = validate(ctxWith([{ fields: { ...good, ipAddress: '999.1.1.1' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_ip'))
})

test('validate rejects an out-of-range prefix length', () => {
  const res = validate(ctxWith([{ fields: { ...good, prefixLength: 33 } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_prefix'))
})

test('isIpv4 accepts valid and rejects invalid addresses', () => {
  assert.equal(isIpv4('10.0.0.1'), true)
  assert.equal(isIpv4('203.0.113.255'), true)
  assert.equal(isIpv4('256.0.0.1'), false)
  assert.equal(isIpv4('10.0.0'), false)
})

test('extractNetworkSpecs reads fields with defaults and coercions', () => {
  const specs = extractNetworkSpecs({
    items: [{ id: 'i1', name: 'Fallback', fields: { name: '  HQ  ', ipAddress: ' 198.51.100.5 ', prefixLength: '24', isDynamic: 'true' } }],
  } as unknown as PipelineContext['canvas'])
  assert.equal(specs[0].name, 'HQ')
  assert.equal(specs[0].ipAddress, '198.51.100.5')
  assert.equal(specs[0].prefixLength, 24)
  assert.equal(specs[0].isDynamic, true)
})
