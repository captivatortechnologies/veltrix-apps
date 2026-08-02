import validate, { extractServiceSpecs, isValidPortSpec, serviceKey, SERVICE_COMMANDS } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'checkpoint',
    customerId: 'cust-1',
    configTypeId: 'service-objects',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'checkpoint',
      entityType: 'service-objects',
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

const validFields = { name: 'custom-https', protocol: 'tcp', port: '8443' }

describe('Check Point Service Objects Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a TCP service with a single port', async () => {
    const result = await validate(makeCtx([{ name: 'Svc', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a UDP service with a port range', async () => {
    const result = await validate(makeCtx([{ name: 'Svc', fields: { name: 'udp-range', protocol: 'udp', port: '5000-5010' } }]))
    expect(result.valid).toBe(true)
  })

  it('validates a comma port list', async () => {
    const result = await validate(makeCtx([{ name: 'Svc', fields: { ...validFields, port: '80,443,8080-8090' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: '', fields: { protocol: 'tcp', port: '80' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('requires a port', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'no-port', protocol: 'tcp' } }]))
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('port'))).toBe(true)
  })

  it('rejects an out-of-range port', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'bad', protocol: 'tcp', port: '70000' } }]))
    expect(result.errors.some((e) => e.code === 'invalid_port')).toBe(true)
  })

  it('rejects a backwards range', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'bad', protocol: 'tcp', port: '100-50' } }]))
    expect(result.errors.some((e) => e.code === 'invalid_port')).toBe(true)
  })

  it('rejects an invalid source port', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, sourcePort: 'not-a-port' } }]))
    expect(result.errors.some((e) => e.code === 'invalid_port' && e.field.includes('sourcePort'))).toBe(true)
  })

  it('rejects duplicate service names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Custom-HTTPS' } },
        { name: 'b', fields: { ...validFields, name: 'custom-https' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('defaults an unrecognized protocol to tcp during extraction', () => {
    const specs = extractServiceSpecs(makeCtx([{ name: 'e', fields: { name: 'x', protocol: 'sctp', port: '80' } }]).canvas)
    expect(specs[0].protocol).toBe('tcp')
  })

  it('extractServiceSpecs trims fields', () => {
    const specs = extractServiceSpecs(makeCtx([{ name: 'e', fields: { name: '  svc-2  ', protocol: 'UDP', port: ' 53 ' } }]).canvas)
    expect(specs[0].name).toBe('svc-2')
    expect(specs[0].protocol).toBe('udp')
    expect(specs[0].port).toBe('53')
    expect(serviceKey('  Svc-2 ')).toBe('svc-2')
  })
})

describe('isValidPortSpec', () => {
  it('accepts a single port', () => {
    expect(isValidPortSpec('443')).toBe(true)
    expect(isValidPortSpec('1')).toBe(true)
    expect(isValidPortSpec('65535')).toBe(true)
  })

  it('accepts a range', () => {
    expect(isValidPortSpec('8000-8010')).toBe(true)
  })

  it('accepts a comma list of ports and ranges', () => {
    expect(isValidPortSpec('80,443,8080-8090')).toBe(true)
  })

  it('rejects out-of-range, backwards, empty or malformed values', () => {
    expect(isValidPortSpec('0')).toBe(false)
    expect(isValidPortSpec('65536')).toBe(false)
    expect(isValidPortSpec('100-50')).toBe(false)
    expect(isValidPortSpec('')).toBe(false)
    expect(isValidPortSpec('http')).toBe(false)
  })
})

describe('SERVICE_COMMANDS', () => {
  it('maps each protocol to its own command family', () => {
    expect(SERVICE_COMMANDS.tcp.add).toBe('add-service-tcp')
    expect(SERVICE_COMMANDS.tcp.showAll).toBe('show-services-tcp')
    expect(SERVICE_COMMANDS.udp.delete).toBe('delete-service-udp')
    expect(SERVICE_COMMANDS.udp.showAll).toBe('show-services-udp')
  })
})
