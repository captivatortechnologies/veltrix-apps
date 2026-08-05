import validate, { extractIdentityProviderSpecs, idpKey, parseJsonObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-access-identity-providers',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-access-identity-providers',
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

const OIDC_CONFIG = '{"client_id":"abc","client_secret":"shh","auth_url":"https://idp.example.com/authorize"}'

describe('Cloudflare Access Identity Providers Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a one-time-pin provider with no config', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { name: 'Email OTP', type: 'onetimepin' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates an OIDC provider with config_json', async () => {
    const result = await validate(
      makeCtx([{ name: 'p1', fields: { name: 'Okta', type: 'oidc', config_json: OIDC_CONFIG } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { type: 'onetimepin' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an unsupported type', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { name: 'Weird', type: 'not-a-provider' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('requires config_json for a non-onetimepin/cloudflare type', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { name: 'Okta', type: 'okta' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('config_json'))).toBe(true)
  })

  it('rejects config_json that is not valid JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'p1', fields: { name: 'Okta', type: 'okta', config_json: 'nope' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json' && e.field.includes('config_json'))).toBe(true)
  })

  it('rejects advanced_json that is not a JSON object', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p1',
          fields: { name: 'Okta', type: 'okta', config_json: OIDC_CONFIG, advanced_json: '[1,2]' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json' && e.field.includes('advanced_json'))).toBe(true)
  })

  it('rejects duplicate provider names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Okta', type: 'onetimepin' } },
        { name: 'b', fields: { name: 'okta', type: 'onetimepin' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_idp')).toBe(true)
  })

  it('extractIdentityProviderSpecs defaults type to onetimepin and trims name', () => {
    const specs = extractIdentityProviderSpecs(makeCtx([{ name: 'r', fields: { name: '  Okta  ' } }]).canvas)
    expect(specs[0].name).toBe('Okta')
    expect(specs[0].type).toBe('onetimepin')
  })

  it('idpKey folds case and parseJsonObject treats blank as an empty object', () => {
    expect(idpKey('Okta')).toBe(idpKey('  okta  '))
    expect(parseJsonObject('').error).toBeNull()
    expect(parseJsonObject('').value).toEqual({})
    expect(parseJsonObject(OIDC_CONFIG).value?.client_id).toBe('abc')
    expect(parseJsonObject('nope').value).toBeNull()
  })
})
