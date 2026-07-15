import validate, {
  authenticatorIdentity,
  extractAuthenticatorSpecs,
  isCreatableKey,
  isMultiInstanceKey,
  isNonDeactivatableKey,
  isProviderKey,
  parseJsonObject,
} from '../validate'
import {
  buildCreateBody,
  buildProvider,
  buildUpdateBody,
  stripReadOnlyAuthenticatorFields,
} from '../deploy'
import { stripProviderSecrets } from '../driftDetect'
import type { LiveAuthenticator } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'authenticators',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'authenticators',
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
    entityType: 'authenticators',
    items: sections,
    sections,
    snapshot: {},
  }
}

const DUO_PROVIDER = '{"type":"DUO","configuration":{"host":"api-x.duosecurity.com"}}'

describe('Okta Authenticators Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a built-in authenticator (updated in place, no name)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'Auth', fields: { key: 'okta_email', status: 'ACTIVE', settingsJson: '{"userVerification":"PREFERRED"}' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a custom_app authenticator with a name', async () => {
    const result = await validate(
      makeCtx([{ name: 'Auth', fields: { key: 'custom_app', name: 'My Custom App', status: 'ACTIVE' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a duo provider authenticator with provider + secrets', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Auth',
          fields: { key: 'duo', name: 'Duo', providerJson: DUO_PROVIDER, secretKey: 'sk', integrationKey: 'ik' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing key', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { status: 'ACTIVE' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('key'))).toBe(true)
  })

  it('rejects an unknown authenticator key', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { key: 'magic_key' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_key')).toBe(true)
  })

  it('rejects a custom_app without a name (identity is key+name)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { key: 'custom_app' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 128 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { key: 'okta_email', name: 'x'.repeat(129) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { key: 'okta_email', status: 'PAUSED' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('warns that okta_password cannot be deactivated (INACTIVE ignored)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { key: 'okta_password', status: 'INACTIVE' } }]))
    // A warning, not an error — the deploy simply leaves okta_password ACTIVE.
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'non_deactivatable')).toBe(true)
  })

  it('rejects malformed settings JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { key: 'okta_email', settingsJson: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects settings that are a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { key: 'okta_email', settingsJson: '[1,2,3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_settings')).toBe(true)
  })

  it('rejects malformed provider JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { key: 'duo', name: 'Duo', providerJson: '{bad' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_provider')).toBe(true)
  })

  it('warns when a provider object is set on a non-provider key', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { key: 'okta_email', providerJson: DUO_PROVIDER } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'provider_ignored')).toBe(true)
  })

  it('warns when a secret is set on a non-provider key', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { key: 'okta_email', secretKey: 'sk' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'secret_ignored')).toBe(true)
  })

  it('rejects a duplicate built-in authenticator key', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { key: 'okta_email' } },
        { name: 'sec2', fields: { key: 'okta_email' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_authenticator')).toBe(true)
  })

  it('rejects a duplicate (custom_app, name) pair', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { key: 'custom_app', name: 'App' } },
        { name: 'sec2', fields: { key: 'custom_app', name: 'App' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_authenticator')).toBe(true)
  })

  it('allows two custom_app authenticators with different names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { key: 'custom_app', name: 'App One' } },
        { name: 'sec2', fields: { key: 'custom_app', name: 'App Two' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('extractAuthenticatorSpecs', () => {
  it('trims fields, lower-cases the key, upper-cases the status and drops a blank config', () => {
    const specs = extractAuthenticatorSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: { key: '  OKTA_EMAIL  ', name: '  Email  ', status: ' inactive ', settingsJson: '   ', secretKey: 'sk' },
        },
      ]),
    )
    expect(specs[0].key).toBe('okta_email')
    expect(specs[0].name).toBe('Email')
    expect(specs[0].status).toBe('INACTIVE')
    expect(specs[0].settingsJson).toBeUndefined()
    expect(specs[0].secretKey).toBe('sk')
  })

  it('defaults status to ACTIVE when unset', () => {
    const specs = extractAuthenticatorSpecs(makeCanvas([{ name: 'sec1', fields: { key: 'google_otp' } }]))
    expect(specs[0].status).toBe('ACTIVE')
  })
})

describe('key predicates and identity', () => {
  it('classifies multi-instance / creatable / provider / non-deactivatable keys', () => {
    expect(isMultiInstanceKey('custom_app')).toBe(true)
    expect(isMultiInstanceKey('okta_email')).toBe(false)
    expect(isCreatableKey('duo')).toBe(true)
    expect(isCreatableKey('okta_password')).toBe(false)
    expect(isProviderKey('duo')).toBe(true)
    expect(isProviderKey('custom_app')).toBe(false)
    expect(isNonDeactivatableKey('okta_password')).toBe(true)
    expect(isNonDeactivatableKey('okta_email')).toBe(false)
  })

  it('builds the logical identity (key, or key::name for multi-instance)', () => {
    expect(authenticatorIdentity('okta_email', 'Email')).toBe('okta_email')
    expect(authenticatorIdentity('custom_app', 'My App')).toBe('custom_app::My App')
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

describe('buildProvider', () => {
  it('merges the secret and integration keys into provider.configuration', () => {
    const provider = buildProvider({ type: 'DUO', configuration: { host: 'h' } }, 'sk', 'ik')
    expect(provider).toEqual({ type: 'DUO', configuration: { host: 'h', secretKey: 'sk', integrationKey: 'ik' } })
  })
  it('returns undefined when there is nothing to send', () => {
    expect(buildProvider(undefined, undefined, undefined)).toBeUndefined()
  })
  it('creates a configuration object when the provider has none', () => {
    const provider = buildProvider({ type: 'DUO' }, 'sk', undefined)
    expect(provider).toEqual({ type: 'DUO', configuration: { secretKey: 'sk' } })
  })
})

describe('buildCreateBody', () => {
  it('builds a custom_app create body with agreeToTerms and the mapped type', () => {
    const body = buildCreateBody({ sectionName: 's', key: 'custom_app', name: 'My App', status: 'ACTIVE' })
    expect(body.key).toBe('custom_app')
    expect(body.type).toBe('app')
    expect(body.name).toBe('My App')
    expect(body.agreeToTerms).toBe(true)
  })

  it('builds a duo create body with the provider secrets merged in', () => {
    const body = buildCreateBody({
      sectionName: 's',
      key: 'duo',
      name: 'Duo',
      status: 'ACTIVE',
      providerJson: DUO_PROVIDER,
      secretKey: 'sk',
      integrationKey: 'ik',
    })
    const provider = body.provider as { configuration: Record<string, unknown> }
    expect(provider.configuration.secretKey).toBe('sk')
    expect(provider.configuration.integrationKey).toBe('ik')
    expect(provider.configuration.host).toBe('api-x.duosecurity.com')
    expect(body.agreeToTerms).toBeUndefined()
  })
})

describe('buildUpdateBody', () => {
  it('preserves the live type/key, strips read-only fields and overlays the authored settings', () => {
    const live: LiveAuthenticator = {
      id: 'aut1',
      key: 'okta_email',
      type: 'email',
      name: 'Email',
      status: 'ACTIVE',
      settings: { allowedFor: 'any' },
      created: '2020-01-01T00:00:00Z',
      lastUpdated: '2020-01-02T00:00:00Z',
      _links: { self: {} },
    }
    const body = buildUpdateBody(live, {
      sectionName: 's',
      key: 'okta_email',
      name: '',
      status: 'ACTIVE',
      settingsJson: '{"userVerification":"PREFERRED"}',
    })
    expect(body.type).toBe('email')
    expect(body.key).toBe('okta_email')
    expect(body.settings).toEqual({ userVerification: 'PREFERRED' })
    expect(body.id).toBeUndefined()
    expect(body.status).toBeUndefined()
  })
})

describe('stripReadOnlyAuthenticatorFields', () => {
  it('removes id/created/lastUpdated/_links/_embedded/status but keeps key/type/name/settings/provider', () => {
    const stripped = stripReadOnlyAuthenticatorFields({
      id: 'aut1',
      key: 'duo',
      type: 'app',
      name: 'Duo',
      status: 'ACTIVE',
      created: '2020-01-01T00:00:00Z',
      lastUpdated: '2020-01-02T00:00:00Z',
      _links: { self: {} },
      _embedded: {},
      settings: { a: 1 },
      provider: { type: 'DUO' },
    })
    expect(stripped).toEqual({
      key: 'duo',
      type: 'app',
      name: 'Duo',
      settings: { a: 1 },
      provider: { type: 'DUO' },
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped.status).toBeUndefined()
  })
})

describe('stripProviderSecrets (drift excludes write-only secrets)', () => {
  it('removes the write-only secret configuration values before diffing', () => {
    const stripped = stripProviderSecrets({
      type: 'DUO',
      configuration: { host: 'h', secretKey: 'sk', integrationKey: 'ik' },
    })
    expect(stripped).toEqual({ type: 'DUO', configuration: { host: 'h' } })
  })
  it('returns undefined for an absent provider', () => {
    expect(stripProviderSecrets(undefined)).toBeUndefined()
  })
})
