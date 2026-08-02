import validate from '../validate'
import { extractGroupSpecs, groupKey, isExternallyManaged, readBool, strList, resourceIdsFromGroup, idSetSignature } from '../_shared'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCanvas(items: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'twingate',
    entityType: 'groups',
    items,
    sections: items,
    snapshot: {},
  }
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'twingate',
    customerId: 'cust-1',
    configTypeId: 'groups',
    canvas: makeCanvas(items),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('Twingate Groups validate handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal valid group', async () => {
    const result = await validate(makeCtx([{ name: 'item1', fields: { name: 'Engineering' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a name', async () => {
    const result = await validate(makeCtx([{ name: 'item1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects duplicate group names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Engineering' } },
        { name: 'b', fields: { name: 'engineering' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_group')).toBe(true)
  })

  it('extractGroupSpecs defaults, trims and reads lists', () => {
    const specs = extractGroupSpecs(
      makeCanvas([{ name: 'item1', fields: { name: '  Engineering  ', resource_names: 'App A, App B', is_active: false } }]),
    )
    expect(specs[0].name).toBe('Engineering')
    expect(specs[0].isActive).toBe(false)
    expect(specs[0].resourceNames).toEqual(['App A', 'App B'])
    expect(groupKey('  Engineering ')).toBe('engineering')
  })
})

describe('Twingate Groups shared helpers', () => {
  it('readBool and strList behave as documented', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(strList(['a', ' b '])).toEqual(['a', 'b'])
    expect(strList('a,b, ')).toEqual(['a', 'b'])
  })

  it('isExternallyManaged is true only for SYNCED/SYSTEM', () => {
    expect(isExternallyManaged('MANUAL')).toBe(false)
    expect(isExternallyManaged('SYNCED')).toBe(true)
    expect(isExternallyManaged('SYSTEM')).toBe(true)
    expect(isExternallyManaged(undefined)).toBe(false)
  })

  it('resourceIdsFromGroup extracts ids from the resources connection', () => {
    const ids = resourceIdsFromGroup({
      resources: { edges: [{ node: { id: 'r1', name: 'App A' } }, { node: { id: 'r2', name: 'App B' } }, null] },
    })
    expect(ids).toEqual(['r1', 'r2'])
  })

  it('idSetSignature is order- and case-insensitive and de-duplicates', () => {
    expect(idSetSignature(['b', 'a', 'B'])).toBe(idSetSignature(['A', 'b']))
  })
})
