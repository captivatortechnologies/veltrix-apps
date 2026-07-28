import validate, {
  extractUserGroupSpecs,
  isValidUuid,
  normalizeUuids,
} from '../validate'
import { partitionMembers } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const UUID_A = '11111111-2222-3333-4444-555555555555'
const UUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'mssp-user-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'mssp-user-groups',
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
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'crowdstrike-edr',
    entityType: 'mssp-user-groups',
    items: [],
    sections,
    snapshot: {},
  }
}

function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'SOC Analysts',
    description: 'Tier 1 analyst accounts',
    userUuids: `${UUID_A}, ${UUID_B}`,
    ...overrides,
  }
}

describe('CrowdStrike MSSP User Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid user group configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Group', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing group name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ name: 'a'.repeat(256) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'too_long')).toBe(true)
  })

  it('rejects a malformed member UUID', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ userUuids: 'not-a-uuid' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_uuid')).toBe(true)
  })

  it('accepts a group with no members', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ userUuids: '' }) }]))
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate group names per canvas', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractUserGroupSpecs', () => {
  it('parses name, description, and normalized member UUIDs', () => {
    const specs = extractUserGroupSpecs(
      makeCanvas([{ name: 'sec1', fields: validFields({ userUuids: `${UUID_A.toUpperCase()}, ${UUID_A}, ${UUID_B}` }) }]),
    )
    expect(specs).toHaveLength(1)
    expect(specs[0].name).toBe('SOC Analysts')
    expect(specs[0].description).toBe('Tier 1 analyst accounts')
    expect(specs[0].userUuids).toEqual([UUID_A, UUID_B])
  })

  it('leaves description undefined when blank', () => {
    const specs = extractUserGroupSpecs(
      makeCanvas([{ name: 'sec1', fields: validFields({ description: '   ' }) }]),
    )
    expect(specs[0].description).toBeUndefined()
  })
})

describe('normalizeUuids / isValidUuid', () => {
  it('lowercases and de-duplicates', () => {
    expect(normalizeUuids([UUID_A.toUpperCase(), UUID_A, UUID_B])).toEqual([UUID_A, UUID_B])
  })

  it('accepts a canonical UUID and rejects other shapes', () => {
    expect(isValidUuid(UUID_A)).toBe(true)
    expect(isValidUuid('1234')).toBe(false)
    expect(isValidUuid('gggggggg-2222-3333-4444-555555555555')).toBe(false)
  })
})

describe('partitionMembers', () => {
  it('splits declared vs live into adds and removes', () => {
    const { toAdd, toRemove } = partitionMembers([UUID_A, UUID_B], [UUID_A])
    expect(toAdd).toEqual([UUID_B])
    expect(toRemove).toHaveLength(0)
  })

  it('flags a live member not declared for removal', () => {
    const { toAdd, toRemove } = partitionMembers([UUID_A], [UUID_A, UUID_B])
    expect(toAdd).toHaveLength(0)
    expect(toRemove).toEqual([UUID_B])
  })
})
