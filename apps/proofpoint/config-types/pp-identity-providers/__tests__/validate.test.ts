import validate, { extractIdpSpecs, idpKey, buildIdpBody } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'proofpoint',
    customerId: 'cust-1',
    configTypeId: 'pp-identity-providers',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'proofpoint',
      entityType: 'pp-identity-providers',
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

const OKTA_FIELDS = {
  name: 'Okta',
  is_active: true,
  idp_entity_id: 'https://saml.okta.com/id',
  idp_login_url: 'https://saml.okta.com/login',
  idp_logout_url: 'https://saml.okta.com/logout',
  idp_public_cert: '-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----',
}

describe('Proofpoint Identity Providers Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete IDP', async () => {
    const result = await validate(makeCtx([{ name: 'IDP', fields: OKTA_FIELDS }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { idp_entity_id: 'x' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects the same name declared twice (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Okta' } },
        { name: 'b', fields: { name: 'OKTA' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('warns when the login/logout URL does not look like a URL', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'Okta', idp_login_url: 'not-a-url' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'url_format' && w.field.includes('idp_login_url'))).toBe(true)
  })

  it('does not warn on idp_entity_id URL format (URIs need not be http(s))', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'Okta', idp_entity_id: 'urn:okta:saml:12345' } }]))
    expect(result.warnings.some((w) => w.field.includes('idp_entity_id'))).toBe(false)
  })

  it('warns when an active IDP has no public certificate', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'Okta', is_active: true } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'missing_cert')).toBe(true)
  })

  it('does not warn about a missing certificate on an inactive IDP', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'Okta', is_active: false } }]))
    expect(result.warnings.some((w) => w.code === 'missing_cert')).toBe(false)
  })

  it('extractIdpSpecs trims fields and defaults is_active to true', () => {
    const specs = extractIdpSpecs(makeCtx([{ name: 's', fields: { name: '  Okta  ' } }]).canvas)
    expect(specs[0].name).toBe('Okta')
    expect(specs[0].isActive).toBe(true)
    expect(idpKey('  OKTA ')).toBe('okta')
  })

  it('buildIdpBody maps the spec onto the IdpTransformer wire shape', () => {
    const specs = extractIdpSpecs(makeCtx([{ name: 's', fields: OKTA_FIELDS }]).canvas)
    expect(buildIdpBody(specs[0])).toEqual({
      name: 'Okta',
      is_active: true,
      description: '',
      icon_ref: '',
      idp_entity_id: 'https://saml.okta.com/id',
      idp_login_url: 'https://saml.okta.com/login',
      idp_logout_url: 'https://saml.okta.com/logout',
      idp_public_cert: OKTA_FIELDS.idp_public_cert,
    })
  })
})
