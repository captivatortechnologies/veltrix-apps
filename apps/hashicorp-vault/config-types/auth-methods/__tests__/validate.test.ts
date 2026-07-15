import validate, { extractAuthMethodSpecs, normalizeAuthPath } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'hashicorp-vault',
    customerId: 'cust-1',
    configTypeId: 'auth-methods',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
      entityType: 'auth-methods',
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

describe('Vault Auth Methods Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid auth method (path + type)', async () => {
    const result = await validate(makeCtx([{ name: 'Method', fields: { path: 'userpass', type: 'userpass' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid auth method with tuning', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Method',
          fields: {
            path: 'kubernetes/prod',
            type: 'kubernetes',
            description: 'Prod k8s',
            defaultLeaseTtl: '768h',
            maxLeaseTtl: '2764800',
            listingVisibility: 'unauth',
            tokenType: 'service',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing path', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'userpass' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('path'))).toBe(true)
  })

  it('rejects a missing type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'userpass' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects an invalid path charset', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'bad path!', type: 'userpass' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_path')).toBe(true)
  })

  it('rejects an invalid (non-lowercase-slug) type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'up', type: 'UserPass' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects the protected built-in token/ path', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'token', type: 'token' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'protected_path')).toBe(true)
  })

  it('rejects the protected token/ path even with a trailing slash', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { path: 'token/', type: 'token' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'protected_path')).toBe(true)
  })

  it('rejects an invalid listing visibility', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { path: 'up', type: 'userpass', listingVisibility: 'public' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_listing_visibility')).toBe(true)
  })

  it('rejects an invalid token type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { path: 'up', type: 'userpass', tokenType: 'ephemeral' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_token_type')).toBe(true)
  })

  it('rejects a duplicate path', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { path: 'userpass', type: 'userpass' } },
        { name: 'sec2', fields: { path: 'userpass/', type: 'userpass' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_path')).toBe(true)
  })

  it('allows two distinct paths', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { path: 'userpass', type: 'userpass' } },
        { name: 'sec2', fields: { path: 'approle', type: 'approle' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractAuthMethodSpecs', () => {
  it('normalizes the path, trims fields, and drops empty optional values', () => {
    const specs = extractAuthMethodSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'hashicorp-vault',
      entityType: 'auth-methods',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            path: '  /userpass/  ',
            type: '  userpass  ',
            description: '  ',
            defaultLeaseTtl: '',
            tokenType: 'service',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].path).toBe('userpass')
    expect(specs[0].type).toBe('userpass')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].defaultLeaseTtl).toBeUndefined()
    expect(specs[0].tokenType).toBe('service')
  })
})

describe('normalizeAuthPath', () => {
  it('strips leading and trailing slashes and trims', () => {
    expect(normalizeAuthPath('  /userpass/  ')).toBe('userpass')
  })
  it('preserves internal slashes for nested paths', () => {
    expect(normalizeAuthPath('kubernetes/prod/')).toBe('kubernetes/prod')
  })
  it('returns empty string for a non-string', () => {
    expect(normalizeAuthPath(undefined)).toBe('')
  })
})
