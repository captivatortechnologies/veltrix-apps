import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-cloud',
    customerId: 'cust-1',
    configTypeId: 'authentication-tokens',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Token Settings Canvas',
      toolType: 'splunk-cloud',
      entityType: 'authentication-tokens',
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

describe('Splunk Cloud Authentication Token Settings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates enablement with a default expiration', async () => {
    const result = await validate(
      makeCtx([{ name: 'settings', fields: { tokenAuthEnabled: true, defaultExpiration: '+30d' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('validates enablement without a default expiration (blank is allowed)', async () => {
    const result = await validate(makeCtx([{ name: 'settings', fields: { tokenAuthEnabled: true } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts the string forms "true"/"false" for the checkbox', async () => {
    const result = await validate(
      makeCtx([{ name: 'settings', fields: { tokenAuthEnabled: 'true', defaultExpiration: '+12h' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('accepts a range of Splunk relative-time expirations', async () => {
    for (const expiration of ['+90d', '+6h', '+1w', '+3mon', '+45s']) {
      const result = await validate(
        makeCtx([{ name: 'settings', fields: { tokenAuthEnabled: true, defaultExpiration: expiration } }]),
      )
      expect(result.valid).toBe(true)
    }
  })

  it('rejects a missing tokenAuthEnabled', async () => {
    const result = await validate(makeCtx([{ name: 'settings', fields: { defaultExpiration: '+30d' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a non-boolean tokenAuthEnabled', async () => {
    const result = await validate(makeCtx([{ name: 'settings', fields: { tokenAuthEnabled: 'yes' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_enabled')).toBe(true)
  })

  it('rejects an invalid default expiration', async () => {
    const result = await validate(
      makeCtx([{ name: 'settings', fields: { tokenAuthEnabled: true, defaultExpiration: '30 days' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_expiration')).toBe(true)
  })

  it('rejects an expiration missing the leading +', async () => {
    const result = await validate(
      makeCtx([{ name: 'settings', fields: { tokenAuthEnabled: true, defaultExpiration: '30d' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_expiration')).toBe(true)
  })

  it('rejects more than one settings object (single-object configuration)', async () => {
    const result = await validate(
      makeCtx([
        { name: 's1', fields: { tokenAuthEnabled: true } },
        { name: 's2', fields: { tokenAuthEnabled: false } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'single_object')).toBe(true)
  })

  it('warns (does not block) when token authentication is disabled', async () => {
    const result = await validate(makeCtx([{ name: 'settings', fields: { tokenAuthEnabled: false } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'token_auth_disabled')).toBe(true)
  })

  it('warns on very long-lived default expirations', async () => {
    const result = await validate(
      makeCtx([{ name: 'settings', fields: { tokenAuthEnabled: true, defaultExpiration: '+2y' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'long_expiration')).toBe(true)
  })

  it('does not warn on a reasonable default expiration', async () => {
    const result = await validate(
      makeCtx([{ name: 'settings', fields: { tokenAuthEnabled: true, defaultExpiration: '+30d' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'long_expiration')).toBe(false)
  })
})
