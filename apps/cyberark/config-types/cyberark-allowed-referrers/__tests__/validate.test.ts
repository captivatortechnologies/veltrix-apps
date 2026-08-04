import validate, { extractAllowedReferrerSpecs, referrerKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cyberark',
    customerId: 'cust-1',
    configTypeId: 'cyberark-allowed-referrers',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cyberark',
      entityType: 'cyberark-allowed-referrers',
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

const validFields = { referrer_url: 'https://portal.example.com/' }

describe('CyberArk Allowed Referrers Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal referrer', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires referrer_url', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('warns (not errors) on a non-URL-looking referrer', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { referrer_url: 'not-a-url' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'suspicious_referrer')).toBe(true)
  })

  it('does not warn when regular_expression is enabled', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { referrer_url: '^https://.*\\.example\\.com$', regular_expression: true } }]))
    expect(result.warnings).toHaveLength(0)
  })

  it('rejects duplicate referrer URLs case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields } },
        { name: 'b', fields: { referrer_url: validFields.referrer_url.toUpperCase() } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_referrer')).toBe(true)
  })

  it('extracts specs with defaults', () => {
    const specs = extractAllowedReferrerSpecs(makeCtx([{ name: 'a', fields: { ...validFields } }]).canvas)
    expect(specs[0].referrerUrl).toBe('https://portal.example.com/')
    expect(specs[0].regularExpression).toBe(false)
    expect(referrerKey(specs[0])).toBe(referrerKey({ referrerUrl: 'HTTPS://PORTAL.EXAMPLE.COM/' }))
  })
})
