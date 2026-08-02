import validate from '../validate'
import { buildGroupPolicyBody, declaredGroupPolicyKeys, extractGroupPolicySpecs, groupPolicyKey, stripIdentityKeys } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-meraki',
    customerId: 'cust-1',
    configTypeId: 'group-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-meraki',
      entityType: 'group-policies',
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
  name: 'No streaming',
  policy: JSON.stringify({ bandwidth: { settings: 'custom', bandwidthLimits: { limitUp: 1000, limitDown: 1000 } } }),
}

describe('Cisco Meraki Group Policies Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed group policy', async () => {
    const result = await validate(makeCtx([{ name: 'Item', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts a blank policy blob (minimal named-only policy)', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, policy: '' } }]))
    expect(result.valid).toBe(true)
  })

  it('requires network_id and name', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { policy: '{}' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'REQUIRED')).toHaveLength(2)
  })

  it('rejects policy that is not valid JSON', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, policy: '{ not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_POLICY')).toBe(true)
  })

  it('rejects a policy array (must be an object)', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, policy: '[]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_POLICY')).toBe(true)
  })

  it('warns when the policy JSON embeds "name" or "groupPolicyId" (ignored)', async () => {
    const policy = JSON.stringify({ name: 'Ignored', groupPolicyId: '999' })
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, policy } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'IGNORED_POLICY_KEY')).toBe(true)
  })

  it('rejects an invalid bandwidth.settings enum value', async () => {
    const policy = JSON.stringify({ bandwidth: { settings: 'sometimes' } })
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, policy } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_SETTINGS_ENUM')).toBe(true)
  })

  it('rejects an invalid splashAuthSettings enum value', async () => {
    const policy = JSON.stringify({ splashAuthSettings: 'sometimes' })
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, policy } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_SETTINGS_ENUM')).toBe(true)
  })

  it('accepts a valid nested contentFiltering.blockedUrlCategories.settings enum', async () => {
    const policy = JSON.stringify({ contentFiltering: { blockedUrlCategories: { settings: 'override', categories: [] } } })
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, policy } }]))
    expect(result.valid).toBe(true)
  })

  it('warns on a duplicate name within the same network (last one wins)', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: { ...validFields } }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_NAME')).toBe(true)
  })

  it('does NOT flag the same name across different networks', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: { ...validFields, network_id: 'N_other' } }]),
    )
    expect(result.warnings.filter((w) => w.code === 'DUPLICATE_NAME')).toHaveLength(0)
  })
})

describe('Cisco Meraki Group Policies shared helpers', () => {
  it('groupPolicyKey trims and lower-cases', () => {
    expect(groupPolicyKey('  No Streaming ')).toBe('no streaming')
  })

  it('stripIdentityKeys removes name and groupPolicyId only', () => {
    const stripped = stripIdentityKeys({ name: 'x', groupPolicyId: '1', bandwidth: { settings: 'ignore' } })
    expect(stripped).toEqual({ bandwidth: { settings: 'ignore' } })
  })

  it('buildGroupPolicyBody spreads policy under the canonical name and strips identity keys', () => {
    const body = buildGroupPolicyBody('No streaming', { name: 'ignored', groupPolicyId: '999', splashAuthSettings: 'bypass' })
    expect(body).toEqual({ name: 'No streaming', splashAuthSettings: 'bypass' })
  })

  it('declaredGroupPolicyKeys includes name plus every non-identity policy key', () => {
    expect(declaredGroupPolicyKeys({ bandwidth: {}, splashAuthSettings: 'bypass' })).toEqual(['name', 'bandwidth', 'splashAuthSettings'])
  })

  it('extractGroupPolicySpecs reads and trims every field', () => {
    const specs = extractGroupPolicySpecs(
      makeCtx([{ name: 'e', fields: { network_id: '  L_999  ', name: '  No streaming  ', policy: '{}' } }]).canvas,
    )
    expect(specs[0].networkId).toBe('L_999')
    expect(specs[0].name).toBe('No streaming')
  })
})
