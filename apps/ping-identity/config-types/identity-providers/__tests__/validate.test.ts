import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'
import validate, { extractIdentityProviderSpecs, splitList } from '../validate'
import { buildIdentityProviderBody, stripToSafePriorBody } from '../deploy'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'ping-identity',
    customerId: 'cust-1',
    configTypeId: 'identity-providers',
    canvas: makeCanvas(sections),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'ping-identity',
    entityType: 'identity-providers',
    items: sections,
    sections,
    snapshot: {},
  }
}

const OIDC_FIELDS = {
  type: 'OPENID_CONNECT',
  name: 'Corp OIDC',
  oidcIssuer: 'https://idp.example.com',
  oidcAuthorizationEndpoint: 'https://idp.example.com/authorize',
  oidcTokenEndpoint: 'https://idp.example.com/token',
  oidcJwksEndpoint: 'https://idp.example.com/jwks',
  oidcClientId: 'client-abc',
  oidcClientSecret: 'fake-secret',
  oidcScopes: ['openid', 'email'],
}

const SAML_FIELDS = {
  type: 'SAML',
  name: 'Corp SAML',
  samlIdpEntityId: 'https://idp.example.com/entity',
  samlSpEntityId: 'https://sp.example.com/entity',
  samlSsoEndpoint: 'https://idp.example.com/sso',
  samlSsoBinding: 'HTTP_POST',
  samlIdpVerificationCertificateIds: ['cert-1'],
}

describe('PingOne Identity Providers Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid OIDC provider', async () => {
    const result = await validate(makeCtx([{ name: 'IdP', fields: OIDC_FIELDS }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid SAML provider', async () => {
    const result = await validate(makeCtx([{ name: 'IdP', fields: SAML_FIELDS }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid social provider (Google)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'IdP', fields: { type: 'GOOGLE', name: 'Google', socialClientId: 'gid', socialClientSecret: 'fake-secret' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid Facebook provider (using the shared social fields)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'IdP', fields: { type: 'FACEBOOK', name: 'FB', socialClientId: 'app-id', socialClientSecret: 'fake-secret' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates a valid Apple provider', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'IdP',
          fields: {
            type: 'APPLE',
            name: 'Apple',
            appleClientId: 'services-id',
            appleTeamId: 'team-1',
            appleKeyId: 'key-1',
            appleClientSecretSigningKey: 'fake-signing-key',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates a valid PayPal provider', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'IdP',
          fields: {
            type: 'PAYPAL',
            name: 'PayPal',
            socialClientId: 'pp-client',
            socialClientSecret: 'fake-secret',
            paypalEnvironment: 'sandbox',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, name: undefined } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 256 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, name: 'x'.repeat(257) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a duplicate provider name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { ...OIDC_FIELDS, name: 'Corp' } },
        { name: 'sec2', fields: { ...SAML_FIELDS, name: 'corp' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a missing type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'No Type' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects an unknown provider type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'MYSPACE', name: 'Bad Type' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects the deprecated LINKEDIN type (only LINKEDIN_OIDC is supported)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'LINKEDIN', name: 'Bad LinkedIn' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects the internal PING_ONE type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'PING_ONE', name: 'Internal' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects a social provider missing client id and secret', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'GITHUB', name: 'GH' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('socialClientId') && e.code === 'required')).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('socialClientSecret') && e.code === 'required')).toBe(true)
  })

  it('rejects a PayPal provider with an invalid environment', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { type: 'PAYPAL', name: 'PP', socialClientId: 'a', socialClientSecret: 'fake-secret', paypalEnvironment: 'staging' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_paypal_environment')).toBe(true)
  })

  it('rejects an Apple provider missing required fields', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'APPLE', name: 'Apple' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'required')).toHaveLength(4)
  })

  it('rejects an OIDC provider with a non-https issuer', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, oidcIssuer: 'http://idp.example.com' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('oidcIssuer') && e.code === 'invalid_url')).toBe(true)
  })

  it('rejects an OIDC provider with no scopes', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, oidcScopes: [] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('oidcScopes') && e.code === 'required')).toBe(true)
  })

  it('rejects an invalid OIDC pkce method', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, oidcPkceMethod: 'MAYBE' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_pkce_method')).toBe(true)
  })

  it('rejects a SAML provider missing entity ids, sso endpoint and certificate ids', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'SAML', name: 'SAML' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('samlIdpEntityId'))).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('samlSpEntityId'))).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('samlSsoEndpoint'))).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('samlIdpVerificationCertificateIds'))).toBe(true)
  })

  it('rejects an invalid SAML SSO binding', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...SAML_FIELDS, samlSsoBinding: 'HTTP_ARTIFACT' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_binding')).toBe(true)
  })

  it('rejects an invalid SAML SP signing algorithm', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...SAML_FIELDS, samlSpSigningAlgorithm: 'MD5' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_signing_algorithm')).toBe(true)
  })
})

describe('extractIdentityProviderSpecs', () => {
  it('trims fields, upper-cases the type, defaults enabled true and parses tag lists', () => {
    const specs = extractIdentityProviderSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: { type: '  openid_connect  ', name: '  Corp OIDC  ', oidcScopes: ['openid', ' email '] },
        },
      ]),
    )
    expect(specs[0].type).toBe('OPENID_CONNECT')
    expect(specs[0].name).toBe('Corp OIDC')
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].oidcScopes).toEqual(['openid', 'email'])
    expect(specs[0].samlAuthenticationRequestSigned).toBe(false)
  })

  it('respects an explicit enabled: false', () => {
    const specs = extractIdentityProviderSpecs(makeCanvas([{ name: 'sec1', fields: { type: 'GOOGLE', name: 'G', enabled: false } }]))
    expect(specs[0].enabled).toBe(false)
  })
})

describe('splitList', () => {
  it('parses an array and a comma/newline string', () => {
    expect(splitList(['a', ' b '])).toEqual(['a', 'b'])
    expect(splitList('a, b\nc')).toEqual(['a', 'b', 'c'])
    expect(splitList(undefined)).toEqual([])
  })
})

describe('buildIdentityProviderBody', () => {
  it('assembles a Facebook body using appId/appSecret, not clientId/clientSecret', () => {
    const body = buildIdentityProviderBody({
      sectionName: 's',
      name: 'FB',
      description: undefined,
      enabled: true,
      type: 'FACEBOOK',
      socialClientId: 'app-id',
      socialClientSecret: 'fake-secret',
      oidcScopes: [],
      samlIdpVerificationCertificateIds: [],
      samlAuthenticationRequestSigned: false,
    })
    expect(body).toEqual({ name: 'FB', enabled: true, type: 'FACEBOOK', appId: 'app-id', appSecret: 'fake-secret' })
  })

  it('assembles a PayPal body with clientEnvironment', () => {
    const body = buildIdentityProviderBody({
      sectionName: 's',
      name: 'PP',
      enabled: true,
      type: 'PAYPAL',
      socialClientId: 'pp-id',
      socialClientSecret: 'fake-secret',
      paypalEnvironment: 'sandbox',
      oidcScopes: [],
      samlIdpVerificationCertificateIds: [],
      samlAuthenticationRequestSigned: false,
    })
    expect(body).toEqual({
      name: 'PP',
      enabled: true,
      type: 'PAYPAL',
      clientId: 'pp-id',
      clientSecret: 'fake-secret',
      clientEnvironment: 'sandbox',
    })
  })

  it('assembles a Microsoft body and omits tenantId when blank', () => {
    const body = buildIdentityProviderBody({
      sectionName: 's',
      name: 'MS',
      enabled: true,
      type: 'MICROSOFT',
      socialClientId: 'ms-id',
      socialClientSecret: 'fake-secret',
      oidcScopes: [],
      samlIdpVerificationCertificateIds: [],
      samlAuthenticationRequestSigned: false,
    })
    expect(body).toEqual({ name: 'MS', enabled: true, type: 'MICROSOFT', clientId: 'ms-id', clientSecret: 'fake-secret' })
    expect(body.tenantId).toBeUndefined()
  })

  it('assembles an Apple body with clientSecretSigningKey (never clientSecret)', () => {
    const body = buildIdentityProviderBody({
      sectionName: 's',
      name: 'Apple',
      enabled: true,
      type: 'APPLE',
      appleClientId: 'services-id',
      appleTeamId: 'team-1',
      appleKeyId: 'key-1',
      appleClientSecretSigningKey: 'fake-signing-key',
      oidcScopes: [],
      samlIdpVerificationCertificateIds: [],
      samlAuthenticationRequestSigned: false,
    })
    expect(body).toEqual({
      name: 'Apple',
      enabled: true,
      type: 'APPLE',
      clientId: 'services-id',
      teamId: 'team-1',
      keyId: 'key-1',
      clientSecretSigningKey: 'fake-signing-key',
    })
    expect(body.clientSecret).toBeUndefined()
  })

  it('assembles an OIDC body with registration and default pkce/auth method', () => {
    const body = buildIdentityProviderBody({
      sectionName: 's',
      name: 'OIDC',
      enabled: true,
      type: 'OPENID_CONNECT',
      registrationPopulationId: 'pop-1',
      oidcIssuer: 'https://idp/issuer',
      oidcAuthorizationEndpoint: 'https://idp/authorize',
      oidcTokenEndpoint: 'https://idp/token',
      oidcJwksEndpoint: 'https://idp/jwks',
      oidcClientId: 'client-1',
      oidcClientSecret: 'fake-secret',
      oidcScopes: ['openid'],
      samlIdpVerificationCertificateIds: [],
      samlAuthenticationRequestSigned: false,
    })
    expect(body).toEqual({
      name: 'OIDC',
      enabled: true,
      type: 'OPENID_CONNECT',
      registration: { population: { id: 'pop-1' } },
      authorizationEndpoint: 'https://idp/authorize',
      clientId: 'client-1',
      clientSecret: 'fake-secret',
      issuer: 'https://idp/issuer',
      jwksEndpoint: 'https://idp/jwks',
      scopes: ['openid'],
      tokenEndpoint: 'https://idp/token',
      pkceMethod: 'NONE',
      tokenEndpointAuthMethod: 'CLIENT_SECRET_BASIC',
    })
  })

  it('assembles a SAML body with nested idpVerification and spSigning', () => {
    const body = buildIdentityProviderBody({
      sectionName: 's',
      name: 'SAML',
      enabled: true,
      type: 'SAML',
      samlIdpEntityId: 'idp-entity',
      samlSpEntityId: 'sp-entity',
      samlSsoEndpoint: 'https://idp/sso',
      samlSsoBinding: 'HTTP_POST',
      samlIdpVerificationCertificateIds: ['cert-1', 'cert-2'],
      samlAuthenticationRequestSigned: true,
      samlSpSigningKeyId: 'signing-cert-1',
      samlSpSigningAlgorithm: 'SHA256withRSA',
      oidcScopes: [],
    })
    expect(body).toEqual({
      name: 'SAML',
      enabled: true,
      type: 'SAML',
      idpEntityId: 'idp-entity',
      idpVerification: { certificates: [{ id: 'cert-1' }, { id: 'cert-2' }] },
      spEntityId: 'sp-entity',
      ssoBinding: 'HTTP_POST',
      ssoEndpoint: 'https://idp/sso',
      authenticationRequestSigned: true,
      sloBinding: 'HTTP_POST',
      spSigning: { key: { id: 'signing-cert-1' }, algorithm: 'SHA256withRSA' },
    })
  })

  it('throws for an unsupported type', () => {
    let threw = false
    try {
      buildIdentityProviderBody({
        sectionName: 's',
        name: 'X',
        enabled: true,
        type: 'BOGUS',
        oidcScopes: [],
        samlIdpVerificationCertificateIds: [],
        samlAuthenticationRequestSigned: false,
      })
    } catch (error) {
      threw = true
      expect(error instanceof Error ? error.message : '').toContain('Unsupported identity provider type')
    }
    expect(threw).toBe(true)
  })
})

describe('stripToSafePriorBody', () => {
  it('removes readonly and secret fields but keeps everything else', () => {
    const stripped = stripToSafePriorBody({
      id: 'idp-1',
      name: 'Corp OIDC',
      type: 'OPENID_CONNECT',
      enabled: true,
      clientId: 'client-1',
      clientSecret: 'fake-secret',
      environment: { id: 'env-1' },
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-02T00:00:00Z',
      _links: { self: {} },
    })
    expect(stripped).toEqual({ name: 'Corp OIDC', type: 'OPENID_CONNECT', enabled: true, clientId: 'client-1' })
    expect(stripped.clientSecret).toBeUndefined()
    expect(stripped.id).toBeUndefined()
  })
})
