import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

const SAMPLE_CERT =
  '-----BEGIN CERTIFICATE-----\n' +
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAn0k1Zx3vQ2sample\n' +
  'base64certificatecontentthatislongenoughtolookrealMIIBIjANBg\n' +
  '-----END CERTIFICATE-----'

/** A valid SAML config; overrides let each test perturb one field. */
function samlFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerName: 'okta_saml',
    entityId: 'https://idp.example.com/saml/metadata',
    ssoUrl: 'https://idp.example.com/sso',
    roleAttribute: 'role',
    enabled: false,
    ...overrides,
  }
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-cloud',
    customerId: 'cust-1',
    configTypeId: 'sso',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-cloud',
      entityType: 'sso',
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

describe('Splunk Cloud SAML SSO Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid SAML SSO configuration', async () => {
    const result = await validate(makeCtx([{ name: 'sso', fields: samlFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('rejects more than one SSO configuration (single-object)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: samlFields() },
        { name: 'b', fields: samlFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'multiple_configs')).toBe(true)
  })

  it('rejects a missing provider name', async () => {
    const result = await validate(makeCtx([{ name: 'sso', fields: samlFields({ providerName: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('.providerName'))).toBe(true)
  })

  it('rejects a malformed provider name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sso', fields: samlFields({ providerName: 'bad name/with slash' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_provider_name')).toBe(true)
  })

  it('rejects a provider name that is too long', async () => {
    const result = await validate(
      makeCtx([{ name: 'sso', fields: samlFields({ providerName: 'a'.repeat(101) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a missing IdP entity ID', async () => {
    const result = await validate(makeCtx([{ name: 'sso', fields: samlFields({ entityId: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('.entityId'))).toBe(true)
  })

  it('rejects a missing SSO URL', async () => {
    const result = await validate(makeCtx([{ name: 'sso', fields: samlFields({ ssoUrl: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('.ssoUrl'))).toBe(true)
  })

  it('rejects a malformed SSO URL', async () => {
    const result = await validate(makeCtx([{ name: 'sso', fields: samlFields({ ssoUrl: 'not a url' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_url')).toBe(true)
  })

  it('rejects an insecure (http) SSO URL', async () => {
    const result = await validate(
      makeCtx([{ name: 'sso', fields: samlFields({ ssoUrl: 'http://idp.example.com/sso' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'insecure_url')).toBe(true)
  })

  it('rejects an insecure (http) SLO URL', async () => {
    const result = await validate(
      makeCtx([{ name: 'sso', fields: samlFields({ sloUrl: 'http://idp.example.com/slo' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'insecure_url')).toBe(true)
  })

  it('rejects a certificate that does not look like a certificate', async () => {
    const result = await validate(
      makeCtx([{ name: 'sso', fields: samlFields({ idpCertificate: 'not-a-cert' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_certificate')).toBe(true)
  })

  it('accepts an optional certificate but warns it needs a manual Splunk Web upload', async () => {
    const result = await validate(
      makeCtx([{ name: 'sso', fields: samlFields({ idpCertificate: SAMPLE_CERT }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'cert_manual_upload')).toBe(true)
  })

  it('warns when no role attribute mapping is declared', async () => {
    const result = await validate(makeCtx([{ name: 'sso', fields: samlFields({ roleAttribute: '' }) }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'role_mapping_missing')).toBe(true)
  })

  it('warns about lockout risk when SSO is marked active', async () => {
    const result = await validate(makeCtx([{ name: 'sso', fields: samlFields({ enabled: true }) }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'sso_lockout_risk')).toBe(true)
  })
})
