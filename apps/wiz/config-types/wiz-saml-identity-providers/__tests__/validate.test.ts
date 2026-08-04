import validate, { extractSamlIdpSpecs, idpKey, normalizeGroupMapping, readBool, tryParseJson } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'wiz',
    customerId: 'cust-1',
    configTypeId: 'wiz-saml-identity-providers',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'wiz',
      entityType: 'wiz-saml-identity-providers',
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

const validFields = {
  name: 'Okta SSO',
  login_url: 'https://acme.okta.com/app/abc/sso/saml',
  certificate: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
}

describe('Wiz SAML Identity Providers Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid provider', async () => {
    const result = await validate(makeCtx([{ name: 'P1', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires name, login_url and certificate', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('login_url'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('certificate'))).toBe(true)
  })

  it('requires allow_manual_role_override when use_provider_managed_roles is disabled', async () => {
    const result = await validate(
      makeCtx([{ name: 'p1', fields: { ...validFields, use_provider_managed_roles: false, allow_manual_role_override: false } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_role_config')).toBe(true)
  })

  it('rejects malformed group mapping JSON', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { ...validFields, group_mapping: '[not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('requires providerGroupId and role on each mapping entry', async () => {
    const result = await validate(
      makeCtx([{ name: 'p1', fields: { ...validFields, group_mapping: JSON.stringify([{ projects: ['x'] }]) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('providerGroupId'))).toBe(true)
    expect(result.errors.some((e) => e.field.includes('.role'))).toBe(true)
  })

  it('rejects duplicate provider names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Dup IdP' } },
        { name: 'b', fields: { ...validFields, name: 'dup idp' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_provider')).toBe(true)
  })

  it('extractSamlIdpSpecs trims and defaults roles config', () => {
    const specs = extractSamlIdpSpecs(makeCtx([{ name: 'e', fields: { ...validFields, name: '  IdP X  ' } }]).canvas)
    expect(specs[0].name).toBe('IdP X')
    expect(specs[0].useProviderManagedRoles).toBe(false)
    expect(specs[0].allowManualRoleOverride).toBe(true)
    expect(idpKey('  IdP X ')).toBe('idp x')
  })

  it('helpers behave as documented', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(tryParseJson('').ok).toBe(true)
    expect(tryParseJson('[bad').ok).toBe(false)
    expect(normalizeGroupMapping(undefined)).toEqual([])
    expect(normalizeGroupMapping([{ providerGroupId: 'g1', role: 'GLOBAL_ADMIN' }])).toEqual([
      { providerGroupId: 'g1', role: 'GLOBAL_ADMIN', projects: [] },
    ])
    expect(normalizeGroupMapping('not-an-array')).toBeUndefined()
  })
})
