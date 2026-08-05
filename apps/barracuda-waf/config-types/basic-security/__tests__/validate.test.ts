import validate, { extractBasicSecuritySpec, buildBasicSecurityBody } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'barracuda-waf',
    customerId: 'cust-1',
    configTypeId: 'basic-security',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'barracuda-waf',
      entityType: 'basic-security',
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

describe('Barracuda WAF Basic Security Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates Active mode', async () => {
    const result = await validate(makeCtx([{ name: 'Basic Security', fields: { protection_mode: 'Active' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates Passive mode', async () => {
    const result = await validate(makeCtx([{ name: 'Basic Security', fields: { protection_mode: 'Passive' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects an unrecognized mode', async () => {
    const result = await validate(makeCtx([{ name: 'Basic Security', fields: { protection_mode: 'Enforce' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_mode')).toBe(true)
  })

  it('rejects more than one declared item (singleton)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { protection_mode: 'Active' } },
        { name: 'b', fields: { protection_mode: 'Passive' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'singleton')).toBe(true)
  })

  it('extractBasicSecuritySpec defaults to Passive when unset', () => {
    const spec = extractBasicSecuritySpec(makeCtx([{ name: 's', fields: {} }]).canvas)
    expect(spec.protectionMode).toBe('Passive')
  })

  it('buildBasicSecurityBody maps the spec onto the wire shape', () => {
    expect(buildBasicSecurityBody({ protectionMode: 'Active' })).toEqual({ protection_mode: 'Active' })
  })
})
