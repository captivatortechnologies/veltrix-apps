import validate, { extractServiceAccountSpecs, parsePositiveInt, saKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'snyk',
    customerId: 'cust-1',
    configTypeId: 'snyk-service-accounts',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'snyk',
      entityType: 'snyk-service-accounts',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { org_id: 'org-123' },
    platform: stubPlatform,
  }
}

const valid = { name: 'ci-bot', role_id: 'role-uuid-1', auth_type: 'api_key' }

describe('Snyk Service Accounts Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid service account', async () => {
    const result = await validate(makeCtx([{ name: 'SA', fields: { ...valid } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a name', async () => {
    const result = await validate(makeCtx([{ name: 'SA', fields: { role_id: 'r', auth_type: 'api_key' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('requires an org role id', async () => {
    const result = await validate(makeCtx([{ name: 'SA', fields: { name: 'ci-bot', auth_type: 'api_key' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('role_id'))).toBe(true)
  })

  it('rejects an unsupported auth type', async () => {
    const result = await validate(makeCtx([{ name: 'SA', fields: { ...valid, auth_type: 'magic' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_auth_type')).toBe(true)
  })

  it('rejects a non-positive-integer access token ttl', async () => {
    const result = await validate(makeCtx([{ name: 'SA', fields: { ...valid, access_token_ttl_seconds: 'soon' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_ttl')).toBe(true)
  })

  it('accepts a valid access token ttl', async () => {
    const result = await validate(makeCtx([{ name: 'SA', fields: { ...valid, access_token_ttl_seconds: 3600 } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects duplicate names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'ci-bot', role_id: 'r', auth_type: 'api_key' } },
        { name: 'b', fields: { name: 'CI-Bot', role_id: 'r', auth_type: 'api_key' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_account')).toBe(true)
  })

  it('helpers behave', () => {
    expect(saKey('  CI-Bot ')).toBe('ci-bot')
    expect(parsePositiveInt('3600').value).toBe(3600)
    expect(parsePositiveInt('').value).toBeNull()
    expect(parsePositiveInt('').error).toBeNull()
    expect(parsePositiveInt(undefined).error).toBeNull()
    expect(parsePositiveInt('-5').error).toContain('positive')
    expect(parsePositiveInt('1.5').error).toContain('positive')

    const spec = extractServiceAccountSpecs(
      makeCtx([
        {
          name: 's',
          fields: { name: '  ci-bot  ', role_id: '  r  ', auth_type: 'oauth_client_secret', access_token_ttl_seconds: 60 },
        },
      ]).canvas,
    )[0]
    expect(spec.name).toBe('ci-bot')
    expect(spec.roleId).toBe('r')
    expect(spec.authType).toBe('oauth_client_secret')
    expect(spec.accessTokenTtlSeconds).toBe(60)
  })
})
