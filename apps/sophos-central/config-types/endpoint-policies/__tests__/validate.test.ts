import validate from '../validate'
import {
  buildPolicyCreateBody,
  buildPolicyPatchBody,
  extractPolicySpecs,
  parsePolicySpec,
  policyKey,
  policyMatches,
} from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'sophos-central',
    customerId: 'cust-1',
    configTypeId: 'endpoint-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sophos-central',
      entityType: 'endpoint-policies',
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
  name: 'Default Threat Protection',
  type: 'threat-protection',
  enabled: true,
  disableAt: '',
  appliesTo: '{}',
  settings: JSON.stringify({ 'endpoint.threat-protection.tamper-protection.enabled': { value: true } }),
}

describe('Sophos Central Endpoint Policies Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed policy', async () => {
    const result = await validate(makeCtx([{ name: 'Item', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires name and type', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'REQUIRED')).toHaveLength(2)
  })

  it('rejects an unknown policy type', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, type: 'data-loss-prevention' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_TYPE')).toBe(true)
  })

  it('accepts every documented server-* policy type', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, type: 'server-linux-runtime-detection' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a malformed disableAt timestamp', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, disableAt: 'not-a-date' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_DISABLE_AT')).toBe(true)
  })

  it('accepts a well-formed disableAt timestamp', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, disableAt: '2026-12-31T00:00:00Z' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects settings that is not valid JSON', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, settings: '{ not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })

  it('rejects an appliesTo array (must be an object)', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, appliesTo: '[]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })

  it('warns on an undocumented appliesTo key', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, appliesTo: JSON.stringify({ groups: ['x'] }) } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'UNKNOWN_APPLIES_TO_KEY')).toBe(true)
  })

  it('accepts the documented appliesTo keys without warning', async () => {
    const result = await validate(
      makeCtx([{ name: 'i1', fields: { ...validFields, appliesTo: JSON.stringify({ endpoints: ['a'], users: ['b'], userGroups: ['c'] }) } }]),
    )
    expect(result.warnings.filter((w) => w.code === 'UNKNOWN_APPLIES_TO_KEY')).toHaveLength(0)
  })

  it('warns on a duplicate (name, type) pair', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: validFields }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_POLICY')).toBe(true)
  })

  it('does NOT flag the same name across different types', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: validFields },
        { name: 'b', fields: { ...validFields, type: 'server-threat-protection' } },
      ]),
    )
    expect(result.warnings.filter((w) => w.code === 'DUPLICATE_POLICY')).toHaveLength(0)
  })
})

describe('Sophos Central Endpoint Policies shared helpers', () => {
  it('policyKey combines name and type', () => {
    expect(policyKey('  Default Policy  ', 'threat-protection')).toBe('default policy::threat-protection')
  })

  it('extractPolicySpecs reads and coerces every field', () => {
    const specs = extractPolicySpecs(
      makeCtx([{ name: 'e', fields: { name: ' P ', type: 'threat-protection', enabled: false, priority: '5', disableAt: '', appliesTo: '{}', settings: '{}' } }])
        .canvas,
    )
    expect(specs[0].name).toBe('P')
    expect(specs[0].enabled).toBe(false)
    expect(specs[0].priority).toBe(5)
  })

  it('parsePolicySpec defaults blank JSON blobs to {}', () => {
    const { value } = parsePolicySpec({
      itemName: 'x',
      name: 'P',
      type: 'threat-protection',
      enabled: true,
      disableAt: '',
      appliesToRaw: '',
      settingsRaw: '',
    })
    expect(value?.appliesTo).toEqual({})
    expect(value?.settings).toEqual({})
  })

  it('buildPolicyCreateBody omits empty appliesTo/settings and unset priority/disableAt', () => {
    const { value } = parsePolicySpec({
      itemName: 'x',
      name: 'P',
      type: 'threat-protection',
      enabled: true,
      disableAt: '',
      appliesToRaw: '',
      settingsRaw: '',
    })
    expect(buildPolicyCreateBody(value!)).toEqual({ name: 'P', type: 'threat-protection', enabled: true })
  })

  it('buildPolicyPatchBody never includes type', () => {
    const { value } = parsePolicySpec({
      itemName: 'x',
      name: 'P',
      type: 'threat-protection',
      enabled: true,
      disableAt: '',
      appliesToRaw: '{}',
      settingsRaw: '{}',
    })
    const body = buildPolicyPatchBody(value!)
    expect('type' in body).toBe(false)
    expect(body.name).toBe('P')
  })

  it('policyMatches compares every declared field', () => {
    const { value } = parsePolicySpec({
      itemName: 'x',
      name: 'P',
      type: 'threat-protection',
      enabled: true,
      disableAt: '',
      appliesToRaw: '{}',
      settingsRaw: JSON.stringify({ a: { value: true } }),
    })
    expect(policyMatches(value!, { name: 'P', type: 'threat-protection', enabled: true, appliesTo: {}, settings: { a: { value: true } } })).toBe(
      true,
    )
    expect(policyMatches(value!, { name: 'P', type: 'threat-protection', enabled: false, appliesTo: {}, settings: { a: { value: true } } })).toBe(
      false,
    )
  })
})
