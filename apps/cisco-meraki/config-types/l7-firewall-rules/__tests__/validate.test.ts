import validate from '../validate'
import { extractL7FirewallRuleSpecs, normalizeL7Rule, parseL7Rules } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-meraki',
    customerId: 'cust-1',
    configTypeId: 'l7-firewall-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-meraki',
      entityType: 'l7-firewall-rules',
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

const validFields = {
  network_id: 'L_646829496481099008',
  rules: JSON.stringify([{ policy: 'deny', type: 'host', value: 'example.com' }]),
}

describe('Cisco Meraki L7 Firewall Rules Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed ruleset', async () => {
    const result = await validate(makeCtx([{ name: 'Item', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a network_id', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { rules: '[]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'REQUIRED')).toBe(true)
  })

  it('rejects a policy other than "deny"', async () => {
    const rules = JSON.stringify([{ policy: 'allow', type: 'host', value: 'example.com' }])
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_POLICY')).toBe(true)
  })

  it('rejects an unsupported type', async () => {
    const rules = JSON.stringify([{ policy: 'deny', type: 'mac', value: '00:11:22:33:44:55' }])
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_TYPE')).toBe(true)
  })

  it('requires a non-empty string value for host/port/ipRange', async () => {
    const rules = JSON.stringify([{ policy: 'deny', type: 'port', value: '' }])
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_VALUE')).toBe(true)
  })

  it('requires a non-empty country-code array for allowedCountries/blockedCountries', async () => {
    const bad = JSON.stringify([{ policy: 'deny', type: 'blockedCountries', value: 'US' }])
    const empty = JSON.stringify([{ policy: 'deny', type: 'blockedCountries', value: [] }])
    const good = JSON.stringify([{ policy: 'deny', type: 'blockedCountries', value: ['US', 'CA'] }])

    expect((await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules: bad } }]))).valid).toBe(false)
    expect((await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules: empty } }]))).valid).toBe(false)
    expect((await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules: good } }]))).valid).toBe(true)
  })

  it('accepts an application-category object value but warns the shape is unverified', async () => {
    const rules = JSON.stringify([{ policy: 'deny', type: 'applicationCategory', value: { id: 'meraki:layer7/category/1' } }])
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'UNVERIFIED_VALUE_SHAPE')).toBe(true)
  })

  it('rejects a non-object value for application/applicationCategory', async () => {
    const rules = JSON.stringify([{ policy: 'deny', type: 'application', value: 'not-an-object' }])
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_VALUE')).toBe(true)
  })

  it('warns on an empty ruleset', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, rules: '[]' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'EMPTY_RULES')).toBe(true)
  })

  it('warns on a duplicate network_id across items', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: { ...validFields } }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_NETWORK_ID')).toBe(true)
  })
})

describe('Cisco Meraki L7 Firewall Rules shared helpers', () => {
  it('parseL7Rules accepts a bare array and a wrapped object', () => {
    expect(parseL7Rules(JSON.stringify([{ policy: 'deny', type: 'host', value: 'x.com' }])).rules).toHaveLength(1)
    expect(parseL7Rules(JSON.stringify({ rules: [{ policy: 'deny', type: 'host', value: 'x.com' }] })).rules).toHaveLength(1)
  })

  it('parseL7Rules rejects invalid JSON and missing rules', () => {
    expect(parseL7Rules('nope').error).toBeTruthy()
    expect(parseL7Rules('{ "foo": 1 }').error).toBeTruthy()
    expect(parseL7Rules('   ').error).toBeTruthy()
  })

  it('normalizeL7Rule lower-cases policy but preserves type case and value as-is', () => {
    const normalized = normalizeL7Rule({ policy: 'DENY', type: 'applicationCategory', value: { id: 'x' } })
    expect(normalized.policy).toBe('deny')
    expect(normalized.type).toBe('applicationCategory')
    expect(normalized.value).toEqual({ id: 'x' })
  })

  it('extractL7FirewallRuleSpecs reads and trims every field', () => {
    const specs = extractL7FirewallRuleSpecs(
      makeCtx([{ name: 'e', fields: { network_id: '  L_999  ', comment: '  note  ', rules: '[]' } }]).canvas,
    )
    expect(specs[0].networkId).toBe('L_999')
    expect(specs[0].comment).toBe('note')
  })
})
