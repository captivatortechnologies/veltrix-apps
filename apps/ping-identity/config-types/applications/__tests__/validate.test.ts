import validate, { extractApplicationSpecs, resolveApplicationType, splitList, type ApplicationSpec } from '../validate'
import { buildApplicationBody, stripReadOnlyApplicationFields } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

/** Minimal well-formed spec, overridden per test - keeps resolveApplicationType tests free of `any`/casts. */
function baseSpec(overrides: Partial<ApplicationSpec>): ApplicationSpec {
  return {
    sectionName: 's',
    name: 'App',
    enabled: true,
    protocol: 'OPENID_CONNECT',
    hiddenFromAppPortal: false,
    redirectUris: [],
    postLogoutRedirectUris: [],
    grantTypes: [],
    responseTypes: [],
    acsUrls: [],
    assertionSignedEnabled: true,
    responseIsSigned: false,
    ...overrides,
  }
}

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'ping-identity',
    customerId: 'cust-1',
    configTypeId: 'applications',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'ping-identity',
      entityType: 'applications',
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

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'ping-identity',
    entityType: 'applications',
    items: sections,
    sections,
    snapshot: {},
  }
}

const OIDC_FIELDS = {
  name: 'Corp Web App',
  protocol: 'OPENID_CONNECT',
  oidcType: 'WEB_APP',
  grantTypes: ['AUTHORIZATION_CODE'],
  tokenEndpointAuthMethod: 'CLIENT_SECRET_BASIC',
}

const SAML_FIELDS = {
  name: 'Corp SAML App',
  protocol: 'SAML',
  samlType: 'WEB_APP',
  acsUrls: ['https://app.example.com/acs'],
  spEntityId: 'https://app.example.com',
  assertionDurationSeconds: 3600,
}

describe('PingOne Applications Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal OIDC application', async () => {
    const result = await validate(makeCtx([{ name: 'App', fields: OIDC_FIELDS }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a minimal SAML application', async () => {
    const result = await validate(makeCtx([{ name: 'App', fields: SAML_FIELDS }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, name: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 256 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, name: 'x'.repeat(257) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a duplicate application name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { ...OIDC_FIELDS, name: 'Corp App' } },
        { name: 'sec2', fields: { ...OIDC_FIELDS, name: 'corp app' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a missing protocol', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'No Protocol' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('protocol'))).toBe(true)
  })

  it('rejects an unsupported protocol', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Bad Protocol', protocol: 'WSFED' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_protocol')).toBe(true)
  })

  describe('OIDC-specific rules', () => {
    it('requires oidcType', async () => {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, oidcType: undefined } }]),
      )
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'required' && e.field.includes('oidcType'))).toBe(true)
    })

    it('rejects an unsupported oidcType (WORKER is never offered, so this covers any bad input)', async () => {
      const result = await validate(makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, oidcType: 'WORKER' } }]))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'invalid_oidc_type')).toBe(true)
    })

    it('requires at least one grant type', async () => {
      const result = await validate(makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, grantTypes: [] } }]))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'required' && e.field.includes('grantTypes'))).toBe(true)
    })

    it('rejects an unsupported grant type (e.g. out-of-scope TOKEN_EXCHANGE)', async () => {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, grantTypes: ['TOKEN_EXCHANGE'] } }]),
      )
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'invalid_grant_type')).toBe(true)
    })

    it('requires tokenEndpointAuthMethod', async () => {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, tokenEndpointAuthMethod: undefined } }]),
      )
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'required' && e.field.includes('tokenEndpointAuthMethod'))).toBe(true)
    })

    it('rejects an unsupported tokenEndpointAuthMethod', async () => {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, tokenEndpointAuthMethod: 'CLIENT_SECRET_JWT' } }]),
      )
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'invalid_auth_method')).toBe(true)
    })

    it('warns (but stays valid) when PRIVATE_KEY_JWT is selected', async () => {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, tokenEndpointAuthMethod: 'PRIVATE_KEY_JWT' } }]),
      )
      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.code === 'jwks_unsupported')).toBe(true)
    })

    it('rejects an unsupported response type', async () => {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, responseTypes: ['GARBAGE'] } }]),
      )
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'invalid_response_type')).toBe(true)
    })

    it('rejects CODE combined with TOKEN (no hybrid flow)', async () => {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, responseTypes: ['CODE', 'TOKEN'] } }]),
      )
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'no_hybrid_flow')).toBe(true)
    })

    it('rejects CODE combined with ID_TOKEN (no hybrid flow)', async () => {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, responseTypes: ['CODE', 'ID_TOKEN'] } }]),
      )
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'no_hybrid_flow')).toBe(true)
    })

    it('allows TOKEN and ID_TOKEN together without CODE', async () => {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, responseTypes: ['TOKEN', 'ID_TOKEN'] } }]),
      )
      expect(result.valid).toBe(true)
    })

    it('rejects an unsupported pkceEnforcement', async () => {
      const result = await validate(makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, pkceEnforcement: 'MAYBE' } }]))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'invalid_pkce_enforcement')).toBe(true)
    })

    it('rejects a refreshTokenDurationSeconds below the 60-second minimum', async () => {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { ...OIDC_FIELDS, refreshTokenDurationSeconds: 10 } }]),
      )
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'invalid_range')).toBe(true)
    })
  })

  describe('SAML-specific rules', () => {
    it('requires samlType', async () => {
      const result = await validate(makeCtx([{ name: 'sec1', fields: { ...SAML_FIELDS, samlType: undefined } }]))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'required' && e.field.includes('samlType'))).toBe(true)
    })

    it('rejects an unsupported samlType', async () => {
      const result = await validate(makeCtx([{ name: 'sec1', fields: { ...SAML_FIELDS, samlType: 'WORKER' } }]))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'invalid_saml_type')).toBe(true)
    })

    it('requires at least one ACS URL', async () => {
      const result = await validate(makeCtx([{ name: 'sec1', fields: { ...SAML_FIELDS, acsUrls: [] } }]))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'required' && e.field.includes('acsUrls'))).toBe(true)
    })

    it('requires spEntityId', async () => {
      const result = await validate(makeCtx([{ name: 'sec1', fields: { ...SAML_FIELDS, spEntityId: undefined } }]))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'required' && e.field.includes('spEntityId'))).toBe(true)
    })

    it('requires assertionDurationSeconds', async () => {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { ...SAML_FIELDS, assertionDurationSeconds: undefined } }]),
      )
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'required' && e.field.includes('assertionDurationSeconds'))).toBe(true)
    })

    it('rejects a zero or negative assertionDurationSeconds', async () => {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { ...SAML_FIELDS, assertionDurationSeconds: 0 } }]),
      )
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'invalid_range')).toBe(true)
    })

    it('rejects an unsupported sloBinding', async () => {
      const result = await validate(makeCtx([{ name: 'sec1', fields: { ...SAML_FIELDS, sloBinding: 'CARRIER_PIGEON' } }]))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'invalid_slo_binding')).toBe(true)
    })

    it('rejects an unsupported idpSigningKeyAlgorithm', async () => {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { ...SAML_FIELDS, idpSigningKeyId: 'key-1', idpSigningKeyAlgorithm: 'MD5' } }]),
      )
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'invalid_signing_algorithm')).toBe(true)
    })

    it('requires idpSigningKeyAlgorithm when idpSigningKeyId is set', async () => {
      const result = await validate(makeCtx([{ name: 'sec1', fields: { ...SAML_FIELDS, idpSigningKeyId: 'key-1' } }]))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'required' && e.field.includes('idpSigningKeyAlgorithm'))).toBe(true)
    })

    it('warns when idpSigningKeyAlgorithm is set without idpSigningKeyId', async () => {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { ...SAML_FIELDS, idpSigningKeyAlgorithm: 'SHA256withRSA' } }]),
      )
      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.code === 'signing_key_ignored')).toBe(true)
    })

    it('accepts a matched idpSigningKeyId + idpSigningKeyAlgorithm pair', async () => {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { ...SAML_FIELDS, idpSigningKeyId: 'key-1', idpSigningKeyAlgorithm: 'SHA256withRSA' } }]),
      )
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })
  })
})

describe('extractApplicationSpecs', () => {
  it('trims fields, upper-cases enums and defaults booleans', () => {
    const specs = extractApplicationSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            name: '  Corp App  ',
            description: '  A description  ',
            protocol: ' openid_connect ',
            oidcType: ' web_app ',
            grantTypes: [' authorization_code ', 'refresh_token'],
            responseTypes: [' code '],
            tokenEndpointAuthMethod: ' client_secret_basic ',
            pkceEnforcement: ' required ',
          },
        },
      ]),
    )
    expect(specs[0].name).toBe('Corp App')
    expect(specs[0].description).toBe('A description')
    expect(specs[0].protocol).toBe('OPENID_CONNECT')
    expect(specs[0].oidcType).toBe('WEB_APP')
    expect(specs[0].grantTypes).toEqual(['AUTHORIZATION_CODE', 'REFRESH_TOKEN'])
    expect(specs[0].responseTypes).toEqual(['CODE'])
    expect(specs[0].tokenEndpointAuthMethod).toBe('CLIENT_SECRET_BASIC')
    expect(specs[0].pkceEnforcement).toBe('REQUIRED')
  })

  it('defaults enabled and assertionSignedEnabled to true, hiddenFromAppPortal and responseIsSigned to false', () => {
    const specs = extractApplicationSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'App' } }]))
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].assertionSignedEnabled).toBe(true)
    expect(specs[0].hiddenFromAppPortal).toBe(false)
    expect(specs[0].responseIsSigned).toBe(false)
  })

  it('respects an explicit false for enabled/assertionSignedEnabled and true for the hide/sign flags', () => {
    const specs = extractApplicationSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: { name: 'App', enabled: false, assertionSignedEnabled: false, hiddenFromAppPortal: true, responseIsSigned: true },
        },
      ]),
    )
    expect(specs[0].enabled).toBe(false)
    expect(specs[0].assertionSignedEnabled).toBe(false)
    expect(specs[0].hiddenFromAppPortal).toBe(true)
    expect(specs[0].responseIsSigned).toBe(true)
  })

  it('drops blank optional strings and leaves numeric fields undefined when absent', () => {
    const specs = extractApplicationSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'App', loginPageUrl: '   ', homePageUrl: '' } }]),
    )
    expect(specs[0].loginPageUrl).toBeUndefined()
    expect(specs[0].homePageUrl).toBeUndefined()
    expect(specs[0].refreshTokenDurationSeconds).toBeUndefined()
    expect(specs[0].assertionDurationSeconds).toBeUndefined()
  })
})

describe('resolveApplicationType', () => {
  it('resolves oidcType for OPENID_CONNECT', () => {
    expect(resolveApplicationType(baseSpec({ protocol: 'OPENID_CONNECT', oidcType: 'SERVICE' }))).toBe('SERVICE')
  })

  it('resolves samlType for SAML', () => {
    expect(resolveApplicationType(baseSpec({ protocol: 'SAML', samlType: 'CUSTOM_APP' }))).toBe('CUSTOM_APP')
  })

  it('returns undefined for an unrecognized protocol', () => {
    expect(resolveApplicationType(baseSpec({ protocol: 'WSFED' }))).toBeUndefined()
  })
})

describe('splitList', () => {
  it('trims and drops empty entries from an array', () => {
    expect(splitList(['a', ' b ', '', '  '])).toEqual(['a', 'b'])
  })

  it('splits a comma/newline-delimited string', () => {
    expect(splitList('a, b\nc')).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty array for null/undefined/non-string-non-array', () => {
    expect(splitList(undefined)).toEqual([])
    expect(splitList(null)).toEqual([])
    expect(splitList(42)).toEqual([])
  })
})

describe('buildApplicationBody', () => {
  it('builds a minimal OIDC body with only the required fields', () => {
    const body = buildApplicationBody({
      sectionName: 's',
      name: 'Corp App',
      enabled: true,
      protocol: 'OPENID_CONNECT',
      hiddenFromAppPortal: false,
      oidcType: 'WEB_APP',
      redirectUris: [],
      postLogoutRedirectUris: [],
      grantTypes: ['AUTHORIZATION_CODE'],
      responseTypes: [],
      tokenEndpointAuthMethod: 'CLIENT_SECRET_BASIC',
      acsUrls: [],
      assertionSignedEnabled: true,
      responseIsSigned: false,
    })
    expect(body).toEqual({
      name: 'Corp App',
      enabled: true,
      protocol: 'OPENID_CONNECT',
      type: 'WEB_APP',
      grantTypes: ['AUTHORIZATION_CODE'],
      tokenEndpointAuthMethod: 'CLIENT_SECRET_BASIC',
    })
  })

  it('includes optional OIDC fields when set and omits SAML fields entirely', () => {
    const body = buildApplicationBody({
      sectionName: 's',
      name: 'Corp App',
      description: 'A test app',
      enabled: true,
      protocol: 'OPENID_CONNECT',
      loginPageUrl: 'https://login.example.com',
      hiddenFromAppPortal: true,
      oidcType: 'SINGLE_PAGE_APP',
      redirectUris: ['https://app.example.com/cb'],
      postLogoutRedirectUris: ['https://app.example.com/logout'],
      grantTypes: ['AUTHORIZATION_CODE'],
      responseTypes: ['CODE'],
      tokenEndpointAuthMethod: 'NONE',
      pkceEnforcement: 'S256_REQUIRED',
      refreshTokenDurationSeconds: 2592000,
      homePageUrl: 'https://app.example.com',
      acsUrls: [],
      assertionSignedEnabled: true,
      responseIsSigned: false,
      spEntityId: 'should-be-ignored',
    })
    expect(body).toEqual({
      name: 'Corp App',
      description: 'A test app',
      enabled: true,
      protocol: 'OPENID_CONNECT',
      loginPageUrl: 'https://login.example.com',
      hiddenFromAppPortal: true,
      type: 'SINGLE_PAGE_APP',
      redirectUris: ['https://app.example.com/cb'],
      postLogoutRedirectUris: ['https://app.example.com/logout'],
      grantTypes: ['AUTHORIZATION_CODE'],
      responseTypes: ['CODE'],
      tokenEndpointAuthMethod: 'NONE',
      pkceEnforcement: 'S256_REQUIRED',
      refreshTokenDuration: 2592000,
      homePageUrl: 'https://app.example.com',
    })
    expect(body.acsUrls).toBeUndefined()
    expect(body.spEntityId).toBeUndefined()
  })

  it('builds a minimal SAML body with only the required fields', () => {
    const body = buildApplicationBody({
      sectionName: 's',
      name: 'Corp SAML',
      enabled: true,
      protocol: 'SAML',
      hiddenFromAppPortal: false,
      redirectUris: [],
      postLogoutRedirectUris: [],
      grantTypes: [],
      responseTypes: [],
      samlType: 'WEB_APP',
      acsUrls: ['https://app.example.com/acs'],
      spEntityId: 'https://app.example.com',
      assertionDurationSeconds: 3600,
      assertionSignedEnabled: true,
      responseIsSigned: false,
    })
    expect(body).toEqual({
      name: 'Corp SAML',
      enabled: true,
      protocol: 'SAML',
      type: 'WEB_APP',
      acsUrls: ['https://app.example.com/acs'],
      assertionDuration: 3600,
      spEntityId: 'https://app.example.com',
      assertionSignedEnabled: true,
      responseIsSigned: false,
    })
  })

  it('includes idpSigningKey only when both keyId and algorithm are set, and omits OIDC fields entirely', () => {
    const body = buildApplicationBody({
      sectionName: 's',
      name: 'Corp SAML',
      enabled: true,
      protocol: 'SAML',
      hiddenFromAppPortal: false,
      redirectUris: [],
      postLogoutRedirectUris: [],
      grantTypes: [],
      responseTypes: [],
      samlType: 'CUSTOM_APP',
      acsUrls: ['https://app.example.com/acs'],
      spEntityId: 'https://app.example.com',
      assertionDurationSeconds: 3600,
      assertionSignedEnabled: false,
      responseIsSigned: true,
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      sloBinding: 'HTTP_REDIRECT',
      sloEndpoint: 'https://app.example.com/slo',
      idpSigningKeyId: 'key-1',
      idpSigningKeyAlgorithm: 'SHA256withRSA',
      tokenEndpointAuthMethod: 'should-be-ignored',
    })
    expect(body).toEqual({
      name: 'Corp SAML',
      enabled: true,
      protocol: 'SAML',
      type: 'CUSTOM_APP',
      acsUrls: ['https://app.example.com/acs'],
      assertionDuration: 3600,
      spEntityId: 'https://app.example.com',
      assertionSignedEnabled: false,
      responseIsSigned: true,
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      sloBinding: 'HTTP_REDIRECT',
      sloEndpoint: 'https://app.example.com/slo',
      idpSigningKey: { algorithm: 'SHA256withRSA', keyId: 'key-1' },
    })
    expect(body.tokenEndpointAuthMethod).toBeUndefined()
    expect(body.grantTypes).toBeUndefined()
  })

  it('omits idpSigningKey when only one of keyId/algorithm is set', () => {
    const body = buildApplicationBody({
      sectionName: 's',
      name: 'Corp SAML',
      enabled: true,
      protocol: 'SAML',
      hiddenFromAppPortal: false,
      redirectUris: [],
      postLogoutRedirectUris: [],
      grantTypes: [],
      responseTypes: [],
      samlType: 'WEB_APP',
      acsUrls: ['https://app.example.com/acs'],
      spEntityId: 'https://app.example.com',
      assertionDurationSeconds: 3600,
      assertionSignedEnabled: true,
      responseIsSigned: false,
      idpSigningKeyId: 'key-1',
    })
    expect(body.idpSigningKey).toBeUndefined()
  })
})

describe('stripReadOnlyApplicationFields', () => {
  it('removes id/environment/createdAt/updatedAt/_links/clientId/icon/accessControl but keeps the rest', () => {
    const stripped = stripReadOnlyApplicationFields({
      id: 'app123',
      name: 'Corp App',
      enabled: true,
      protocol: 'OPENID_CONNECT',
      type: 'WEB_APP',
      environment: { id: 'env-1' },
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-02T00:00:00Z',
      clientId: 'client-abc',
      icon: { id: 'icon-1' },
      accessControl: { role: { type: 'ADMIN_USERS_ONLY' } },
      _links: { self: {} },
      grantTypes: ['AUTHORIZATION_CODE'],
    })
    expect(stripped).toEqual({
      name: 'Corp App',
      enabled: true,
      protocol: 'OPENID_CONNECT',
      type: 'WEB_APP',
      grantTypes: ['AUTHORIZATION_CODE'],
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped.clientId).toBeUndefined()
    expect(stripped.icon).toBeUndefined()
    expect(stripped.accessControl).toBeUndefined()
  })
})
