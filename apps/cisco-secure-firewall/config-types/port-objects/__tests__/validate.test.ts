import validate, { extractPortObjectSpecs, buildPortObjectFields, effectiveProtocol } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-secure-firewall',
    customerId: 'cust-1',
    configTypeId: 'port-objects',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-secure-firewall',
      entityType: 'port-objects',
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
    entityType: 'port-objects',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Port Objects validate handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal TCP port object', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'https', protocol: 'TCP', port: '443' } }]))
    expect(result.valid).toBe(true)
  })

  it('accepts a port range', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'ephemeral', protocol: 'TCP', port: '1024-2048' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a malformed port', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'bad-port', protocol: 'TCP', port: 'abc' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_port')).toBe(true)
  })

  it('requires a numeric protocol_other when protocol is "other"', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'gre', protocol: 'other' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_protocol')).toBe(true)
  })

  it('accepts "other" with a numeric protocol_other', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'gre', protocol: 'other', protocol_other: '47' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'https', protocol: 'TCP', port: '443' } },
        { name: 'sec2', fields: { name: 'https', protocol: 'TCP', port: '8443' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })
})

describe('extractPortObjectSpecs / effectiveProtocol', () => {
  it('defaults protocol to TCP when blank', () => {
    const specs = extractPortObjectSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'https', port: '443' } }]))
    expect(specs[0].protocol).toBe('TCP')
    expect(effectiveProtocol(specs[0])).toBe('TCP')
  })

  it('uses protocol_other when protocol is "other"', () => {
    const specs = extractPortObjectSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'gre', protocol: 'other', protocol_other: '47' } }]))
    expect(effectiveProtocol(specs[0])).toBe('47')
  })
})

describe('buildPortObjectFields', () => {
  it('includes port and description when set', () => {
    const fields = buildPortObjectFields({
      sectionName: 's',
      name: 'https',
      protocol: 'TCP',
      protocolOther: '',
      port: '443',
      description: 'HTTPS',
      overridable: false,
    })
    expect(fields).toEqual({ protocol: 'TCP', overridable: false, port: '443', description: 'HTTPS' })
  })
})
