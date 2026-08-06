import validate from '../validate'
import { extractNetworkGroupSpecs, networkGroupKey, findLiveGroup, liveGroupId } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'bitdefender-gravityzone',
    customerId: 'cust-1',
    configTypeId: 'network-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'bitdefender-gravityzone',
      entityType: 'network-groups',
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

describe('GravityZone Network Groups Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed group', async () => {
    const result = await validate(makeCtx([{ name: 'g1', fields: { groupName: 'Finance', parentId: '' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires groupName', async () => {
    const result = await validate(makeCtx([{ name: 'g1', fields: { parentId: '123' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'REQUIRED')).toBe(true)
  })

  it('warns on a duplicate (groupName, parentId) pair', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { groupName: 'Finance', parentId: '123' } },
        { name: 'b', fields: { groupName: 'Finance', parentId: '123' } },
      ]),
    )
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_GROUP')).toBe(true)
  })

  it('does not warn when the same name is declared under different parents', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { groupName: 'Finance', parentId: '123' } },
        { name: 'b', fields: { groupName: 'Finance', parentId: '456' } },
      ]),
    )
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_GROUP')).toBe(false)
  })
})

describe('GravityZone Network Groups shared helpers', () => {
  it('networkGroupKey trims and lower-cases', () => {
    expect(networkGroupKey('  Finance  ')).toBe('finance')
  })

  it('extractNetworkGroupSpecs reads and trims every field', () => {
    const specs = extractNetworkGroupSpecs(
      makeCtx([{ name: 'g', fields: { groupName: '  Finance  ', parentId: ' 123 ', force: true } }]).canvas,
    )
    expect(specs[0].groupName).toBe('Finance')
    expect(specs[0].parentId).toBe('123')
    expect(specs[0].force).toBe(true)
  })

  it('findLiveGroup matches by name case-insensitively', () => {
    const live = [{ id: 'g-1', name: 'Finance' }, { id: 'g-2', name: 'Legal' }]
    expect(findLiveGroup(live, 'finance')?.id).toBe('g-1')
    expect(findLiveGroup(live, 'missing')).toBeUndefined()
  })

  it('liveGroupId reads id or groupId defensively', () => {
    expect(liveGroupId({ id: 'g-1' })).toBe('g-1')
    expect(liveGroupId({ groupId: 'g-2' })).toBe('g-2')
    expect(liveGroupId({})).toBe('')
  })
})
