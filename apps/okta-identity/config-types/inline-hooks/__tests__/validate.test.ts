import validate, {
  extractInlineHookSpecs,
  isInlineHookType,
  isHttpsUri,
  parseChannelConfig,
} from '../validate'
import { buildAuthScheme, buildChannel, buildInlineHookBody, stripReadOnlyHookFields } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'inline-hooks',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'inline-hooks',
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
    entityType: 'inline-hooks',
    items: sections,
    sections,
    snapshot: {},
  }
}

const OAUTH_TYPE = 'com.okta.oauth2.tokens.transform'
const SAML_TYPE = 'com.okta.saml.tokens.transform'
const HTTPS_URI = 'https://hooks.example.com/okta'
const OAUTH_CONFIG =
  '{"clientId":"abc","clientSecret":"shh","tokenUrl":"https://idp.example.com/token","scope":"hooks","authType":"client_secret_post"}'

describe('Okta Inline Hooks Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid HTTP hook', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Hook',
          fields: {
            type: OAUTH_TYPE,
            name: 'Token Transform',
            status: 'ACTIVE',
            channelType: 'HTTP',
            uri: HTTPS_URI,
            authHeaderKey: 'Authorization',
            authHeaderValue: 'secret-token',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid OAUTH hook', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Hook',
          fields: { type: SAML_TYPE, name: 'SAML Transform', channelType: 'OAUTH', uri: HTTPS_URI, configJson: OAUTH_CONFIG },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: OAUTH_TYPE, uri: HTTPS_URI, authHeaderValue: 'x' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { type: OAUTH_TYPE, name: 'x'.repeat(256), uri: HTTPS_URI, authHeaderValue: 'x' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a missing type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'No Type', uri: HTTPS_URI, authHeaderValue: 'x' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects an unknown hook type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'com.okta.magic', name: 'Bad Type', uri: HTTPS_URI, authHeaderValue: 'x' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects an invalid channel type', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { type: OAUTH_TYPE, name: 'Bad Channel', channelType: 'SMTP', uri: HTTPS_URI } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_channel_type')).toBe(true)
  })

  it('rejects a missing uri', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: OAUTH_TYPE, name: 'No URI', authHeaderValue: 'x' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('uri'))).toBe(true)
  })

  it('rejects a non-https uri', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { type: OAUTH_TYPE, name: 'Insecure', uri: 'http://hooks.example.com', authHeaderValue: 'x' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_uri')).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { type: OAUTH_TYPE, name: 'Bad Status', status: 'PAUSED', uri: HTTPS_URI, authHeaderValue: 'x' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('rejects malformed channel config JSON', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { type: OAUTH_TYPE, name: 'Bad JSON', uri: HTTPS_URI, configJson: '{not json' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_config')).toBe(true)
  })

  it('rejects a channel config that is a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: OAUTH_TYPE, name: 'Array Cfg', uri: HTTPS_URI, configJson: '[1,2,3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_config')).toBe(true)
  })

  it('rejects a duplicate (name, type) pair (case-insensitive on name)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { type: OAUTH_TYPE, name: 'Transform', uri: HTTPS_URI, authHeaderValue: 'x' } },
        { name: 'sec2', fields: { type: OAUTH_TYPE, name: 'transform', uri: HTTPS_URI, authHeaderValue: 'x' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_hook')).toBe(true)
  })

  it('allows the same name under different types', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { type: OAUTH_TYPE, name: 'Transform', uri: HTTPS_URI, authHeaderValue: 'x' } },
        { name: 'sec2', fields: { type: SAML_TYPE, name: 'Transform', uri: HTTPS_URI, authHeaderValue: 'x' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors.some((e) => e.code === 'duplicate_hook')).toBe(false)
  })

  it('rejects declaring more than 50 hooks (org cap)', async () => {
    const sections = Array.from({ length: 51 }, (_, i) => ({
      name: `sec${i}`,
      fields: { type: OAUTH_TYPE, name: `Hook ${i}`, uri: HTTPS_URI, authHeaderValue: 'x' },
    }))
    const result = await validate(makeCtx(sections))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'org_cap')).toBe(true)
  })

  it('warns (not errors) when an HTTP secret is missing', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: OAUTH_TYPE, name: 'No Secret', channelType: 'HTTP', uri: HTTPS_URI } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'secret_missing')).toBe(true)
  })

  it('warns when an OAUTH channel has no client credentials', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: OAUTH_TYPE, name: 'No Creds', channelType: 'OAUTH', uri: HTTPS_URI } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'oauth_credentials_missing')).toBe(true)
  })
})

describe('extractInlineHookSpecs', () => {
  it('trims fields, lower-cases the type, upper-cases status/channel and drops a blank config', () => {
    const specs = extractInlineHookSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            type: '  COM.OKTA.OAuth2.Tokens.Transform  ',
            name: '  Token Transform  ',
            status: ' inactive ',
            channelType: ' http ',
            uri: '  https://x.example.com  ',
            authHeaderKey: '  X-Auth  ',
            authHeaderValue: '   ',
            configJson: '   ',
          },
        },
      ]),
    )
    expect(specs[0].type).toBe('com.okta.oauth2.tokens.transform')
    expect(specs[0].name).toBe('Token Transform')
    expect(specs[0].status).toBe('INACTIVE')
    expect(specs[0].channelType).toBe('HTTP')
    expect(specs[0].uri).toBe('https://x.example.com')
    expect(specs[0].authHeaderKey).toBe('X-Auth')
    expect(specs[0].authHeaderValue).toBeUndefined()
    expect(specs[0].configJson).toBeUndefined()
  })

  it('defaults status to ACTIVE and channelType to HTTP when unset', () => {
    const specs = extractInlineHookSpecs(makeCanvas([{ name: 'sec1', fields: { type: OAUTH_TYPE, name: 'Z' } }]))
    expect(specs[0].status).toBe('ACTIVE')
    expect(specs[0].channelType).toBe('HTTP')
  })
})

describe('parseChannelConfig', () => {
  it('parses a JSON object', () => {
    expect(parseChannelConfig('{"a":1}')).toEqual({ a: 1 })
  })
  it('rejects a JSON array', () => {
    expect(parseChannelConfig('[1,2]')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseChannelConfig('{nope')).toBe(null)
  })
})

describe('isInlineHookType', () => {
  it('matches supported types case-insensitively and rejects others', () => {
    expect(isInlineHookType('com.okta.telephony.provider')).toBe(true)
    expect(isInlineHookType('  COM.OKTA.USER.PRE-REGISTRATION  ')).toBe(true)
    expect(isInlineHookType('com.okta.unknown')).toBe(false)
  })
})

describe('isHttpsUri', () => {
  it('accepts https and rejects http / blank', () => {
    expect(isHttpsUri('https://x.example.com')).toBe(true)
    expect(isHttpsUri('http://x.example.com')).toBe(false)
    expect(isHttpsUri('   ')).toBe(false)
  })
})

describe('buildAuthScheme', () => {
  it('includes the secret value only when provided', () => {
    const withSecret = buildAuthScheme({
      sectionName: 's',
      name: 'H',
      type: OAUTH_TYPE,
      status: 'ACTIVE',
      channelType: 'HTTP',
      uri: HTTPS_URI,
      authHeaderKey: 'X-Auth',
      authHeaderValue: 'shh',
    })
    expect(withSecret).toEqual({ type: 'HEADER', key: 'X-Auth', value: 'shh' })

    const withoutSecret = buildAuthScheme({
      sectionName: 's',
      name: 'H',
      type: OAUTH_TYPE,
      status: 'ACTIVE',
      channelType: 'HTTP',
      uri: HTTPS_URI,
      authHeaderKey: '',
    })
    // No value key at all (preserves the stored secret), and defaults the header name.
    expect(withoutSecret).toEqual({ type: 'HEADER', key: 'Authorization' })
    expect(withoutSecret.value).toBeUndefined()
  })
})

describe('buildChannel / buildInlineHookBody', () => {
  it('builds an HTTP channel with the modeled endpoint and header auth winning over the blob', () => {
    const channel = buildChannel(
      {
        sectionName: 's',
        name: 'H',
        type: OAUTH_TYPE,
        status: 'ACTIVE',
        channelType: 'HTTP',
        uri: HTTPS_URI,
        authHeaderKey: 'Authorization',
        authHeaderValue: 'shh',
      },
      { uri: 'https://HIJACK', authScheme: { type: 'HEADER', key: 'X', value: 'HIJACK' } },
    )
    expect(channel).toEqual({
      type: 'HTTP',
      version: '1.0.0',
      config: {
        uri: HTTPS_URI,
        method: 'POST',
        headers: [],
        authScheme: { type: 'HEADER', key: 'Authorization', value: 'shh' },
      },
    })
  })

  it('builds an OAUTH channel by merging the config blob (incl. clientSecret) with the modeled uri winning', () => {
    const body = buildInlineHookBody(
      {
        sectionName: 's',
        name: 'SAML',
        type: SAML_TYPE,
        status: 'ACTIVE',
        channelType: 'OAUTH',
        uri: HTTPS_URI,
        authHeaderKey: '',
      },
      { clientId: 'abc', clientSecret: 'shh', tokenUrl: 'https://idp/token', scope: 'hooks', authType: 'client_secret_post' },
    )
    expect(body).toEqual({
      name: 'SAML',
      type: SAML_TYPE,
      version: '1.0.0',
      channel: {
        type: 'OAUTH',
        version: '1.0.0',
        config: {
          uri: HTTPS_URI,
          method: 'POST',
          headers: [],
          clientId: 'abc',
          clientSecret: 'shh',
          tokenUrl: 'https://idp/token',
          scope: 'hooks',
          authType: 'client_secret_post',
        },
      },
    })
    // An OAUTH channel carries no header authScheme.
    expect((body.channel as { config: Record<string, unknown> }).config.authScheme).toBeUndefined()
  })
})

describe('stripReadOnlyHookFields', () => {
  it('removes id/created/lastUpdated/system/_links/_embedded/status but keeps name/type/channel', () => {
    const stripped = stripReadOnlyHookFields({
      id: 'cal4x',
      name: 'Token Transform',
      type: OAUTH_TYPE,
      status: 'ACTIVE',
      system: false,
      created: '2020-01-01T00:00:00Z',
      lastUpdated: '2020-01-02T00:00:00Z',
      _links: { self: {} },
      _embedded: {},
      channel: { type: 'HTTP', version: '1.0.0', config: { uri: HTTPS_URI } },
    })
    expect(stripped).toEqual({
      name: 'Token Transform',
      type: OAUTH_TYPE,
      channel: { type: 'HTTP', version: '1.0.0', config: { uri: HTTPS_URI } },
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped.status).toBeUndefined()
  })
})
