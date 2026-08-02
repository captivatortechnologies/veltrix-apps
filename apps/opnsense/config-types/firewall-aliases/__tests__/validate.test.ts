import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  aliasKey,
  buildAliasBody,
  extractAliasSpecs,
  isSupportedAliasType,
  isValidAsnEntry,
  isValidGeoipEntry,
  isValidHostEntry,
  isValidIpv4,
  isValidIpv6,
  isValidMacEntry,
  isValidNetworkEntry,
  isValidNetworkGroupEntry,
  isValidPartialIpv6Entry,
  isValidPortEntry,
  liveContentList,
  sameEntrySet,
  snapshotLive,
  strList,
  validateContentEntry,
} from '../_shared'
import type { LiveAlias } from '../../../lib/opnsenseApi'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'opnsense',
    customerId: 'cust-1',
    configTypeId: 'firewall-aliases',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'opnsense',
      entityType: 'firewall-aliases',
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

const validHost = { name: 'web_servers', type: 'host', content: ['10.0.0.5', '10.0.0.6'] }

test('rejects an empty canvas', async () => {
  const result = await validate(makeCtx([]))
  assert.equal(result.valid, false)
  assert.equal(result.errors[0].code, 'empty_canvas')
})

test('validates a well-formed host alias', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: validHost }]))
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
})

test('rejects a missing name', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: '', fields: { type: 'host', content: ['1.2.3.4'] } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'required' && e.field.includes('name')))
})

test('rejects a name with illegal characters', async () => {
  const result = await validate(
    makeCtx([{ id: 'a', name: 'a', fields: { ...validHost, name: 'bad name!' } }]),
  )
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'invalid_name'))
})

test('rejects a reserved pf keyword as a name', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validHost, name: 'table' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'invalid_name'))
})

test('rejects duplicate alias names (case-sensitive)', async () => {
  const result = await validate(
    makeCtx([
      { id: 'a', name: 'a', fields: { ...validHost, name: 'web_servers' } },
      { id: 'b', name: 'b', fields: { ...validHost, name: 'Web_Servers' } },
    ]),
  )
  assert.equal(result.valid, true) // different case => NOT flagged as duplicate
})

test('flags an exact-case duplicate name', async () => {
  const result = await validate(
    makeCtx([
      { id: 'a', name: 'a', fields: { ...validHost, name: 'web_servers' } },
      { id: 'b', name: 'b', fields: { ...validHost, name: 'web_servers' } },
    ]),
  )
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'duplicate_name'))
})

test('rejects an unsupported type', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validHost, type: 'authgroup' } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'unsupported_type'))
})

test('requires at least one content entry', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validHost, content: [] } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('content') && e.code === 'required'))
})

test('rejects an invalid host content entry', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validHost, content: ['not an ip!!'] } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'invalid_entry'))
})

test('requires an interface for a dynamic IPv6 host alias', async () => {
  const result = await validate(
    makeCtx([{ id: 'a', name: 'a', fields: { name: 'dyn6', type: 'dynipv6host', content: ['::1000'] } }]),
  )
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.field.includes('interface') && e.code === 'required'))
})

test('accepts a dynamic IPv6 host alias with an interface set', async () => {
  const result = await validate(
    makeCtx([{ id: 'a', name: 'a', fields: { name: 'dyn6', type: 'dynipv6host', content: ['::1000'], interface: 'wan' } }]),
  )
  assert.equal(result.valid, true)
})

test('rejects a negative update frequency', async () => {
  const result = await validate(makeCtx([{ id: 'a', name: 'a', fields: { ...validHost, updatefreq: -1 } }]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'invalid_value'))
})

test('extractAliasSpecs trims fields and reads content/proto lists', () => {
  const specs = extractAliasSpecs(
    makeCtx([{ id: 'e', name: 'e', fields: { name: '  web_02  ', type: 'host', content: ['10.0.0.9', ' 10.0.0.10 '], proto: ['IPv4'] } }])
      .canvas,
  )
  assert.equal(specs[0].name, 'web_02')
  assert.deepEqual(specs[0].content, ['10.0.0.9', '10.0.0.10'])
  assert.deepEqual(specs[0].proto, ['IPv4'])
  assert.equal(aliasKey('web_02'), 'web_02')
})

test('extractAliasSpecs defaults enabled to true unless explicitly false', () => {
  const [withDefault] = extractAliasSpecs(makeCtx([{ id: 'a', name: 'a', fields: { name: 'a', type: 'host' } }]).canvas)
  assert.equal(withDefault.enabled, true)
  const [disabled] = extractAliasSpecs(makeCtx([{ id: 'a', name: 'a', fields: { name: 'a', type: 'host', enabled: false } }]).canvas)
  assert.equal(disabled.enabled, false)
})

test('strList handles arrays, comma/newline strings and blanks', () => {
  assert.deepEqual(strList(['a', ' b ', '']), ['a', 'b'])
  assert.deepEqual(strList('a,b\nc'), ['a', 'b', 'c'])
  assert.deepEqual(strList(undefined), [])
})

test('isSupportedAliasType accepts the 11 modeled types and rejects the rest', () => {
  assert.equal(isSupportedAliasType('host'), true)
  assert.equal(isSupportedAliasType('networkgroup'), true)
  assert.equal(isSupportedAliasType('authgroup'), false)
  assert.equal(isSupportedAliasType('internal'), false)
  assert.equal(isSupportedAliasType('external'), false)
})

test('isValidIpv4 accepts/rejects correctly', () => {
  assert.equal(isValidIpv4('10.0.0.1'), true)
  assert.equal(isValidIpv4('255.255.255.255'), true)
  assert.equal(isValidIpv4('256.0.0.1'), false)
  assert.equal(isValidIpv4('not-an-ip'), false)
})

test('isValidIpv6 accepts common forms', () => {
  assert.equal(isValidIpv6('2001:db8::1'), true)
  assert.equal(isValidIpv6('::1'), true)
  assert.equal(isValidIpv6('10.0.0.1'), false)
})

test('isValidHostEntry accepts IPs, ranges, exclusions, hostnames and alias refs', () => {
  assert.equal(isValidHostEntry('10.0.0.5'), true)
  assert.equal(isValidHostEntry('10.0.0.5-10.0.0.9'), true)
  assert.equal(isValidHostEntry('!10.0.0.5'), true)
  assert.equal(isValidHostEntry('host.example.com'), true)
  assert.equal(isValidHostEntry('other_alias'), true)
  assert.equal(isValidHostEntry('not an ip!!'), false)
})

test('isValidNetworkEntry accepts CIDR and rejects garbage', () => {
  assert.equal(isValidNetworkEntry('10.0.0.0/24'), true)
  assert.equal(isValidNetworkEntry('2001:db8::/32'), true)
  assert.equal(isValidNetworkEntry('10.0.0.0/99'), false)
})

test('isValidPortEntry accepts a port, a range, and rejects out-of-range values', () => {
  assert.equal(isValidPortEntry('443'), true)
  assert.equal(isValidPortEntry('1000-2000'), true)
  assert.equal(isValidPortEntry('70000'), false)
})

test('isValidMacEntry accepts partial MACs', () => {
  assert.equal(isValidMacEntry('00:11:22:33:44:55'), true)
  assert.equal(isValidMacEntry('00:11'), true)
  assert.equal(isValidMacEntry('not-a-mac'), false)
})

test('isValidAsnEntry accepts a valid ASN range', () => {
  assert.equal(isValidAsnEntry('64512'), true)
  assert.equal(isValidAsnEntry('0'), false)
  assert.equal(isValidAsnEntry('9999999999'), false)
})

test('isValidGeoipEntry accepts 2-letter codes and EU', () => {
  assert.equal(isValidGeoipEntry('US'), true)
  assert.equal(isValidGeoipEntry('EU'), true)
  assert.equal(isValidGeoipEntry('usa'), false)
})

test('isValidNetworkGroupEntry requires an alias-name shape', () => {
  assert.equal(isValidNetworkGroupEntry('other_alias'), true)
  assert.equal(isValidNetworkGroupEntry('not a name'), false)
})

test('isValidPartialIpv6Entry accepts a partial suffix', () => {
  assert.equal(isValidPartialIpv6Entry('::1000'), true)
  assert.equal(isValidPartialIpv6Entry('not-ipv6'), false)
})

test('validateContentEntry dispatches per type and is lenient for url-family types', () => {
  assert.equal(validateContentEntry('host', '10.0.0.5'), null)
  assert.equal(
    validateContentEntry('host', 'garbage!!'),
    '"garbage!!" is not a valid hostname, IP address, range, or alias reference',
  )
  assert.equal(validateContentEntry('url', 'anything goes here'), null)
})

test('buildAliasBody always includes every managed field as a string', () => {
  const [spec] = extractAliasSpecs(
    makeCtx([{ id: 'a', name: 'a', fields: { name: 'web', type: 'host', content: ['10.0.0.5', '10.0.0.6'], description: 'servers' } }])
      .canvas,
  )
  const body = buildAliasBody(spec)
  assert.deepEqual(body, {
    enabled: '1',
    name: 'web',
    type: 'host',
    content: '10.0.0.5\n10.0.0.6',
    description: 'servers',
    proto: '',
    interface: '',
    updatefreq: '',
  })
})

test('snapshotLive carries a searchItem row straight into a setItem-ready body', () => {
  const live: LiveAlias = {
    uuid: 'u1',
    name: 'web',
    type: 'host',
    enabled: '1',
    content: '10.0.0.5\n10.0.0.6',
    description: 'servers',
  }
  assert.deepEqual(snapshotLive(live), {
    enabled: '1',
    name: 'web',
    type: 'host',
    content: '10.0.0.5\n10.0.0.6',
    description: 'servers',
    proto: '',
    interface: '',
    updatefreq: '',
  })
})

test('liveContentList splits on newline and drops blanks', () => {
  assert.deepEqual(liveContentList({ uuid: 'u1', content: '10.0.0.5\n\n10.0.0.6\n' }), ['10.0.0.5', '10.0.0.6'])
})

test('sameEntrySet is order-insensitive but case-sensitive', () => {
  assert.equal(sameEntrySet(['a', 'b'], ['b', 'a']), true)
  assert.equal(sameEntrySet(['a'], ['A']), false)
  assert.equal(sameEntrySet(['a'], ['a', 'b']), false)
})
