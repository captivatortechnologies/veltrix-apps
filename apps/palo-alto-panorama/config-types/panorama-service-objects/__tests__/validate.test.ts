import validate, { extractServiceSpecs, buildServiceFields, serviceDriftDiffs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId: 'panorama-service-objects',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-service-objects',
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

describe('Panorama Service Objects Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid tcp service', async () => {
    const result = await validate(makeCtx([{ name: 's', fields: { name: 'https', protocol: 'tcp', port: '443' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects an invalid port spec', async () => {
    const result = await validate(makeCtx([{ name: 's', fields: { name: 'x', protocol: 'tcp', port: 'abc' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_port')).toBe(true)
  })

  it('accepts port ranges and lists', async () => {
    const result = await validate(makeCtx([{ name: 's', fields: { name: 'x', protocol: 'udp', port: '80-88,443' } }]))
    expect(result.valid).toBe(true)
  })

  it('builds nested protocol fields and detects drift', () => {
    const spec = extractServiceSpecs(makeCtx([{ name: 's', fields: { name: 'https', protocol: 'tcp', port: '443' } }]).canvas)[0]
    expect(buildServiceFields(spec)).toEqual({ protocol: { tcp: { port: '443' } } })
    expect(serviceDriftDiffs(spec, { '@name': 'https', protocol: { tcp: { port: '443' } } })).toHaveLength(0)
    expect(serviceDriftDiffs(spec, { '@name': 'https', protocol: { tcp: { port: '8443' } } }).length).toBeGreaterThan(0)
  })
})
