import validate, {
  checkProtocol,
  extractIdpSpecs,
  parseJsonObject,
  stripClientSecret,
} from '../validate'
import { buildIdpBody, stripReadOnlyIdpFields } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'idps',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'idps',
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
    entityType: 'idps',
    items: sections,
    sections,
    snapshot: {},
  }
}

const OIDC_PROTOCOL =
  '{"type":"OIDC","endpoints":{"authorization":{"url":"https://idp/authorize","binding":"HTTP-REDIRECT"},"token":{"url":"https://idp/token","binding":"HTTP-POST"}},"scopes":["openid","email"],"credentials":{"client":{"client_id":"abc","client_secret":"s3cr3t"}}}'
const SAML_PROTOCOL =
  '{"type":"SAML2","endpoints":{"sso":{"url":"https://idp/sso","binding":"HTTP-POST"}},"credentials":{"trust":{"issuer":"https://idp","audience":"https://acme.okta.com"}}}'
const POLICY =
  '{"provisioning":{"action":"AUTO"},"subject":{"userNameTemplate":{"template":"idpuser.email"},"matchType":"USERNAME"}}'

describe('Okta IdP Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid OIDC IdP', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'IdP',
          fields: { type: 'OIDC', name: 'Corp OIDC', status: 'ACTIVE', protocolJson: OIDC_PROTOCOL, policyJson: POLICY },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid SAML2 IdP', async () => {
    const result = await validate(
      makeCtx([{ name: 'IdP', fields: { type: 'SAML2', name: 'Corp SAML', protocolJson: SAML_PROTOCOL, policyJson: POLICY } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'OIDC', protocolJson: OIDC_PROTOCOL, policyJson: POLICY } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 100 characters', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { type: 'OIDC', name: 'x'.repeat(101), protocolJson: OIDC_PROTOCOL, policyJson: POLICY } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a missing type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'No Type', protocolJson: OIDC_PROTOCOL, policyJson: POLICY } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects an unknown IdP type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'MAGIC', name: 'Bad Type', protocolJson: OIDC_PROTOCOL, policyJson: POLICY } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { type: 'OIDC', name: 'Bad Status', status: 'PAUSED', protocolJson: OIDC_PROTOCOL, policyJson: POLICY },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('rejects a missing protocol', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'OIDC', name: 'No Protocol', policyJson: POLICY } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('protocolJson'))).toBe(true)
  })

  it('rejects malformed protocol JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'OIDC', name: 'Bad JSON', protocolJson: '{not json', policyJson: POLICY } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_protocol')).toBe(true)
  })

  it('rejects a protocol that is a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'OIDC', name: 'Array Protocol', protocolJson: '[1,2,3]', policyJson: POLICY } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_protocol')).toBe(true)
  })

  it('rejects a protocol with no "type"', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { type: 'OIDC', name: 'No Proto Type', protocolJson: '{"scopes":["openid"]}', policyJson: POLICY } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_protocol_type')).toBe(true)
  })

  it('rejects a missing policy', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'OIDC', name: 'No Policy', protocolJson: OIDC_PROTOCOL } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('policyJson'))).toBe(true)
  })

  it('rejects malformed policy JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'OIDC', name: 'Bad Policy', protocolJson: OIDC_PROTOCOL, policyJson: '{nope' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policy')).toBe(true)
  })

  it('rejects a policy that is a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'OIDC', name: 'Array Policy', protocolJson: OIDC_PROTOCOL, policyJson: '[]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policy')).toBe(true)
  })

  it('rejects a duplicate IdP name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { type: 'OIDC', name: 'Corp', protocolJson: OIDC_PROTOCOL, policyJson: POLICY } },
        { name: 'sec2', fields: { type: 'SAML2', name: 'corp', protocolJson: SAML_PROTOCOL, policyJson: POLICY } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractIdpSpecs', () => {
  it('trims fields, upper-cases the type/status and drops blank blobs', () => {
    const specs = extractIdpSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: { type: '  oidc  ', name: '  Corp OIDC  ', status: ' inactive ', protocolJson: '   ', policyJson: '  ' },
        },
      ]),
    )
    expect(specs[0].type).toBe('OIDC')
    expect(specs[0].name).toBe('Corp OIDC')
    expect(specs[0].status).toBe('INACTIVE')
    expect(specs[0].protocolJson).toBeUndefined()
    expect(specs[0].policyJson).toBeUndefined()
  })

  it('defaults status to ACTIVE when unset', () => {
    const specs = extractIdpSpecs(makeCanvas([{ name: 'sec1', fields: { type: 'OIDC', name: 'Z' } }]))
    expect(specs[0].status).toBe('ACTIVE')
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

describe('checkProtocol', () => {
  it('passes a protocol with a type and fails one without', () => {
    expect(checkProtocol({ type: 'OIDC', scopes: ['openid'] })).toBeNull()
    expect(checkProtocol({ scopes: ['openid'] })).toMatch(/type/)
    expect(checkProtocol({ type: '   ' })).toMatch(/type/)
  })
})

describe('stripClientSecret', () => {
  it('removes credentials.client.client_secret and keeps everything else', () => {
    const protocol = {
      type: 'OIDC',
      scopes: ['openid'],
      credentials: { client: { client_id: 'abc', client_secret: 's3cr3t' } },
    }
    const stripped = stripClientSecret(protocol)
    expect(stripped).toEqual({
      type: 'OIDC',
      scopes: ['openid'],
      credentials: { client: { client_id: 'abc' } },
    })
    // The nested client_secret is gone...
    expect((stripped.credentials as { client: Record<string, unknown> }).client.client_secret).toBeUndefined()
    // ...and the original input is NOT mutated.
    expect(protocol.credentials.client.client_secret).toBe('s3cr3t')
  })

  it('is a no-op when there is no client secret', () => {
    expect(stripClientSecret({ type: 'SAML2', credentials: { trust: { issuer: 'x' } } })).toEqual({
      type: 'SAML2',
      credentials: { trust: { issuer: 'x' } },
    })
  })

  it('tolerates a null/undefined protocol', () => {
    expect(stripClientSecret(null)).toEqual({})
    expect(stripClientSecret(undefined)).toEqual({})
  })
})

describe('buildIdpBody', () => {
  it('assembles type/name/protocol/policy and lets the modeled fields win', () => {
    const protocol = { type: 'OIDC', scopes: ['openid'] }
    const policy = { provisioning: { action: 'AUTO' } }
    const body = buildIdpBody({ sectionName: 's', type: 'OIDC', name: 'Corp OIDC', status: 'ACTIVE' }, protocol, policy)
    expect(body).toEqual({
      type: 'OIDC',
      name: 'Corp OIDC',
      protocol: { type: 'OIDC', scopes: ['openid'] },
      policy: { provisioning: { action: 'AUTO' } },
    })
  })

  it('omits policy when none is supplied and never carries status', () => {
    const body = buildIdpBody({ sectionName: 's', type: 'SAML2', name: 'Corp SAML', status: 'INACTIVE' }, { type: 'SAML2' }, null)
    expect(body).toEqual({ type: 'SAML2', name: 'Corp SAML', protocol: { type: 'SAML2' } })
    expect(body.status).toBeUndefined()
    expect(body.policy).toBeUndefined()
  })
})

describe('stripReadOnlyIdpFields', () => {
  it('removes id/created/lastUpdated/system/_links/_embedded/status but keeps protocol/policy', () => {
    const stripped = stripReadOnlyIdpFields({
      id: '0oaabc',
      name: 'Corp OIDC',
      type: 'OIDC',
      status: 'ACTIVE',
      system: false,
      created: '2020-01-01T00:00:00Z',
      lastUpdated: '2020-01-02T00:00:00Z',
      _links: { self: {} },
      _embedded: {},
      protocol: { type: 'OIDC' },
      policy: { provisioning: { action: 'AUTO' } },
    })
    expect(stripped).toEqual({
      name: 'Corp OIDC',
      type: 'OIDC',
      protocol: { type: 'OIDC' },
      policy: { provisioning: { action: 'AUTO' } },
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped.status).toBeUndefined()
  })
})
