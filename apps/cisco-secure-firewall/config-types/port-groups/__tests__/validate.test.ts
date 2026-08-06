import validate, { extractPortGroupSpecs, buildPortGroupBaseFields } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-secure-firewall',
    customerId: 'cust-1',
    configTypeId: 'port-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-secure-firewall',
      entityType: 'port-groups',
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
    entityType: 'port-groups',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Port Groups validate handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a group with members', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'web-ports', member_names: ['http', 'https'] } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a group with no members', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'empty-group' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a duplicate group name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'web-ports', member_names: ['http'] } },
        { name: 'sec2', fields: { name: 'web-ports', member_names: ['https'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })
})

describe('extractPortGroupSpecs / buildPortGroupBaseFields', () => {
  it('splits member_names and builds base fields', () => {
    const specs = extractPortGroupSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'web-ports', member_names: ['http', 'https'] } }]))
    expect(specs[0].memberNames).toEqual(['http', 'https'])
    expect(buildPortGroupBaseFields(specs[0])).toEqual({ overridable: false })
  })
})
