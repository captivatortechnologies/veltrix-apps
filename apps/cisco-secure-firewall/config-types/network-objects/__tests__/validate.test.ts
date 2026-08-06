import validate, { extractNetworkObjectSpecs, buildNetworkObjectFields, pathForKind } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-secure-firewall',
    customerId: 'cust-1',
    configTypeId: 'network-objects',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-secure-firewall',
      entityType: 'network-objects',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'cisco-secure-firewall',
    entityType: 'network-objects',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Network Objects validate handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal host object', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'web-1', kind: 'host', value: '10.1.1.5' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { kind: 'host', value: '10.1.1.5' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name with spaces', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'web server', kind: 'host', value: '10.1.1.5' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects an unsupported kind', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'obj-1', kind: 'subnet', value: '10.1.1.0/24' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_kind')).toBe(true)
  })

  it('rejects a network value with no CIDR slash', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'net-1', kind: 'network', value: '10.1.1.0' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects a range value with no dash', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'range-1', kind: 'range', value: '10.1.1.1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'web-1', kind: 'host', value: '10.1.1.5' } },
        { name: 'sec2', fields: { name: 'web-1', kind: 'host', value: '10.1.1.6' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('rejects an invalid dns_resolution for an fqdn object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'app-1', kind: 'fqdn', value: 'app.example.com', dns_resolution: 'IPV5' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_dns_resolution')).toBe(true)
  })
})

describe('extractNetworkObjectSpecs', () => {
  it('defaults kind to host and dns_resolution when blank', () => {
    const specs = extractNetworkObjectSpecs(makeCanvas([{ name: 'sec1', fields: { name: '  web-1  ', value: ' 10.1.1.5 ' } }]))
    expect(specs[0].name).toBe('web-1')
    expect(specs[0].kind).toBe('host')
    expect(specs[0].dnsResolution).toBe('IPV4_AND_IPV6')
    expect(specs[0].value).toBe('10.1.1.5')
  })
})

describe('buildNetworkObjectFields', () => {
  it('omits dnsResolution for non-fqdn kinds', () => {
    const fields = buildNetworkObjectFields({
      sectionName: 's',
      name: 'web-1',
      kind: 'host',
      value: '10.1.1.5',
      dnsResolution: 'IPV4_AND_IPV6',
      description: '',
      overridable: false,
    })
    expect(fields).toEqual({ value: '10.1.1.5', overridable: false })
  })

  it('includes dnsResolution and description for an fqdn', () => {
    const fields = buildNetworkObjectFields({
      sectionName: 's',
      name: 'app-1',
      kind: 'fqdn',
      value: 'app.example.com',
      dnsResolution: 'IPV4_ONLY',
      description: 'App tier',
      overridable: true,
    })
    expect(fields).toEqual({ value: 'app.example.com', overridable: true, dnsResolution: 'IPV4_ONLY', description: 'App tier' })
  })
})

describe('pathForKind', () => {
  it('maps each kind to its FMC endpoint', () => {
    expect(pathForKind('host')).toBe('/object/hosts')
    expect(pathForKind('network')).toBe('/object/networks')
    expect(pathForKind('range')).toBe('/object/ranges')
    expect(pathForKind('fqdn')).toBe('/object/fqdns')
  })
})
