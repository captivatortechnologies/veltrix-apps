import validate, { extractUrlObjectSpecs, buildUrlObjectFields } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-secure-firewall',
    customerId: 'cust-1',
    configTypeId: 'url-objects',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-secure-firewall',
      entityType: 'url-objects',
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
    entityType: 'url-objects',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('URL Objects validate handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal URL object', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'app-portal', url: 'https://app.example.com' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing url', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'app-portal' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('url'))).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'app-portal', url: 'https://app.example.com' } },
        { name: 'sec2', fields: { name: 'app-portal', url: 'https://app2.example.com' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })
})

describe('extractUrlObjectSpecs / buildUrlObjectFields', () => {
  it('trims fields and builds body fields', () => {
    const specs = extractUrlObjectSpecs(makeCanvas([{ name: 'sec1', fields: { name: '  app-portal  ', url: ' https://app.example.com ' } }]))
    expect(specs[0].name).toBe('app-portal')
    expect(specs[0].url).toBe('https://app.example.com')
    expect(buildUrlObjectFields(specs[0])).toEqual({ url: 'https://app.example.com', overridable: false })
  })
})
