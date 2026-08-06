import validate, { extractAuthMethodSpecs, detectLiveAuthMethodType } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'akeyless',
    customerId: 'cust-1',
    configTypeId: 'auth-methods',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'akeyless',
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

describe('Akeyless Auth Methods Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal api-key auth method', async () => {
    const result = await validate(makeCtx([{ name: 'am1', fields: { name: '/ci/runner', type: 'api-key' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'am1', fields: { type: 'api-key' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('rejects a missing/invalid type', async () => {
    const result = await validate(makeCtx([{ name: 'am1', fields: { name: '/x' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.type'))).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'am1', fields: { name: '/x', type: 'api-key' } },
        { name: 'am2', fields: { name: '/x', type: 'api-key' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('requires boundAwsAccountId for aws-iam', async () => {
    const result = await validate(makeCtx([{ name: 'am1', fields: { name: '/aws', type: 'aws-iam' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.boundAwsAccountId'))).toBe(true)
  })

  it('accepts aws-iam with boundAwsAccountId set', async () => {
    const result = await validate(
      makeCtx([{ name: 'am1', fields: { name: '/aws', type: 'aws-iam', boundAwsAccountId: ['123456789012'] } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('requires boundTenantId for azure-ad', async () => {
    const result = await validate(makeCtx([{ name: 'am1', fields: { name: '/az', type: 'azure-ad' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.boundTenantId'))).toBe(true)
  })

  it('requires issuerOidc for oidc', async () => {
    const result = await validate(makeCtx([{ name: 'am1', fields: { name: '/oidc', type: 'oidc' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.issuerOidc'))).toBe(true)
  })

  it('rejects a negative accessExpires', async () => {
    const result = await validate(makeCtx([{ name: 'am1', fields: { name: '/x', type: 'api-key', accessExpires: -1 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.accessExpires'))).toBe(true)
  })

  it('rejects a non-numeric expirationEventIn entry', async () => {
    const result = await validate(
      makeCtx([{ name: 'am1', fields: { name: '/x', type: 'api-key', expirationEventIn: ['soon'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.expirationEventIn'))).toBe(true)
  })
})

describe('extractAuthMethodSpecs', () => {
  it('parses tag-list fields and trims name', () => {
    const specs = extractAuthMethodSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'akeyless',
      entityType: 'auth-methods',
      items: [],
      sections: [
        { name: 'sec1', fields: { name: '  /aws  ', type: 'aws-iam', boundAwsAccountId: ['111', '222'] } },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('/aws')
    expect(specs[0].type).toBe('aws-iam')
    expect(specs[0].boundAwsAccountId).toEqual(['111', '222'])
  })

  it('falls back to empty type for an unrecognized value', () => {
    const specs = extractAuthMethodSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'akeyless',
      entityType: 'auth-methods',
      items: [],
      sections: [{ name: 'sec1', fields: { name: '/x', type: 'not-a-type' } }],
      snapshot: {},
    })
    expect(specs[0].type).toBe('')
  })
})

describe('detectLiveAuthMethodType', () => {
  it('detects each type from its access_rules sub-object', () => {
    expect(detectLiveAuthMethodType({ api_key_access_rules: {} })).toBe('api-key')
    expect(detectLiveAuthMethodType({ aws_iam_access_rules: {} })).toBe('aws-iam')
    expect(detectLiveAuthMethodType({ azure_ad_access_rules: {} })).toBe('azure-ad')
    expect(detectLiveAuthMethodType({ k8s_access_rules: {} })).toBe('k8s')
    expect(detectLiveAuthMethodType({ oidc_access_rules: {} })).toBe('oidc')
  })

  it('returns unknown for an empty/undefined access_info', () => {
    expect(detectLiveAuthMethodType(undefined)).toBe('unknown')
    expect(detectLiveAuthMethodType({})).toBe('unknown')
  })
})
