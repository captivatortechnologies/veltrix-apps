import validate, {
  extractScopeSpecs,
  isReservedScopeName,
  toBoolean,
  CONSENT_VALUES,
  METADATA_PUBLISH_VALUES,
  RESERVED_SCOPE_NAMES,
} from '../validate'
import { buildScopeBody, stripReadOnlyScopeFields } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'auth-server-scopes',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'auth-server-scopes',
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
    entityType: 'auth-server-scopes',
    items: sections,
    sections,
    snapshot: {},
  }
}

const VALID_FIELDS = { authServerId: 'default', name: 'read:messages' }

describe('Okta Authorization Server Scopes Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully specified scope', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Scope',
          fields: {
            authServerId: 'default',
            name: 'read:messages',
            displayName: 'Read messages',
            description: 'Read a user’s messages',
            consent: 'REQUIRED',
            metadataPublish: 'ALL_CLIENTS',
            default: true,
            optional: false,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a minimal scope (authServerId + name only)', async () => {
    const result = await validate(makeCtx([{ name: 'Scope', fields: { ...VALID_FIELDS } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing authServerId', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'read:messages' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('authServerId'))).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { authServerId: 'default' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a scope name containing whitespace', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { authServerId: 'default', name: 'read messages' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects each reserved system scope name', async () => {
    for (const name of RESERVED_SCOPE_NAMES) {
      const result = await validate(makeCtx([{ name: 'sec1', fields: { authServerId: 'default', name } }]))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'reserved_scope')).toBe(true)
    }
  })

  it('rejects a reserved scope name case-insensitively', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { authServerId: 'default', name: 'OpenID' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_scope')).toBe(true)
  })

  it('rejects an invalid consent value', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, consent: 'MAYBE' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_consent')).toBe(true)
  })

  it('accepts each valid consent value', async () => {
    for (const consent of CONSENT_VALUES) {
      const result = await validate(makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, consent } }]))
      expect(result.valid).toBe(true)
    }
  })

  it('rejects an invalid metadataPublish value', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, metadataPublish: 'SOME_CLIENTS' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_metadata_publish')).toBe(true)
  })

  it('accepts each valid metadataPublish value', async () => {
    for (const metadataPublish of METADATA_PUBLISH_VALUES) {
      const result = await validate(makeCtx([{ name: 'sec1', fields: { ...VALID_FIELDS, metadataPublish } }]))
      expect(result.valid).toBe(true)
    }
  })

  it('rejects a duplicate (authServerId, name) pair', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { authServerId: 'default', name: 'read:messages' } },
        { name: 'sec2', fields: { authServerId: 'default', name: 'read:messages' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_scope')).toBe(true)
  })

  it('allows the same scope name on different authorization servers', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { authServerId: 'default', name: 'read:messages' } },
        { name: 'sec2', fields: { authServerId: 'aus1custom', name: 'read:messages' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('extractScopeSpecs', () => {
  it('trims fields, upper-cases enums and coerces the checkboxes', () => {
    const specs = extractScopeSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            authServerId: '  default  ',
            name: '  read:messages  ',
            displayName: '  Read messages  ',
            description: '  desc  ',
            consent: '  required  ',
            metadataPublish: '  all_clients  ',
            default: 'true',
            optional: true,
          },
        },
      ]),
    )
    expect(specs[0].authServerId).toBe('default')
    expect(specs[0].name).toBe('read:messages')
    expect(specs[0].displayName).toBe('Read messages')
    expect(specs[0].description).toBe('desc')
    expect(specs[0].consent).toBe('REQUIRED')
    expect(specs[0].metadataPublish).toBe('ALL_CLIENTS')
    expect(specs[0].default).toBe(true)
    expect(specs[0].optional).toBe(true)
  })

  it('defaults consent to IMPLICIT and metadataPublish to NO_CLIENTS when unset', () => {
    const specs = extractScopeSpecs(makeCanvas([{ name: 'sec1', fields: { ...VALID_FIELDS } }]))
    expect(specs[0].consent).toBe('IMPLICIT')
    expect(specs[0].metadataPublish).toBe('NO_CLIENTS')
    expect(specs[0].default).toBe(false)
    expect(specs[0].optional).toBe(false)
  })

  it('drops blank optional text fields to undefined', () => {
    const specs = extractScopeSpecs(
      makeCanvas([{ name: 'sec1', fields: { ...VALID_FIELDS, displayName: '   ', description: '' } }]),
    )
    expect(specs[0].displayName).toBeUndefined()
    expect(specs[0].description).toBeUndefined()
  })
})

describe('toBoolean', () => {
  it('coerces real booleans and truthy strings', () => {
    expect(toBoolean(true)).toBe(true)
    expect(toBoolean(false)).toBe(false)
    expect(toBoolean('true')).toBe(true)
    expect(toBoolean('YES')).toBe(true)
    expect(toBoolean('1')).toBe(true)
    expect(toBoolean('false')).toBe(false)
    expect(toBoolean('no')).toBe(false)
    expect(toBoolean(undefined)).toBe(false)
  })
})

describe('isReservedScopeName', () => {
  it('matches the reserved system scopes case-insensitively', () => {
    expect(isReservedScopeName('openid')).toBe(true)
    expect(isReservedScopeName('  OFFLINE_ACCESS  ')).toBe(true)
    expect(isReservedScopeName('read:messages')).toBe(false)
  })
})

describe('buildScopeBody', () => {
  it('always sends name/consent/default/metadataPublish/optional and omits blank displayName/description', () => {
    const body = buildScopeBody({
      sectionName: 's',
      authServerId: 'default',
      name: 'read:messages',
      consent: 'IMPLICIT',
      default: false,
      metadataPublish: 'NO_CLIENTS',
      optional: false,
    })
    expect(body).toEqual({
      name: 'read:messages',
      consent: 'IMPLICIT',
      default: false,
      metadataPublish: 'NO_CLIENTS',
      optional: false,
    })
    expect(body.displayName).toBeUndefined()
    expect(body.description).toBeUndefined()
  })

  it('includes displayName and description when present', () => {
    const body = buildScopeBody({
      sectionName: 's',
      authServerId: 'default',
      name: 'read:messages',
      displayName: 'Read messages',
      description: 'Read a user’s messages',
      consent: 'REQUIRED',
      default: true,
      metadataPublish: 'ALL_CLIENTS',
      optional: true,
    })
    expect(body).toEqual({
      name: 'read:messages',
      displayName: 'Read messages',
      description: 'Read a user’s messages',
      consent: 'REQUIRED',
      default: true,
      metadataPublish: 'ALL_CLIENTS',
      optional: true,
    })
  })
})

describe('stripReadOnlyScopeFields', () => {
  it('removes id/created/lastUpdated/system/_links/_embedded but keeps authored fields', () => {
    const stripped = stripReadOnlyScopeFields({
      id: 'scp1abc',
      name: 'read:messages',
      displayName: 'Read messages',
      consent: 'IMPLICIT',
      default: false,
      metadataPublish: 'NO_CLIENTS',
      optional: false,
      system: false,
      created: '2020-01-01T00:00:00Z',
      lastUpdated: '2020-01-02T00:00:00Z',
      _links: { self: {} },
      _embedded: {},
    })
    expect(stripped).toEqual({
      name: 'read:messages',
      displayName: 'Read messages',
      consent: 'IMPLICIT',
      default: false,
      metadataPublish: 'NO_CLIENTS',
      optional: false,
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped.system).toBeUndefined()
  })
})
