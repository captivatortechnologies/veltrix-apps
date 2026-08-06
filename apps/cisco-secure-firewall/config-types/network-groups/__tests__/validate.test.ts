import validate, { extractNetworkGroupSpecs, buildNetworkGroupBaseFields } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-secure-firewall',
    customerId: 'cust-1',
    configTypeId: 'network-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-secure-firewall',
      entityType: 'network-groups',
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
    toolType: 'cisco-secure-firewall',
    entityType: 'network-groups',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Network Groups validate handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a group with members', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'corp-hosts', member_names: ['web-1', 'web-2'] } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a group with no members', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'empty-group' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('member_names'))).toBe(true)
  })

  it('rejects a duplicate group name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'corp-hosts', member_names: ['web-1'] } },
        { name: 'sec2', fields: { name: 'corp-hosts', member_names: ['web-2'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })
})

describe('extractNetworkGroupSpecs / buildNetworkGroupBaseFields', () => {
  it('splits member_names and builds base fields', () => {
    const specs = extractNetworkGroupSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'corp-hosts', member_names: ['web-1', 'web-2'], description: 'Corp hosts' } }]))
    expect(specs[0].memberNames).toEqual(['web-1', 'web-2'])
    expect(buildNetworkGroupBaseFields(specs[0])).toEqual({ overridable: false, description: 'Corp hosts' })
  })
})
