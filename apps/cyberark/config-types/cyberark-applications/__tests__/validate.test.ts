import validate, { appKey, authMethodSignature, extractApplicationSpecs, parseAuthMethods } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cyberark',
    customerId: 'cust-1',
    configTypeId: 'cyberark-applications',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cyberark',
      entityType: 'cyberark-applications',
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

const validFields = { app_id: 'AAM-BillingService' }

describe('CyberArk Applications Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal application', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires an app_id', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('app_id'))).toBe(true)
  })

  it('rejects an out-of-range access hour', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields, access_permitted_from_hour: 24 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_hour')).toBe(true)
  })

  it('rejects malformed authentication_methods JSON', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields, authentication_methods: '{not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_auth_methods')).toBe(true)
  })

  it('rejects an unrecognised authType', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: { ...validFields, authentication_methods: JSON.stringify([{ authType: 'password' }]) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_auth_methods')).toBe(true)
  })

  it('rejects a certificateattr method with no issuer/subject/SAN', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: { ...validFields, authentication_methods: JSON.stringify([{ authType: 'certificateattr' }]) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_auth_methods')).toBe(true)
  })

  it('accepts a well-formed machineAddress (allowed-machine) method', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: { ...validFields, authentication_methods: JSON.stringify([{ authType: 'machineAddress', authValue: '10.0.0.25' }]) } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate authentication methods', async () => {
    const methods = JSON.stringify([
      { authType: 'machineAddress', authValue: '10.0.0.25' },
      { authType: 'machineAddress', authValue: '10.0.0.25' },
    ])
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields, authentication_methods: methods } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_auth_method')).toBe(true)
  })

  it('rejects duplicate app_ids case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { app_id: 'Billing' } },
        { name: 'b', fields: { app_id: 'billing' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_application')).toBe(true)
  })

  it('extracts specs with defaults + helpers', () => {
    const specs = extractApplicationSpecs(makeCtx([{ name: 'a', fields: { app_id: '  Billing  ', location: '' } }]).canvas)
    expect(specs[0].appId).toBe('Billing')
    expect(specs[0].location).toBe('\\')
    expect(appKey(specs[0])).toBe(appKey({ appId: 'billing' }))
  })

  it('parseAuthMethods returns [] for blank input', () => {
    const result = parseAuthMethods('')
    expect(result.error).toBeNull()
    expect(result.value).toEqual([])
  })

  it('authMethodSignature is stable regardless of array order', () => {
    const a = authMethodSignature({ authType: 'certificateattr', issuer: ['CN=A', 'CN=B'] })
    const b = authMethodSignature({ authType: 'certificateattr', issuer: ['CN=B', 'CN=A'] })
    expect(a).toBe(b)
  })
})
