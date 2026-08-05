import validate from '../validate'
import {
  buildEndpointGroupCreateBody,
  endpointGroupDetailsMatch,
  endpointGroupKey,
  endpointGroupMembershipMatches,
  extractEndpointGroupSpecs,
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
    configTypeId: 'endpoint-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sophos-central',
      entityType: 'endpoint-groups',
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

const validUuid1 = 'e6a03d34-a943-45b7-8de3-deaf38864be4'
const validUuid2 = 'b7e5f3aa-a7c6-43c6-a65e-3cd52008464b'
const validFields = { name: 'Seattle computers', description: 'User devices in Seattle', type: 'computer', endpointIds: [validUuid1, validUuid2] }

describe('Sophos Central Endpoint Groups Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed group', async () => {
    const result = await validate(makeCtx([{ name: 'Item', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts a group with no members', async () => {
    const result = await validate(makeCtx([{ name: 'Item', fields: { ...validFields, endpointIds: [] } }]))
    expect(result.valid).toBe(true)
  })

  it('requires name and type', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'REQUIRED')).toHaveLength(2)
  })

  it('rejects a name containing a forbidden character', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, name: 'Bad,Name' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_NAME')).toBe(true)
  })

  it('rejects an unknown type', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, type: 'bogus' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_TYPE')).toBe(true)
  })

  it('warns on an endpoint id that does not look like a UUID', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, endpointIds: ['not-a-uuid'] } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'UNUSUAL_ENDPOINT_ID')).toBe(true)
  })

  it('warns on a duplicate name', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: validFields }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_NAME')).toBe(true)
  })
})

describe('Sophos Central Endpoint Groups shared helpers', () => {
  it('endpointGroupKey trims and lower-cases', () => {
    expect(endpointGroupKey('  Seattle Computers  ')).toBe('seattle computers')
  })

  it('extractEndpointGroupSpecs reads and splits endpointIds', () => {
    const specs = extractEndpointGroupSpecs(
      makeCtx([{ name: 'e', fields: { name: ' Group ', description: '', type: 'computer', endpointIds: `${validUuid1},${validUuid2}` } }])
        .canvas,
    )
    expect(specs[0].name).toBe('Group')
    expect(specs[0].endpointIds).toEqual([validUuid1, validUuid2])
  })

  it('buildEndpointGroupCreateBody omits blank description/empty endpointIds', () => {
    expect(buildEndpointGroupCreateBody({ itemName: 'x', name: 'G', description: '', type: 'computer', endpointIds: [] })).toEqual({
      name: 'G',
      type: 'computer',
    })
  })

  it('endpointGroupDetailsMatch compares name and description', () => {
    const spec = { itemName: 'x', name: 'G', description: 'd', type: 'computer', endpointIds: [] }
    expect(endpointGroupDetailsMatch(spec, { name: 'G', description: 'd', type: 'computer' })).toBe(true)
    expect(endpointGroupDetailsMatch(spec, { name: 'G', description: 'other', type: 'computer' })).toBe(false)
  })

  it('endpointGroupMembershipMatches is order-insensitive', () => {
    const spec = { itemName: 'x', name: 'G', description: '', type: 'computer', endpointIds: [validUuid2, validUuid1] }
    expect(endpointGroupMembershipMatches(spec, [validUuid1, validUuid2])).toBe(true)
    expect(endpointGroupMembershipMatches(spec, [validUuid1])).toBe(false)
  })
})
