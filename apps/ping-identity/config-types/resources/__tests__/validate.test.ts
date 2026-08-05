import validate from '../validate'
import {
  buildResourceBody,
  buildScopeBody,
  extractResourceSpec,
  findResourceByName,
  isCustomResource,
  parseScopesJson,
  resolvedAudience,
  resourceKey,
  resourceToBody,
  scopeKey,
  scopeToBody,
  type LiveResource,
} from '../_shared'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function toItems(list: Array<Record<string, unknown>>): CanvasItemSnapshot[] {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  const items = toItems(list)
  return {
    appId: 'ping-identity',
    customerId: 'cust-1',
    configTypeId: 'resources',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'ping-identity',
      entityType: 'resources',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const goodScope = { name: 'read:orders', description: 'Read order data' }
const good = {
  name: 'Orders API',
  description: 'Orders resource',
  audience: 'https://api.example.com/orders',
  accessTokenValiditySeconds: 3600,
  applicationPermissionsClaimEnabled: false,
  introspectEndpointAuthMethod: 'CLIENT_SECRET_BASIC',
  scopesJson: JSON.stringify([goodScope]),
}

describe('PingOne Resources Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const res = await validate(ctxOf([]))
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.code === 'EMPTY')).toBeTruthy()
  })

  it('accepts a well-formed resource with a scope', async () => {
    const res = await validate(ctxOf([good]))
    expect(res.valid).toBe(true)
  })

  it('accepts a resource with a blank scopesJson', async () => {
    const res = await validate(ctxOf([{ ...good, scopesJson: '' }]))
    expect(res.valid).toBe(true)
  })

  it('accepts a resource with an explicit empty scopes array', async () => {
    const res = await validate(ctxOf([{ ...good, scopesJson: '[]' }]))
    expect(res.valid).toBe(true)
  })

  it('accepts a resource with no audience set', async () => {
    const res = await validate(ctxOf([{ ...good, audience: '' }]))
    expect(res.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const res = await validate(ctxOf([{ ...good, name: '' }]))
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.code === 'EMPTY_NAME')).toBeTruthy()
  })

  it('rejects a name longer than 100 characters', async () => {
    const res = await validate(ctxOf([{ ...good, name: 'x'.repeat(101) }]))
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.code === 'NAME_TOO_LONG')).toBeTruthy()
  })

  it('rejects an audience containing "pingone" (case-insensitive)', async () => {
    const res = await validate(ctxOf([{ ...good, audience: 'https://PingOne.example.com/api' }]))
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.code === 'RESERVED_AUDIENCE')).toBeTruthy()
  })

  it('rejects an audience containing "pingidentity"', async () => {
    const res = await validate(ctxOf([{ ...good, audience: 'https://api.pingidentity.com/orders' }]))
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.code === 'RESERVED_AUDIENCE')).toBeTruthy()
  })

  it('rejects an out-of-range accessTokenValiditySeconds', async () => {
    const tooLow = await validate(ctxOf([{ ...good, accessTokenValiditySeconds: 100 }]))
    expect(tooLow.valid).toBe(false)
    expect(tooLow.errors.some((e) => e.code === 'INVALID_TOKEN_VALIDITY')).toBeTruthy()

    const tooHigh = await validate(ctxOf([{ ...good, accessTokenValiditySeconds: 9_999_999 }]))
    expect(tooHigh.valid).toBe(false)
    expect(tooHigh.errors.some((e) => e.code === 'INVALID_TOKEN_VALIDITY')).toBeTruthy()

    const nonInteger = await validate(ctxOf([{ ...good, accessTokenValiditySeconds: 3600.5 }]))
    expect(nonInteger.valid).toBe(false)
    expect(nonInteger.errors.some((e) => e.code === 'INVALID_TOKEN_VALIDITY')).toBeTruthy()
  })

  it('rejects an unsupported introspectEndpointAuthMethod', async () => {
    const res = await validate(ctxOf([{ ...good, introspectEndpointAuthMethod: 'BOGUS' }]))
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.code === 'INVALID_INTROSPECT_AUTH_METHOD')).toBeTruthy()
  })

  it('rejects malformed scopes JSON', async () => {
    const res = await validate(ctxOf([{ ...good, scopesJson: '{not json' }]))
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.code === 'INVALID_SCOPES_JSON')).toBeTruthy()
  })

  it('rejects scopes JSON that is an object instead of an array', async () => {
    const res = await validate(ctxOf([{ ...good, scopesJson: '{"name":"x"}' }]))
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.code === 'INVALID_SCOPES_JSON')).toBeTruthy()
  })

  it('rejects a scope with no name', async () => {
    const res = await validate(ctxOf([{ ...good, scopesJson: JSON.stringify([{ description: 'no name' }]) }]))
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.code === 'EMPTY_SCOPE_NAME')).toBeTruthy()
  })

  it('rejects a duplicate scope name within a resource', async () => {
    const res = await validate(
      ctxOf([{ ...good, scopesJson: JSON.stringify([goodScope, { ...goodScope, description: 'different' }]) }]),
    )
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.code === 'DUPLICATE_SCOPE_NAME')).toBeTruthy()
  })

  it('rejects a duplicate resource name (case-insensitive)', async () => {
    const res = await validate(ctxOf([good, { ...good, name: good.name.toUpperCase() }]))
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.code === 'DUPLICATE_RESOURCE_NAME')).toBeTruthy()
  })
})

describe('extractResourceSpec', () => {
  it('trims fields and defaults introspectEndpointAuthMethod', () => {
    const spec = extractResourceSpec({ name: '  Orders API  ', description: '  desc  ' })
    expect(spec.name).toBe('Orders API')
    expect(spec.description).toBe('desc')
    expect(spec.introspectEndpointAuthMethod).toBe('CLIENT_SECRET_BASIC')
    expect(spec.applicationPermissionsClaimEnabled).toBe(false)
  })
})

describe('resourceKey / scopeKey', () => {
  it('normalize case and whitespace', () => {
    expect(resourceKey('  Orders API  ')).toBe('orders api')
    expect(scopeKey('  Read:Orders  ')).toBe('read:orders')
  })
})

describe('findResourceByName', () => {
  it('matches case-insensitively and returns null when absent', () => {
    const resources: LiveResource[] = [{ id: 'r1', name: 'Orders API', type: 'CUSTOM' }]
    expect(findResourceByName(resources, 'orders api')?.id).toBe('r1')
    expect(findResourceByName(resources, 'missing')).toBeNull()
  })
})

describe('isCustomResource', () => {
  it('treats a resource with no type as manageable, CUSTOM as manageable, anything else as protected', () => {
    expect(isCustomResource(undefined)).toBe(true)
    expect(isCustomResource({ type: 'CUSTOM' })).toBe(true)
    expect(isCustomResource({ type: 'OPENID_CONNECT' })).toBe(false)
    expect(isCustomResource({ type: 'PINGONE_API' })).toBe(false)
  })
})

describe('resolvedAudience', () => {
  it('falls back to the resource name when audience is blank', () => {
    expect(resolvedAudience({ name: 'Orders API', audience: '' })).toBe('Orders API')
    expect(resolvedAudience({ name: 'Orders API', audience: 'https://api.example.com' })).toBe('https://api.example.com')
  })
})

describe('buildResourceBody', () => {
  it('assembles the resource body and never includes `type`', () => {
    const spec = extractResourceSpec(good)
    const body = buildResourceBody(spec)
    expect(body.name).toBe(good.name)
    expect(body.audience).toBe(good.audience)
    expect(body.accessTokenValiditySeconds).toBe(3600)
    expect(body.applicationPermissionsSettings).toEqual({ claimEnabled: false })
    expect(body.introspectEndpointAuthMethod).toBe('CLIENT_SECRET_BASIC')
    expect('type' in body).toBe(false)
  })

  it('defaults accessTokenValiditySeconds when unset', () => {
    const spec = extractResourceSpec({ name: 'X' })
    const body = buildResourceBody(spec)
    expect(body.accessTokenValiditySeconds).toBe(3600)
    expect(body.audience).toBe('X')
  })
})

describe('buildScopeBody', () => {
  it('extracts name and description from a raw JSON scope entry', () => {
    const body = buildScopeBody(goodScope)
    expect(body.name).toBe('read:orders')
    expect(body.description).toBe('Read order data')
  })

  it('defaults description to an empty string when unset', () => {
    const body = buildScopeBody({ name: 'x' })
    expect(body.description).toBe('')
  })
})

describe('resourceToBody / scopeToBody', () => {
  it('rebuild bodies from captured live state, never including `type`', () => {
    const resourceBody = resourceToBody({ name: 'Orders API', type: 'CUSTOM' })
    expect(resourceBody.name).toBe('Orders API')
    expect(resourceBody.audience).toBe('Orders API')
    expect(resourceBody.accessTokenValiditySeconds).toBe(3600)
    expect('type' in resourceBody).toBe(false)

    const scopeBody = scopeToBody({ id: 's1', name: 'read:orders', description: 'Read order data' })
    expect(scopeBody.name).toBe('read:orders')
    expect(scopeBody.description).toBe('Read order data')
  })
})

describe('parseScopesJson', () => {
  it('treats a blank string as an empty, valid array', () => {
    const res = parseScopesJson('')
    expect(res.ok).toBe(true)
    expect(res.value).toEqual([])
  })

  it('parses a valid JSON array', () => {
    const res = parseScopesJson(JSON.stringify([goodScope]))
    expect(res.ok).toBe(true)
    expect(res.value).toEqual([goodScope])
  })

  it('rejects malformed JSON', () => {
    const res = parseScopesJson('{not json')
    expect(res.ok).toBe(false)
  })

  it('rejects a JSON object that is not an array', () => {
    const res = parseScopesJson('{"name":"x"}')
    expect(res.ok).toBe(false)
  })
})
