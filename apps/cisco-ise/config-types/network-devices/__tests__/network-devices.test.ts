import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  specFromItem,
  extractSpecs,
  toNetworkDeviceBody,
  stripSecrets,
  toRestoreBody,
  isValidIPv4,
  readIpMaskEntries,
  readTagList,
  DEFAULT_DEVICE_GROUPS,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import type { NetworkDevice } from '../../../lib/iseApi'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'sw-1', ip_addresses: { '10.1.1.1': '32' } }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a device with no IP addresses', async () => {
  const res = await validate(ctxOf([{ name: 'sw-1', ip_addresses: {} }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_IP_LIST'))
})

test('validate rejects a malformed IPv4 address', async () => {
  const res = await validate(ctxOf([{ name: 'sw-1', ip_addresses: { 'not-an-ip': '32' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_IPV4'))
})

test('validate rejects an out-of-range mask', async () => {
  const res = await validate(ctxOf([{ name: 'sw-1', ip_addresses: { '10.1.1.1': '99' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MASK'))
})

test('validate warns on a duplicate device name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a well-formed device', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('isValidIPv4 accepts dotted quads and rejects out-of-range octets and garbage', () => {
  assert.equal(isValidIPv4('10.1.1.1'), true)
  assert.equal(isValidIPv4('255.255.255.255'), true)
  assert.equal(isValidIPv4('256.1.1.1'), false)
  assert.equal(isValidIPv4('not-an-ip'), false)
  assert.equal(isValidIPv4('::1'), false)
})

test('readIpMaskEntries handles both keyvalue serializations', () => {
  assert.deepEqual(readIpMaskEntries({ '10.1.1.1': '32' }), [{ ipaddress: '10.1.1.1', mask: 32 }])
  assert.deepEqual(readIpMaskEntries([{ key: '10.1.1.0', value: '24' }]), [{ ipaddress: '10.1.1.0', mask: 24 }])
  assert.deepEqual(readIpMaskEntries([{ name: '10.1.1.5' }]), [{ ipaddress: '10.1.1.5', mask: 32 }])
  assert.deepEqual(readIpMaskEntries(null), [])
})

test('readTagList handles arrays and comma-separated strings', () => {
  assert.deepEqual(readTagList(['a', ' b ']), ['a', 'b'])
  assert.deepEqual(readTagList('a, b ,c'), ['a', 'b', 'c'])
  assert.deepEqual(readTagList(undefined), [])
})

test('specFromItem defaults device_groups to the ISE default roots when unset', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: { name: 'sw-1', ip_addresses: { '10.1.1.1': '32' } } })
  assert.deepEqual(spec.deviceGroups, DEFAULT_DEVICE_GROUPS)
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([good]))
  assert.equal(specs.length, 1)
  assert.equal(specs[0].name, 'sw-1')
})

test('toNetworkDeviceBody omits authenticationSettings when no secret was provided', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: good })
  const body = toNetworkDeviceBody(spec)
  assert.equal(body.authenticationSettings, undefined)
  assert.deepEqual(body.NetworkDeviceIPList, [{ ipaddress: '10.1.1.1', mask: 32 }])
})

test('toNetworkDeviceBody includes authenticationSettings only when a secret is provided', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: { ...good, radius_shared_secret: 'S3cr3t' } })
  const body = toNetworkDeviceBody(spec)
  assert.deepEqual(body.authenticationSettings, { networkProtocol: 'RADIUS', radiusSharedSecret: 'S3cr3t', enableKeyWrap: 'false' })
})

test('stripSecrets removes authenticationSettings from a live device snapshot', () => {
  const device: NetworkDevice = { id: '1', name: 'sw-1', authenticationSettings: { radiusSharedSecret: 'leaked' } }
  const stripped = stripSecrets(device)
  assert.equal((stripped as NetworkDevice).authenticationSettings, undefined)
  assert.equal(stripped.name, 'sw-1')
})

test('toRestoreBody never re-introduces a secret and falls back to defaults', () => {
  const prior: NetworkDevice = { name: 'sw-1', description: 'old' }
  const body = toRestoreBody(prior, 'sw-1')
  assert.equal((body as NetworkDevice).authenticationSettings, undefined)
  assert.deepEqual(body.NetworkDeviceGroupList, DEFAULT_DEVICE_GROUPS)
  assert.deepEqual(body.NetworkDeviceIPList, [])
})
