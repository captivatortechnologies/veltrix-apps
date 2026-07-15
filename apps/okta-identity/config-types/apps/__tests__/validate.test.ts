import validate, {
  extractAppSpecs,
  isProtectedAppName,
  parseJsonObject,
  stripCredentialSecrets,
  stripX5c,
} from '../validate'
import {
  buildAppBody,
  classifyAppMatches,
  extractAccessPolicyId,
  parseAppBlobs,
  stripReadOnlyAppFields,
} from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'apps',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'apps',
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
    toolType: 'okta-identity',
    entityType: 'apps',
    items: sections,
    sections,
    snapshot: {},
  }
}

const OIDC_SETTINGS =
  '{"oauthClient":{"redirect_uris":["https://app/cb"],"grant_types":["authorization_code"],"response_types":["code"],"application_type":"web"}}'
const OIDC_CREDS =
  '{"oauthClient":{"token_endpoint_auth_method":"client_secret_basic","client_id":"abc","client_secret":"s3cr3t"}}'
const SAML_SETTINGS =
  '{"signOn":{"ssoAcsUrl":"https://app/acs","audience":"https://app","recipient":"https://app/acs","destination":"https://app/acs"}}'
const BOOKMARK_SETTINGS = '{"app":{"url":"https://example.com","requestIntegration":false}}'

describe('Okta Apps Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid OIDC app', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'App',
          fields: {
            label: 'Corp OIDC',
            name: 'oidc_client',
            signOnMode: 'OPENID_CONNECT',
            status: 'ACTIVE',
            settingsJson: OIDC_SETTINGS,
            credentialsJson: OIDC_CREDS,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid custom SAML2 app with no name', async () => {
    const result = await validate(
      makeCtx([{ name: 'App', fields: { label: 'Corp SAML', signOnMode: 'SAML_2_0', settingsJson: SAML_SETTINGS } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid bookmark app', async () => {
    const result = await validate(
      makeCtx([{ name: 'App', fields: { label: 'Wiki', name: 'bookmark', signOnMode: 'BOOKMARK', settingsJson: BOOKMARK_SETTINGS } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing label', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { signOnMode: 'SAML_2_0' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('label'))).toBe(true)
  })

  it('rejects a label longer than 100 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { label: 'x'.repeat(101), signOnMode: 'SAML_2_0' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a missing signOnMode', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { label: 'No Mode' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('signOnMode'))).toBe(true)
  })

  it('rejects an unknown signOnMode', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { label: 'Bad Mode', signOnMode: 'SAML_1_1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_sign_on_mode')).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { label: 'Bad Status', signOnMode: 'SAML_2_0', status: 'PAUSED' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('requires an integration name for OPENID_CONNECT', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { label: 'OIDC No Name', signOnMode: 'OPENID_CONNECT', settingsJson: OIDC_SETTINGS } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a protected system app name (explicit list)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { label: 'Saas', name: 'saasure', signOnMode: 'OPENID_CONNECT', settingsJson: OIDC_SETTINGS } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'protected_app')).toBe(true)
  })

  it('rejects a protected okta_-prefixed app name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { label: 'Admin', name: 'okta_admin_console', signOnMode: 'SAML_2_0' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'protected_app')).toBe(true)
  })

  it('warns (but stays valid) when a name is given for an auto-assigned mode', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { label: 'SAML Named', name: 'my_saml', signOnMode: 'SAML_2_0', settingsJson: SAML_SETTINGS } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'name_ignored')).toBe(true)
  })

  it('rejects malformed settings JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { label: 'Bad Settings', signOnMode: 'SAML_2_0', settingsJson: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects settings that are a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { label: 'Array Settings', signOnMode: 'SAML_2_0', settingsJson: '[1,2,3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects malformed credentials JSON', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { label: 'Bad Creds', name: 'oidc_client', signOnMode: 'OPENID_CONNECT', credentialsJson: '{nope' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_credentials')).toBe(true)
  })

  it('rejects a duplicate (label, signOnMode) identity (case-insensitive label)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { label: 'Corp', signOnMode: 'SAML_2_0', settingsJson: SAML_SETTINGS } },
        { name: 'sec2', fields: { label: 'corp', signOnMode: 'SAML_2_0', settingsJson: SAML_SETTINGS } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_app')).toBe(true)
  })

  it('allows the same label under a different signOnMode', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { label: 'Corp', signOnMode: 'SAML_2_0', settingsJson: SAML_SETTINGS } },
        { name: 'sec2', fields: { label: 'Corp', name: 'oidc_client', signOnMode: 'OPENID_CONNECT', settingsJson: OIDC_SETTINGS } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('extractAppSpecs', () => {
  it('trims fields, upper-cases signOnMode/status and drops blank blobs', () => {
    const specs = extractAppSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            label: '  Corp OIDC  ',
            name: '  oidc_client  ',
            signOnMode: ' openid_connect ',
            status: ' inactive ',
            accessPolicyId: '  rst123  ',
            settingsJson: '   ',
            credentialsJson: '  ',
          },
        },
      ]),
    )
    expect(specs[0].label).toBe('Corp OIDC')
    expect(specs[0].name).toBe('oidc_client')
    expect(specs[0].signOnMode).toBe('OPENID_CONNECT')
    expect(specs[0].status).toBe('INACTIVE')
    expect(specs[0].accessPolicyId).toBe('rst123')
    expect(specs[0].settingsJson).toBeUndefined()
    expect(specs[0].credentialsJson).toBeUndefined()
  })

  it('defaults status to ACTIVE and leaves name undefined when unset', () => {
    const specs = extractAppSpecs(makeCanvas([{ name: 'sec1', fields: { label: 'Z', signOnMode: 'SAML_2_0' } }]))
    expect(specs[0].status).toBe('ACTIVE')
    expect(specs[0].name).toBeUndefined()
  })
})

describe('parseJsonObject', () => {
  it('parses a JSON object', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
  })
  it('rejects a JSON array', () => {
    expect(parseJsonObject('[1,2]')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseJsonObject('{nope')).toBe(null)
  })
})

describe('isProtectedAppName', () => {
  it('flags the explicit protected names and any okta_ prefix', () => {
    expect(isProtectedAppName('saasure')).toBe(true)
    expect(isProtectedAppName('okta_admin_console')).toBe(true)
    expect(isProtectedAppName('okta_enduser')).toBe(true)
    expect(isProtectedAppName('okta_browser_plugin')).toBe(true)
    expect(isProtectedAppName('okta_anything_else')).toBe(true)
    expect(isProtectedAppName('OKTA_ADMIN_CONSOLE')).toBe(true)
  })
  it('allows normal names and tolerates undefined/blank', () => {
    expect(isProtectedAppName('oidc_client')).toBe(false)
    expect(isProtectedAppName('my_app')).toBe(false)
    expect(isProtectedAppName(undefined)).toBe(false)
    expect(isProtectedAppName('   ')).toBe(false)
  })
})

describe('stripCredentialSecrets', () => {
  it('removes oauthClient.client_secret, the whole signing object and nested x5c', () => {
    const credentials = {
      oauthClient: { client_id: 'abc', client_secret: 's3cr3t', token_endpoint_auth_method: 'client_secret_basic' },
      signing: { kid: 'k1', rotationMode: 'AUTO' },
      userNameTemplate: { type: 'BUILT_IN', template: 'idpuser.email' },
      trust: { keys: [{ x5c: ['CERT'], kid: 'abc' }] },
    }
    const stripped = stripCredentialSecrets(credentials)
    expect(stripped).toEqual({
      oauthClient: { client_id: 'abc', token_endpoint_auth_method: 'client_secret_basic' },
      userNameTemplate: { type: 'BUILT_IN', template: 'idpuser.email' },
      trust: { keys: [{ kid: 'abc' }] },
    })
    expect((stripped.oauthClient as Record<string, unknown>).client_secret).toBeUndefined()
    expect(stripped.signing).toBeUndefined()
    // The original input is NOT mutated.
    expect(credentials.oauthClient.client_secret).toBe('s3cr3t')
    expect(credentials.signing.kid).toBe('k1')
  })

  it('tolerates a null/undefined credentials object', () => {
    expect(stripCredentialSecrets(null)).toEqual({})
    expect(stripCredentialSecrets(undefined)).toEqual({})
  })
})

describe('stripX5c', () => {
  it('removes any nested x5c and keeps everything else', () => {
    const blob = { signOn: { attributeStatements: [] }, certs: { x5c: ['CERT'], format: 'PEM' } }
    expect(stripX5c(blob)).toEqual({ signOn: { attributeStatements: [] }, certs: { format: 'PEM' } })
    // Original not mutated.
    expect(blob.certs.x5c).toEqual(['CERT'])
  })
})

describe('buildAppBody', () => {
  it('assembles label/signOnMode/name and the supplied blobs', () => {
    const body = buildAppBody(
      { sectionName: 's', label: 'Corp OIDC', name: 'oidc_client', signOnMode: 'OPENID_CONNECT', status: 'ACTIVE' },
      { settings: { oauthClient: { application_type: 'web' } }, credentials: { oauthClient: { client_id: 'abc' } } },
    )
    expect(body).toEqual({
      label: 'Corp OIDC',
      signOnMode: 'OPENID_CONNECT',
      name: 'oidc_client',
      settings: { oauthClient: { application_type: 'web' } },
      credentials: { oauthClient: { client_id: 'abc' } },
    })
  })

  it('omits name when unset and never carries status', () => {
    const body = buildAppBody({ sectionName: 's', label: 'Corp SAML', signOnMode: 'SAML_2_0', status: 'INACTIVE' }, {})
    expect(body).toEqual({ label: 'Corp SAML', signOnMode: 'SAML_2_0' })
    expect(body.name).toBeUndefined()
    expect(body.status).toBeUndefined()
  })
})

describe('parseAppBlobs', () => {
  it('parses every supplied blob and leaves absent ones undefined', () => {
    const blobs = parseAppBlobs({
      sectionName: 's',
      label: 'Corp OIDC',
      signOnMode: 'OPENID_CONNECT',
      status: 'ACTIVE',
      settingsJson: '{"oauthClient":{"application_type":"web"}}',
    })
    expect(blobs.settings).toEqual({ oauthClient: { application_type: 'web' } })
    expect(blobs.credentials).toBeUndefined()
  })

  it('throws on a malformed blob', () => {
    let threw = false
    try {
      parseAppBlobs({ sectionName: 's', label: 'X', signOnMode: 'SAML_2_0', status: 'ACTIVE', settingsJson: '{bad' })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

describe('classifyAppMatches', () => {
  const items = [
    { id: '0oa1', label: 'Corp', signOnMode: 'SAML_2_0' },
    { id: '0oa2', label: 'Corp', signOnMode: 'OPENID_CONNECT' },
    { id: '0oa3', label: 'Other', signOnMode: 'SAML_2_0' },
  ]

  it('separates exact (label + signOnMode) matches from label collisions', () => {
    const { exact, labelConflicts } = classifyAppMatches(items, 'Corp', 'SAML_2_0')
    expect(exact).toHaveLength(1)
    expect(exact[0].id).toBe('0oa1')
    expect(labelConflicts).toHaveLength(1)
    expect(labelConflicts[0].id).toBe('0oa2')
  })

  it('detects an ambiguous multi-match on the same identity', () => {
    const dup = [
      { id: 'a', label: 'Dup', signOnMode: 'OPENID_CONNECT' },
      { id: 'b', label: 'Dup', signOnMode: 'openid_connect' },
    ]
    const { exact } = classifyAppMatches(dup, 'Dup', 'OPENID_CONNECT')
    expect(exact).toHaveLength(2)
  })

  it('returns no matches when the label is absent', () => {
    const { exact, labelConflicts } = classifyAppMatches(items, 'Missing', 'SAML_2_0')
    expect(exact).toHaveLength(0)
    expect(labelConflicts).toHaveLength(0)
  })
})

describe('extractAccessPolicyId', () => {
  it('parses the policy id from _links.accessPolicy.href', () => {
    const id = extractAccessPolicyId({
      id: '0oa1',
      _links: { accessPolicy: { href: 'https://acme.okta.com/api/v1/policies/rst1abc2def' } },
    })
    expect(id).toBe('rst1abc2def')
  })

  it('returns undefined when there is no access policy link', () => {
    expect(extractAccessPolicyId({ id: '0oa1', _links: {} })).toBeUndefined()
    expect(extractAccessPolicyId({ id: '0oa1' })).toBeUndefined()
  })
})

describe('stripReadOnlyAppFields', () => {
  it('removes id/created/lastUpdated/status/orn/features/universalLogout/_links/_embedded and keeps the rest', () => {
    const stripped = stripReadOnlyAppFields({
      id: '0oaabc',
      label: 'Corp OIDC',
      name: 'oidc_client',
      signOnMode: 'OPENID_CONNECT',
      status: 'ACTIVE',
      created: '2020-01-01T00:00:00Z',
      lastUpdated: '2020-01-02T00:00:00Z',
      orn: 'orn:okta:...',
      features: [],
      universalLogout: {},
      _links: { self: {} },
      _embedded: {},
      settings: { oauthClient: { application_type: 'web' } },
      credentials: { oauthClient: { client_id: 'abc' } },
    })
    expect(stripped).toEqual({
      label: 'Corp OIDC',
      name: 'oidc_client',
      signOnMode: 'OPENID_CONNECT',
      settings: { oauthClient: { application_type: 'web' } },
      credentials: { oauthClient: { client_id: 'abc' } },
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped.status).toBeUndefined()
  })
})
