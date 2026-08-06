import validate, { extractUrlGroupSpecs, buildUrlGroupBaseFields } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-secure-firewall',
    customerId: 'cust-1',
    configTypeId: 'url-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-secure-firewall',
      entityType: 'url-groups',
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
    entityType: 'url-groups',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('URL Groups validate handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a group with only object members', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'allowed-urls', url_object_names: ['app-portal'] } }]))
    expect(result.valid).toBe(true)
  })

  it('validates a group with only literal members', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'allowed-urls', literal_urls: ['https://example.com'] } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a group with no members at all', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'empty-group' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a duplicate group name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'allowed-urls', literal_urls: ['https://a.example.com'] } },
        { name: 'sec2', fields: { name: 'allowed-urls', literal_urls: ['https://b.example.com'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })
})

describe('extractUrlGroupSpecs / buildUrlGroupBaseFields', () => {
  it('splits both member arrays and builds literals', () => {
    const specs = extractUrlGroupSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'allowed-urls', url_object_names: ['app-portal'], literal_urls: ['https://example.com'] } }]),
    )
    expect(specs[0].urlObjectNames).toEqual(['app-portal'])
    expect(specs[0].literalUrls).toEqual(['https://example.com'])
    expect(buildUrlGroupBaseFields(specs[0])).toEqual({ overridable: false, literals: [{ url: 'https://example.com' }] })
  })
})
