import validate, { extractBrandSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'onelogin',
    customerId: 'cust-1',
    configTypeId: 'brands',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'onelogin',
      entityType: 'brands',
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

describe('OneLogin Brands Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid brand (name only)', async () => {
    const result = await validate(makeCtx([{ name: 'Brand', fields: { name: 'Acme Branding' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid brand with every field set', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Brand',
          fields: {
            name: 'Acme Branding',
            enabled: true,
            customColor: '#1298b4',
            customAccentColor: '#b60012',
            customMaskingColor: '#beefed',
            customMaskingOpacity: 40,
            enableCustomLabelForLoginScreen: true,
            customLabelTextForLoginScreen: 'ACME Username',
            loginInstructionTitle: 'Login Instructions',
            loginInstruction: 'Enter your ACME credentials.',
            hideOneloginFooter: true,
            mfaEnrollmentMessage: 'Please enroll',
            customSupportEnabled: true,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a duplicate brand name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Acme Branding' } },
        { name: 'sec2', fields: { name: 'Acme Branding' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_brand')).toBe(true)
  })

  it('rejects an invalid hex color', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Acme Branding', customColor: 'not-a-color' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_color')).toBe(true)
  })

  it('accepts a 3-digit hex color', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Acme Branding', customColor: '#1a2' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects an out-of-range masking opacity', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Acme Branding', customMaskingOpacity: 150 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_opacity')).toBe(true)
  })

  it('accepts masking opacity at the boundaries', async () => {
    const result0 = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Acme Branding', customMaskingOpacity: 0 } }]))
    const result100 = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Acme Branding', customMaskingOpacity: 100 } }]))
    expect(result0.valid).toBe(true)
    expect(result100.valid).toBe(true)
  })
})

describe('extractBrandSpecs', () => {
  it('defaults booleans and trims strings', () => {
    const specs = extractBrandSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'onelogin',
      entityType: 'brands',
      items: [],
      sections: [{ name: 'sec1', fields: { name: '  Acme Branding  ' } }],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Acme Branding')
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].enableCustomLabelForLoginScreen).toBe(false)
    expect(specs[0].hideOneloginFooter).toBe(false)
    expect(specs[0].customSupportEnabled).toBe(false)
    expect(specs[0].customColor).toBeUndefined()
  })
})
