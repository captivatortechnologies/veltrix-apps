import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractInternalNetworkSubnetSpecs, isIpv4 } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Umbrella Deployments API
 * (plus a cross-resource association lookup), which is impractical to mock
 * here. Tests focus on the pure, network-free pieces: validate.ts and the
 * _shared parsing helpers.
 */
function ctxWith(list: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>): PipelineContext {
  const items = list.map((row, i) => ({ id: row.id ?? `i${i}`, name: row.name ?? String(i), fields: row.fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

const good = { name: 'Branch-A', ipAddress: '10.10.0.0', prefixLength: 24, associationType: 'site', associationName: 'London HQ' }

test('validate accepts a valid internal network subnet', () => {
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

test('validate rejects a malformed IPv4 address', () => {
  const res = validate(ctxWith([{ fields: { ...good, ipAddress: 'not-an-ip' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_ip'))
})

test('validate rejects a prefix length outside 9-32', () => {
  const res = validate(ctxWith([{ fields: { ...good, prefixLength: 8 } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_prefix'))
})

test('validate rejects an unknown association type', () => {
  const res = validate(ctxWith([{ fields: { ...good, associationType: 'roaming' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_association_type'))
})

test('validate requires an association name', () => {
  const res = validate(ctxWith([{ fields: { ...good, associationName: '' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field.endsWith('.associationName')))
})

test('isIpv4 accepts dotted quads, rejects junk', () => {
  assert.equal(isIpv4('10.10.0.0'), true)
  assert.equal(isIpv4('255.255.255.255'), true)
  assert.equal(isIpv4('10.10.0.0/24'), false)
  assert.equal(isIpv4('not-an-ip'), false)
})

test('extractInternalNetworkSubnetSpecs reads fields with defaults and coercions', () => {
  const specs = extractInternalNetworkSubnetSpecs({
    items: [
      {
        id: 'i1',
        name: 'Fallback',
        fields: { name: '  Branch-B  ', ipAddress: '10.20.0.0', prefixLength: '25', associationType: 'network', associationName: 'Egress-1' },
      },
    ],
  } as unknown as PipelineContext['canvas'])
  assert.equal(specs[0].name, 'Branch-B')
  assert.equal(specs[0].prefixLength, 25)
  assert.equal(specs[0].associationType, 'network')
  assert.equal(specs[0].associationName, 'Egress-1')
})
