import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, isValidMappingNetwork, portsApplicable, toOutboundMappingCreateBody, snapshotOutboundMapping, MAX_DESCRIPTION_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `item-${i}`, name: `mapping-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const validMapping = { interface: 'wan', source: '10.0.0.0/24', destination: 'any', target: 'wan:ip', descr: 'LAN outbound via WAN' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires an interface', async () => {
  const res = await validate(ctxOf([{ ...validMapping, interface: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_INTERFACE'))
})

test('validate rejects a bare IP for source (network-only field, no allow_ipaddr)', async () => {
  const res = await validate(ctxOf([{ ...validMapping, source: '10.0.0.5' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SOURCE'))
})

test('validate accepts a CIDR, alias, or "any" for source', async () => {
  const cidr = await validate(ctxOf([{ ...validMapping, source: '10.0.0.0/24' }]))
  assert.equal(cidr.errors.some((e) => e.code === 'INVALID_SOURCE'), false)
  const alias = await validate(ctxOf([{ ...validMapping, source: 'LAN_SUBNET' }]))
  assert.equal(alias.errors.some((e) => e.code === 'INVALID_SOURCE'), false)
  const any = await validate(ctxOf([{ ...validMapping, source: 'any' }]))
  assert.equal(any.errors.some((e) => e.code === 'INVALID_SOURCE'), false)
})

test('validate rejects an unrecognized protocol', async () => {
  const res = await validate(ctxOf([{ ...validMapping, protocol: 'bogus' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROTOCOL'))
})

test('validate requires a target unless nonat is enabled', async () => {
  const noTarget = await validate(ctxOf([{ ...validMapping, target: '' }]))
  assert.ok(noTarget.errors.some((e) => e.code === 'EMPTY_TARGET'))

  const nonatRes = await validate(ctxOf([{ ...validMapping, target: '', nonat: true }]))
  assert.equal(nonatRes.errors.some((e) => e.code === 'EMPTY_TARGET'), false)
})

test('validate warns when target is set with nonat enabled', async () => {
  const res = await validate(ctxOf([{ ...validMapping, nonat: true }]))
  assert.ok(res.warnings.some((w) => w.code === 'TARGET_IGNORED'))
})

test('validate rejects an out-of-range target_subnet', async () => {
  const res = await validate(ctxOf([{ ...validMapping, target_subnet: 200 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TARGET_SUBNET'))
})

test('validate rejects a malformed nat_port', async () => {
  const res = await validate(ctxOf([{ ...validMapping, nat_port: 'not-a-port!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAT_PORT'))
})

test('validate accepts a well-formed mapping', async () => {
  const res = await validate(ctxOf([validMapping]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a description over the limit', async () => {
  const res = await validate(ctxOf([{ ...validMapping, descr: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('isValidMappingNetwork rejects a bare IP but accepts a CIDR/alias/any', () => {
  assert.equal(isValidMappingNetwork('10.0.0.5'), false)
  assert.equal(isValidMappingNetwork('10.0.0.0/24'), true)
  assert.equal(isValidMappingNetwork('LAN_SUBNET'), true)
  assert.equal(isValidMappingNetwork('any'), true)
})

test('isValidMappingNetwork honours allowSelf/allowInvert options', () => {
  assert.equal(isValidMappingNetwork('(self)'), false)
  assert.equal(isValidMappingNetwork('(self)', { allowSelf: true }), true)
  assert.equal(isValidMappingNetwork('!10.0.0.0/24'), false)
  assert.equal(isValidMappingNetwork('!10.0.0.0/24', { allowInvert: true }), true)
})

test('portsApplicable is true only for tcp/udp/tcp-udp', () => {
  assert.equal(portsApplicable('tcp'), true)
  assert.equal(portsApplicable(''), false)
})

test('specFromItem uses the canvas item id as itemId (mapping identity)', () => {
  const spec = specFromItem({ id: 'mapping-abc', name: 'x', fields: validMapping })
  assert.equal(spec.itemId, 'mapping-abc')
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([validMapping, validMapping]))
  assert.equal(specs.length, 2)
})

test('toOutboundMappingCreateBody clears target fields when nonat is enabled', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: { ...validMapping, nonat: true } })
  const body = toOutboundMappingCreateBody(spec)
  assert.equal(body.target, undefined)
  assert.equal(body.static_nat_port, false)
})

test('snapshotOutboundMapping never includes id', () => {
  const snap = snapshotOutboundMapping({ id: 7, interface: 'wan', source: '10.0.0.0/24', destination: 'any', target: 'wan:ip', target_subnet: 128 }) as Record<string, unknown>
  assert.equal('id' in snap, false)
  assert.equal(snap.interface, 'wan')
})
