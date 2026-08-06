import validate, { extractSecurityZoneSpecs, buildSecurityZoneFields, securityZoneDriftDiffs } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-secure-firewall',
    customerId: 'cust-1',
    configTypeId: 'security-zones',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-secure-firewall',
      entityType: 'security-zones',
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
    entityType: 'security-zones',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Security Zones validate handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal zone', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'inside', interface_type: 'ROUTED' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { interface_type: 'ROUTED' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an unsupported interface mode', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'inside', interface_type: 'BRIDGE' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_interface_type')).toBe(true)
  })

  it('rejects a duplicate zone name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'inside', interface_type: 'ROUTED' } },
        { name: 'sec2', fields: { name: 'inside', interface_type: 'ROUTED' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })
})

describe('extractSecurityZoneSpecs', () => {
  it('defaults interface_type to ROUTED when blank', () => {
    const specs = extractSecurityZoneSpecs(makeCanvas([{ name: 'sec1', fields: { name: '  inside  ' } }]))
    expect(specs[0].name).toBe('inside')
    expect(specs[0].interfaceType).toBe('ROUTED')
  })
})

describe('buildSecurityZoneFields / securityZoneDriftDiffs', () => {
  it('maps interfaceType to interfaceMode', () => {
    expect(buildSecurityZoneFields({ sectionName: 's', name: 'inside', interfaceType: 'ROUTED', description: '' })).toEqual({
      interfaceMode: 'ROUTED',
    })
  })

  it('flags a changed interface mode as drift', () => {
    const diffs = securityZoneDriftDiffs(
      { sectionName: 's', name: 'inside', interfaceType: 'ROUTED', description: '' },
      { interfaceMode: 'SWITCHED' },
    )
    expect(diffs.some((d) => d.field === 'inside.interface_type')).toBe(true)
  })
})
