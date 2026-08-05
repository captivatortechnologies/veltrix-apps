import validate, { extractTurnstileWidgetSpecs, parseDomains, widgetKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-turnstile-widgets',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-turnstile-widgets',
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

describe('Cloudflare Turnstile Widgets Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid widget', async () => {
    const result = await validate(
      makeCtx([{ name: 'w1', fields: { name: 'Login form', mode: 'managed', domains: 'example.com' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'w1', fields: { domains: 'example.com' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing domain', async () => {
    const result = await validate(makeCtx([{ name: 'w1', fields: { name: 'Login form' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('domains'))).toBe(true)
  })

  it('rejects an invalid mode', async () => {
    const result = await validate(
      makeCtx([{ name: 'w1', fields: { name: 'Login form', mode: 'weird', domains: 'example.com' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_mode')).toBe(true)
  })

  it('rejects an invalid region', async () => {
    const result = await validate(
      makeCtx([{ name: 'w1', fields: { name: 'Login form', domains: 'example.com', region: 'moon' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_region')).toBe(true)
  })

  it('rejects duplicate widget names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Login form', domains: 'example.com' } },
        { name: 'b', fields: { name: 'login form', domains: 'other.example.com' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_widget')).toBe(true)
  })

  it('extractTurnstileWidgetSpecs applies defaults and parses multi-line domains', () => {
    const specs = extractTurnstileWidgetSpecs(
      makeCtx([{ name: 'r', fields: { name: '  Login form  ', domains: 'example.com\n\nother.example.com\n' } }])
        .canvas,
    )
    expect(specs[0].name).toBe('Login form')
    expect(specs[0].mode).toBe('managed')
    expect(specs[0].region).toBe('world')
    expect(specs[0].clearanceLevel).toBe('no_clearance')
    expect(specs[0].domains).toEqual(['example.com', 'other.example.com'])
  })

  it('widgetKey folds case and parseDomains ignores blank lines', () => {
    expect(widgetKey('Login form')).toBe(widgetKey('  login form  '))
    expect(parseDomains('a.com\n \nb.com')).toEqual(['a.com', 'b.com'])
    expect(parseDomains(undefined)).toEqual([])
  })
})
