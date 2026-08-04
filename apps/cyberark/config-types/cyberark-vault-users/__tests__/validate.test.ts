import validate, { extractVaultUserSpecs, usernameKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cyberark',
    customerId: 'cust-1',
    configTypeId: 'cyberark-vault-users',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cyberark',
      entityType: 'cyberark-vault-users',
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

const validFields = { username: 'svc-onboarding' }

describe('CyberArk Vault Users Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal user', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a username', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('username'))).toBe(true)
  })

  it('rejects malformed contact_details JSON', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields, contact_details: '{bad' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects duplicate usernames case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { username: 'Alice' } },
        { name: 'b', fields: { username: 'alice' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_user')).toBe(true)
  })

  it('extracts specs with defaults + helpers', () => {
    const specs = extractVaultUserSpecs(makeCtx([{ name: 'a', fields: { username: '  Alice  ' } }]).canvas)
    expect(specs[0].username).toBe('Alice')
    expect(specs[0].userType).toBe('EPVUser')
    expect(specs[0].location).toBe('\\')
    expect(specs[0].enableUser).toBe(true)
    expect(usernameKey(specs[0])).toBe(usernameKey({ username: 'alice' }))
  })

  it('never surfaces the initial password outside the write-only field', () => {
    const specs = extractVaultUserSpecs(makeCtx([{ name: 'a', fields: { ...validFields, initial_password: 'S3cret!23' } }]).canvas)
    expect(specs[0].initialPassword).toBe('S3cret!23')
    // Nothing else on the spec should ever carry it.
    expect(JSON.stringify(specs[0]).match(/S3cret!23/g)).toHaveLength(1)
  })
})
