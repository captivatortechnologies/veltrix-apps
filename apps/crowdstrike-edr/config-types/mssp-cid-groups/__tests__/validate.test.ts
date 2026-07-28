import validate, {
  extractCidGroupSpecs,
  isValidCid,
  normalizeCids,
} from '../validate'
import { partitionMembers } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const CID_A = 'abcdef0123456789abcdef0123456789'
const CID_B = '0011223344556677889900aabbccddee'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'mssp-cid-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'mssp-cid-groups',
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
    entityType: 'mssp-cid-groups',
    items: [],
    sections,
    snapshot: {},
  }
}

function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'East Region Tenants',
    description: 'Child CIDs in the east region',
    cids: `${CID_A}, ${CID_B}`,
    ...overrides,
  }
}

describe('CrowdStrike MSSP CID Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid CID group configuration', async () => {
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

  it('rejects a malformed member CID', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ cids: 'not-a-cid' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_cid')).toBe(true)
  })

  it('accepts a group with no member CIDs', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ cids: '' }) }]))
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

describe('extractCidGroupSpecs', () => {
  it('parses name, description, and normalized member CIDs', () => {
    const specs = extractCidGroupSpecs(
      makeCanvas([{ name: 'sec1', fields: validFields({ cids: `${CID_A.toUpperCase()}, ${CID_A}, ${CID_B}` }) }]),
    )
    expect(specs).toHaveLength(1)
    expect(specs[0].name).toBe('East Region Tenants')
    expect(specs[0].description).toBe('Child CIDs in the east region')
    // uppercase duplicate collapses with its lowercase twin
    expect(specs[0].cids).toEqual([CID_A, CID_B])
  })

  it('leaves description undefined when blank', () => {
    const specs = extractCidGroupSpecs(
      makeCanvas([{ name: 'sec1', fields: validFields({ description: '   ' }) }]),
    )
    expect(specs[0].description).toBeUndefined()
  })
})

describe('normalizeCids / isValidCid', () => {
  it('lowercases and de-duplicates', () => {
    expect(normalizeCids([CID_A.toUpperCase(), CID_A, CID_B])).toEqual([CID_A, CID_B])
  })

  it('accepts a 32-hex CID and rejects other shapes', () => {
    expect(isValidCid(CID_A)).toBe(true)
    expect(isValidCid('xyz')).toBe(false)
    expect(isValidCid(`${CID_A}00`)).toBe(false)
  })
})

describe('partitionMembers', () => {
  it('splits declared vs live into adds and removes', () => {
    const { toAdd, toRemove } = partitionMembers([CID_A, CID_B], [CID_A, 'cccccccccccccccccccccccccccccccc'])
    expect(toAdd).toEqual([CID_B])
    expect(toRemove).toEqual(['cccccccccccccccccccccccccccccccc'])
  })

  it('produces no changes when declared equals live', () => {
    const { toAdd, toRemove } = partitionMembers([CID_A], [CID_A])
    expect(toAdd).toHaveLength(0)
    expect(toRemove).toHaveLength(0)
  })
})
