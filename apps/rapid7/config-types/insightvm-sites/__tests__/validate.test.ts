import validate, { extractSiteSpecs, siteKey, parseLines } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'rapid7',
    customerId: 'cust-1',
    configTypeId: 'insightvm-sites',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'rapid7',
      entityType: 'insightvm-sites',
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

describe('InsightVM Sites Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid site', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Site',
          fields: {
            name: 'DMZ',
            description: 'Perimeter hosts',
            importance: 'high',
            included_addresses: '10.0.0.0/24\n10.0.1.5',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name and missing included addresses', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { description: 'no name, no targets' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('included_addresses'))).toBe(true)
  })

  it('rejects an unsupported importance', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x', importance: 'critical', included_addresses: '1.2.3.4' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_importance')).toBe(true)
  })

  it('defaults importance to normal when blank', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x', included_addresses: '1.2.3.4' } }]))
    expect(result.valid).toBe(true)
    const specs = extractSiteSpecs(makeCtx([{ name: 'sec1', fields: { name: 'x', included_addresses: '1.2.3.4' } }]).canvas)
    expect(specs[0].importance).toBe('normal')
  })

  it('rejects duplicate site names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'DMZ', included_addresses: '1.1.1.1' } },
        { name: 'b', fields: { name: 'dmz', included_addresses: '2.2.2.2' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_site')).toBe(true)
  })

  it('extract + helpers behave', () => {
    expect(parseLines('  ')).toEqual([])
    expect(parseLines('10.0.0.1\n  10.0.0.2  \n\n10.0.0.3')).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3'])
    const specs = extractSiteSpecs(
      makeCtx([
        {
          name: 's',
          fields: {
            name: '  DMZ  ',
            engine_id: '7',
            scan_template_id: '  full-audit  ',
            included_addresses: 'a\nb',
            excluded_addresses: 'x',
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('DMZ')
    expect(specs[0].engineId).toBe(7)
    expect(specs[0].scanTemplateId).toBe('full-audit')
    expect(specs[0].includedAddresses).toEqual(['a', 'b'])
    expect(specs[0].excludedAddresses).toEqual(['x'])
    expect(siteKey(specs[0])).toBe(siteKey({ name: 'dmz' }))
  })
})
