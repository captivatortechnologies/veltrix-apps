import validate, { extractAuthSettingsSpec, buildMfaBody, buildLoginBody } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'proofpoint',
    customerId: 'cust-1',
    configTypeId: 'pp-authentication-settings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'proofpoint',
      entityType: 'pp-authentication-settings',
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

describe('Proofpoint Authentication Settings Validate Handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a default (all logins allowed) configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Authentication Settings', fields: {} }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects more than one declared item (singleton)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: {} },
        { name: 'b', fields: {} },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'singleton')).toBe(true)
  })

  it('rejects disabling every login method with no forced SSO IDP (lockout)', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: { allow_local_login: false, allow_azure_login: false } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'no_login_method')).toBe(true)
  })

  it('allows disabling local + Azure login when a forced SSO IDP is set', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'a',
          fields: { allow_local_login: false, allow_azure_login: false, idp_for_forced_login: '0059fcbb-a3bd-4770-8797-e9bb6bb417b2' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('warns when the forced-login IDP does not look like a UUID', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { idp_for_forced_login: 'okta-idp-1' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'idp_format')).toBe(true)
  })

  it('warns on a contradictory force_azure_login without allow_azure_login', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { allow_azure_login: false, force_azure_login: true } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'force_azure_conflict')).toBe(true)
  })

  it('extractAuthSettingsSpec applies documented Essentials defaults', () => {
    const spec = extractAuthSettingsSpec(makeCtx([{ name: 'a', fields: {} }]).canvas)
    expect(spec).toEqual({
      isMfaEnabled: false,
      mfaAdminsOnly: false,
      allowLocalLogin: true,
      allowAzureLogin: true,
      forceAzureLogin: false,
      idpForForcedLogin: '',
    })
  })

  it('buildMfaBody / buildLoginBody map the spec onto the API wire shape', () => {
    const spec = extractAuthSettingsSpec(
      makeCtx([{ name: 'a', fields: { is_mfa_enabled: true, mfa_admins_only: true, idp_for_forced_login: ' abc-123 ' } }]).canvas,
    )
    expect(buildMfaBody(spec)).toEqual({ is_mfa_enabled: true, mfa_admins_only: true })
    expect(buildLoginBody(spec)).toEqual({
      allow_local_login: true,
      idp_for_forced_login: 'abc-123',
      allow_azure_login: true,
      force_azure_login: false,
    })
  })
})
