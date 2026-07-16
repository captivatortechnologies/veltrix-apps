import validate, { extractDomainSpecs, domainKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'proofpoint',
    customerId: 'cust-1',
    configTypeId: 'pp-domains',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'proofpoint',
      entityType: 'pp-domains',
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

describe('Proofpoint Domains Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a simple active domain', async () => {
    const result = await validate(makeCtx([{ name: 'Domain', fields: { name: 'acme.com', is_active: true } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing domain name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { is_active: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an invalid domain name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'not a domain' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_domain')).toBe(true)
  })

  it('requires a destination when relay delivery is enabled', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'acme.com', is_relay: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'relay_needs_destination')).toBe(true)
  })

  it('accepts a relay domain with a destination', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'acme.com', is_relay: true, destination: 'mail.acme.com' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('warns on a non-host destination but stays valid', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'acme.com', is_relay: true, destination: 'bogus dest' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'destination_format')).toBe(true)
  })

  it('rejects duplicate domain names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'acme.com' } },
        { name: 'b', fields: { name: 'ACME.com' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_domain')).toBe(true)
  })

  it('extractDomainSpecs defaults is_active true / is_relay false and parses failovers', () => {
    const specs = extractDomainSpecs(
      makeCtx([{ name: 'd', fields: { name: '  acme.com ', failovers: 'a.acme.com, b.acme.com' } }]).canvas,
    )
    expect(specs[0].name).toBe('acme.com')
    expect(specs[0].isActive).toBe(true)
    expect(specs[0].isRelay).toBe(false)
    expect(specs[0].failovers).toEqual(['a.acme.com', 'b.acme.com'])
    expect(domainKey('ACME.com')).toBe('acme.com')
  })
})
