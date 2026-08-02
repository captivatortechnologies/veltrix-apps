import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  specFromItem,
  extractSpecs,
  toAliasBody,
  snapshotAlias,
  aliasKey,
  validateAliasName,
  isValidIpv4,
  isValidIpv6,
  isValidCidr,
  isValidFqdn,
  looksLikeAliasName,
  isPortToken,
  isPortRangeToken,
  isValidAddressEntry,
  MAX_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

// --- validate ----------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ name: '', type: 'host' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a name over the 31-character limit', async () => {
  const res = await validate(ctxOf([{ name: 'a'.repeat(MAX_NAME_LENGTH + 1), type: 'host' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a purely numeric name', async () => {
  const res = await validate(ctxOf([{ name: '12345', type: 'host' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a name with an invalid character', async () => {
  const res = await validate(ctxOf([{ name: 'not-valid', type: 'host' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects the reserved words "port" and "pass"', async () => {
  const res = await validate(ctxOf([{ name: 'port', type: 'host' }, { name: 'pass', type: 'host' }]))
  assert.equal(res.valid, false)
  assert.equal(res.errors.filter((e) => e.code === 'INVALID_NAME').length, 2)
})

test('validate rejects a name starting with "pkg_"', async () => {
  const res = await validate(ctxOf([{ name: 'pkg_anything', type: 'host' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate warns (does not error) on a likely-reserved system name', async () => {
  const res = await validate(ctxOf([{ name: 'sshguard', type: 'host', address: ['1.2.3.4'] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'POSSIBLY_RESERVED_NAME'))
})

test('validate rejects a duplicate name (exact, case-sensitive identity)', async () => {
  const res = await validate(ctxOf([{ name: 'WEB_SERVERS', type: 'host' }, { name: 'WEB_SERVERS', type: 'host' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('validate allows two names differing only by case (distinct pfSense identities)', async () => {
  const res = await validate(ctxOf([{ name: 'WebServers', type: 'host' }, { name: 'webservers', type: 'host' }]))
  assert.equal(res.errors.some((e) => e.code === 'DUPLICATE_NAME'), false)
})

test('validate requires a type', async () => {
  const res = await validate(ctxOf([{ name: 'valid_name' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects a description over the limit', async () => {
  const res = await validate(ctxOf([{ name: 'valid_name', type: 'host', descr: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('validate warns (does not error) on an empty address list', async () => {
  const res = await validate(ctxOf([{ name: 'valid_name', type: 'host' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_ADDRESS_LIST'))
})

test('validate rejects an invalid address entry for the declared type', async () => {
  const res = await validate(ctxOf([{ name: 'valid_name', type: 'host', address: ['not an ip or fqdn!'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ADDRESS_ENTRY'))
})

test('validate accepts a well-formed host alias', async () => {
  const res = await validate(ctxOf([{ name: 'web_servers', type: 'host', descr: 'Web tier', address: ['10.0.0.1', 'app.example.com'] }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects more details than addresses', async () => {
  const res = await validate(
    ctxOf([{ name: 'valid_name', type: 'port', address: ['80', '443'], detail: ['web', 'https', 'extra'] }]),
  )
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'TOO_MANY_DETAILS'))
})

test('validate allows fewer details than addresses', async () => {
  const res = await validate(ctxOf([{ name: 'valid_name', type: 'port', address: ['80', '443'], detail: ['web'] }]))
  assert.equal(res.valid, true)
})

// --- _shared -------------------------------------------------------------------

test('specFromItem trims fields and normalizes an unrecognized type to empty', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: { name: '  web_servers  ', type: 'bogus' } })
  assert.equal(spec.name, 'web_servers')
  assert.equal(spec.type, '')
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([{ name: 'A', type: 'host' }, { name: 'B', type: 'network' }]))
  assert.equal(specs.length, 2)
  assert.deepEqual(specs.map((s) => s.name), ['A', 'B'])
})

test('aliasKey is case-sensitive (no folding)', () => {
  assert.notEqual(aliasKey('WebServers'), aliasKey('webservers'))
  assert.equal(aliasKey('  web_servers  '), 'web_servers')
})

test('toAliasBody never includes id and carries the declared fields', () => {
  const body = toAliasBody({ name: 'web_servers', type: 'host', descr: 'x', address: ['1.2.3.4'], detail: [] })
  assert.equal(body.name, 'web_servers')
  assert.equal(body.type, 'host')
  assert.deepEqual(body.address, ['1.2.3.4'])
})

test('snapshotAlias omits id and name (name is immutable, never restored via PATCH)', () => {
  const snap = snapshotAlias({ id: 3, name: 'web_servers', type: 'host', descr: 'x', address: ['1.2.3.4'], detail: ['d'] })
  assert.deepEqual(snap, { type: 'host', descr: 'x', address: ['1.2.3.4'], detail: ['d'] })
  assert.equal((snap as Record<string, unknown>).name, undefined)
})

test('validateAliasName accepts a well-formed name', () => {
  assert.equal(validateAliasName('web_servers_1').valid, true)
})

test('isValidIpv4 / isValidIpv6', () => {
  assert.equal(isValidIpv4('10.0.0.1'), true)
  assert.equal(isValidIpv4('256.0.0.1'), false)
  assert.equal(isValidIpv6('2001:db8::1'), true)
  assert.equal(isValidIpv6('not-an-ip'), false)
})

test('isValidCidr accepts v4 and v6 CIDRs', () => {
  assert.equal(isValidCidr('10.0.0.0/24'), true)
  assert.equal(isValidCidr('2001:db8::/32'), true)
  assert.equal(isValidCidr('10.0.0.0/33'), false)
  assert.equal(isValidCidr('10.0.0.0'), false)
})

test('isValidFqdn accepts a well-formed hostname', () => {
  assert.equal(isValidFqdn('app.example.com'), true)
  assert.equal(isValidFqdn('not a hostname'), false)
})

test('looksLikeAliasName mirrors the alias-name charset', () => {
  assert.equal(looksLikeAliasName('SOME_ALIAS'), true)
  assert.equal(looksLikeAliasName('has space'), false)
  assert.equal(looksLikeAliasName('12345'), false)
})

test('isPortToken accepts a numeric port in range and rejects out-of-range', () => {
  assert.equal(isPortToken('443'), true)
  assert.equal(isPortToken('70000'), false)
  assert.equal(isPortToken('0'), false)
})

test('isPortRangeToken requires a colon delimiter (not a hyphen)', () => {
  assert.equal(isPortRangeToken('8000:8100'), true)
  assert.equal(isPortRangeToken('8000-8100'), false)
})

test('isValidAddressEntry validates per alias type', () => {
  assert.equal(isValidAddressEntry('host', '10.0.0.1'), true)
  assert.equal(isValidAddressEntry('host', 'app.example.com'), true)
  assert.equal(isValidAddressEntry('host', 'not valid!'), false)
  assert.equal(isValidAddressEntry('network', '10.0.0.0/24'), true)
  assert.equal(isValidAddressEntry('network', '10.0.0.1'), false)
  assert.equal(isValidAddressEntry('port', '8080'), true)
  assert.equal(isValidAddressEntry('port', '8000:8100'), true)
  assert.equal(isValidAddressEntry('port', '!!!'), false)
})
