import validate from '../validate'
import {
  extractResourceSpecs,
  idSetSignature,
  parsePortRangeEntry,
  parsePortRanges,
  portsSignature,
  declaredPortsSignature,
  readBool,
  resourceKey,
  strList,
} from '../_shared'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCanvas(items: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'twingate',
    entityType: 'resources',
    items,
    sections: items,
    snapshot: {},
  }
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'twingate',
    customerId: 'cust-1',
    configTypeId: 'resources',
    canvas: makeCanvas(items),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const validFields = {
  name: 'internal-wiki',
  address: '10.0.1.5',
  remote_network_name: 'HQ Network',
}

describe('Twingate Resources validate handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal valid resource', async () => {
    const result = await validate(makeCtx([{ name: 'Resource 1', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires name, address and remote network name', async () => {
    const result = await validate(makeCtx([{ name: 'item1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('address'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('remote_network_name'))).toBe(true)
  })

  it('rejects an unsupported TCP/UDP policy', async () => {
    const result = await validate(makeCtx([{ name: 'item1', fields: { ...validFields, tcp_policy: 'MAYBE' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policy' && e.field.includes('tcp_policy'))).toBe(true)
  })

  it('requires at least one port when the policy is Restricted', async () => {
    const result = await validate(makeCtx([{ name: 'item1', fields: { ...validFields, tcp_policy: 'RESTRICTED' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('tcp_ports'))).toBe(true)
  })

  it('accepts Restricted with a valid port and range', async () => {
    const result = await validate(
      makeCtx([
        { name: 'item1', fields: { ...validFields, tcp_policy: 'RESTRICTED', tcp_ports: ['443', '8000-9000'] } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a malformed port entry', async () => {
    const result = await validate(
      makeCtx([{ name: 'item1', fields: { ...validFields, tcp_policy: 'RESTRICTED', tcp_ports: ['not-a-port'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_port')).toBe(true)
  })

  it('warns (but does not error) when ports are set on a non-Restricted policy', async () => {
    const result = await validate(
      makeCtx([{ name: 'item1', fields: { ...validFields, tcp_policy: 'ALLOW_ALL', tcp_ports: ['443'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'ignored_ports')).toBe(true)
  })

  it('rejects duplicate resource names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Internal Wiki' } },
        { name: 'b', fields: { ...validFields, name: 'internal wiki' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_resource')).toBe(true)
  })
})

describe('Twingate Resources shared helpers', () => {
  it('extractResourceSpecs defaults, trims and reads lists/booleans', () => {
    const canvas = makeCanvas([
      {
        name: 'Item A',
        fields: {
          name: '  Internal Wiki  ',
          address: ' 10.0.1.5 ',
          remote_network_name: ' HQ Network ',
          group_names: 'Engineering, Ops',
          is_visible: false,
        },
      },
    ])
    const specs = extractResourceSpecs(canvas)
    expect(specs[0].itemName).toBe('Item A')
    expect(specs[0].name).toBe('Internal Wiki')
    expect(specs[0].address).toBe('10.0.1.5')
    expect(specs[0].remoteNetworkName).toBe('HQ Network')
    expect(specs[0].tcpPolicy).toBe('ALLOW_ALL')
    expect(specs[0].udpPolicy).toBe('ALLOW_ALL')
    expect(specs[0].isVisible).toBe(false)
    expect(specs[0].isBrowserShortcutEnabled).toBe(false)
    expect(specs[0].allowIcmp).toBe(true)
    expect(specs[0].groupNames).toEqual(['Engineering', 'Ops'])
    expect(resourceKey('  Internal Wiki ')).toBe('internal wiki')
  })

  it('readBool and strList behave as documented', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(readBool(false, true)).toBe(false)
    expect(strList(['a', ' b '])).toEqual(['a', 'b'])
    expect(strList('a,b, ')).toEqual(['a', 'b'])
  })

  it('parsePortRangeEntry accepts single ports and ranges, rejects malformed/out-of-range', () => {
    expect(parsePortRangeEntry('443')).toEqual({ start: 443, end: 443 })
    expect(parsePortRangeEntry('8000-9000')).toEqual({ start: 8000, end: 9000 })
    expect(parsePortRangeEntry('9000-8000')).toBeNull()
    expect(parsePortRangeEntry('0')).toBeNull()
    expect(parsePortRangeEntry('70000')).toBeNull()
    expect(parsePortRangeEntry('abc')).toBeNull()
  })

  it('parsePortRanges separates valid ranges from invalid raw entries', () => {
    const { ranges, invalid } = parsePortRanges(['443', 'bogus', '100-200'])
    expect(ranges).toEqual([
      { start: 443, end: 443 },
      { start: 100, end: 200 },
    ])
    expect(invalid).toEqual(['bogus'])
  })

  it('portsSignature and declaredPortsSignature agree on the same ranges regardless of order', () => {
    const live = portsSignature([
      { start: 8000, end: 9000 },
      { start: 443, end: 443 },
    ])
    const declared = declaredPortsSignature(['443', '8000-9000'])
    expect(live).toBe(declared)
  })

  it('idSetSignature is order- and case-insensitive and de-duplicates', () => {
    expect(idSetSignature(['b', 'a', 'B'])).toBe(idSetSignature(['A', 'b']))
  })
})
