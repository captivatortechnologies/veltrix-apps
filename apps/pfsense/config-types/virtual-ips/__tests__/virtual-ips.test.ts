import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, toVirtualIpBody, snapshotVirtualIp, vipKey, isValidVipSubnet, MAX_DESCRIPTION_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `vip-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const validIpAlias = { mode: 'ipalias', interface: 'wan', type: 'single', subnet: '203.0.113.10', subnet_bits: 32, descr: 'Extra WAN IP' }
const validCarp = {
  mode: 'carp',
  interface: 'lan',
  type: 'single',
  subnet: '10.0.0.1',
  subnet_bits: 24,
  vhid: 1,
  advbase: 1,
  advskew: 0,
  password: 'sharedsecret',
  carp_mode: 'mcast',
}

// --- validate ------------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a mode', async () => {
  const res = await validate(ctxOf([{ ...validIpAlias, mode: undefined }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MODE'))
})

test('validate requires an interface', async () => {
  const res = await validate(ctxOf([{ ...validIpAlias, interface: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_INTERFACE'))
})

test('validate rejects "network" type for ipalias/carp modes', async () => {
  const ipaliasRes = await validate(ctxOf([{ ...validIpAlias, type: 'network' }]))
  assert.ok(ipaliasRes.errors.some((e) => e.code === 'NETWORK_TYPE_NOT_SUPPORTED'))

  const carpRes = await validate(ctxOf([{ ...validCarp, type: 'network' }]))
  assert.ok(carpRes.errors.some((e) => e.code === 'NETWORK_TYPE_NOT_SUPPORTED'))
})

test('validate allows "network" type for proxyarp/other modes', async () => {
  const res = await validate(ctxOf([{ ...validIpAlias, mode: 'proxyarp', type: 'network', subnet_bits: 24 }]))
  assert.equal(res.errors.some((e) => e.code === 'NETWORK_TYPE_NOT_SUPPORTED'), false)
})

test('validate requires a valid subnet address', async () => {
  const empty = await validate(ctxOf([{ ...validIpAlias, subnet: '' }]))
  assert.ok(empty.errors.some((e) => e.code === 'EMPTY_SUBNET'))

  const invalid = await validate(ctxOf([{ ...validIpAlias, subnet: 'not-an-ip' }]))
  assert.ok(invalid.errors.some((e) => e.code === 'INVALID_SUBNET'))
})

test('validate rejects a duplicate subnet across items', async () => {
  const res = await validate(ctxOf([validIpAlias, { ...validIpAlias, descr: 'dup' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_SUBNET'))
})

test('validate rejects subnet_bits over 32 for an IPv4 subnet', async () => {
  const res = await validate(ctxOf([{ ...validIpAlias, subnet_bits: 64 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'IPV4_SUBNET_BITS_EXCEEDED'))
})

test('validate allows subnet_bits up to 128 for an IPv6 subnet', async () => {
  const res = await validate(ctxOf([{ ...validIpAlias, subnet: '2001:db8::1', subnet_bits: 128 }]))
  assert.equal(res.errors.some((e) => e.code === 'IPV4_SUBNET_BITS_EXCEEDED'), false)
})

test('validate requires vhid/password for CARP mode', async () => {
  const noVhid = await validate(ctxOf([{ ...validCarp, vhid: undefined }]))
  assert.ok(noVhid.errors.some((e) => e.code === 'EMPTY_VHID'))

  const noPassword = await validate(ctxOf([{ ...validCarp, password: '' }]))
  assert.ok(noPassword.errors.some((e) => e.code === 'EMPTY_PASSWORD'))
})

test('validate rejects an out-of-range vhid', async () => {
  const res = await validate(ctxOf([{ ...validCarp, vhid: 999 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_VHID'))
})

test('validate requires a valid carp_peer for unicast CARP mode', async () => {
  const missing = await validate(ctxOf([{ ...validCarp, carp_mode: 'ucast' }]))
  assert.ok(missing.errors.some((e) => e.code === 'EMPTY_CARP_PEER'))

  const invalid = await validate(ctxOf([{ ...validCarp, carp_mode: 'ucast', carp_peer: 'nope' }]))
  assert.ok(invalid.errors.some((e) => e.code === 'INVALID_CARP_PEER'))

  const valid = await validate(ctxOf([{ ...validCarp, carp_mode: 'ucast', carp_peer: '10.0.0.2' }]))
  assert.equal(valid.errors.some((e) => e.code.includes('CARP_PEER')), false)
})

test('validate accepts a well-formed IP-alias VIP and a well-formed CARP VIP', async () => {
  const ipaliasRes = await validate(ctxOf([validIpAlias]))
  assert.equal(ipaliasRes.valid, true)
  const carpRes = await validate(ctxOf([validCarp]))
  assert.equal(carpRes.valid, true)
})

test('validate rejects a description over the limit', async () => {
  const res = await validate(ctxOf([{ ...validIpAlias, descr: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

// --- _shared -------------------------------------------------------------------

test('vipKey trims and does not fold case', () => {
  assert.equal(vipKey('  203.0.113.10  '), '203.0.113.10')
})

test('isValidVipSubnet accepts IPv4/IPv6 only, not a CIDR', () => {
  assert.equal(isValidVipSubnet('203.0.113.10'), true)
  assert.equal(isValidVipSubnet('2001:db8::1'), true)
  assert.equal(isValidVipSubnet('203.0.113.0/24'), false)
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([validIpAlias, validCarp]))
  assert.equal(specs.length, 2)
  assert.equal(specs[0].mode, 'ipalias')
  assert.equal(specs[1].mode, 'carp')
})

test('toVirtualIpBody omits CARP fields for a non-CARP mode', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: validIpAlias })
  const body = toVirtualIpBody(spec) as Record<string, unknown>
  assert.equal('vhid' in body, false)
  assert.equal('password' in body, false)
})

test('toVirtualIpBody includes CARP fields for CARP mode', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: validCarp })
  const body = toVirtualIpBody(spec)
  assert.equal(body.vhid, 1)
  assert.equal(body.password, 'sharedsecret')
  assert.equal(body.carp_mode, 'mcast')
  assert.equal((body as Record<string, unknown>).carp_peer, undefined)
})

test('toVirtualIpBody includes carp_peer only for unicast CARP', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: { ...validCarp, carp_mode: 'ucast', carp_peer: '10.0.0.2' } })
  const body = toVirtualIpBody(spec)
  assert.equal(body.carp_peer, '10.0.0.2')
})

test('snapshotVirtualIp never includes id or subnet', () => {
  const snap = snapshotVirtualIp({ id: 2, mode: 'ipalias', interface: 'wan', subnet: '203.0.113.10', subnet_bits: 32 }) as Record<string, unknown>
  assert.equal('id' in snap, false)
  assert.equal('subnet' in snap, false)
  assert.equal(snap.mode, 'ipalias')
})
