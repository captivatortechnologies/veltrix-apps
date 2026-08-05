import validate, { buildCustomApplicationInput, extractCustomApplicationSpecs, parseJsonArray } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

const VALID_CRITERIA = JSON.stringify([{ destination: { fqdn: ['app.example.com'] }, port: [443], protocol: 'TCP' }])

function makeCanvas(items: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'cato-networks',
    entityType: 'custom-applications',
    items,
    sections: items,
    snapshot: {},
  }
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cato-networks',
    customerId: 'cust-1',
    configTypeId: 'custom-applications',
    canvas: makeCanvas(items),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('Custom Applications validate', () => {
  it('accepts an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(true)
  })

  it('validates a minimal custom application', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Internal App', criteria_json: VALID_CRITERIA } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { criteria_json: VALID_CRITERIA } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_NAME')).toBe(true)
  })

  it('rejects a missing criteria_json', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Internal App' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_CRITERIA')).toBe(true)
  })

  it('rejects criteria_json that is not a JSON array', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Internal App', criteria_json: '{"port":[443]}' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })

  it('rejects an empty criteria array', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { name: 'Internal App', criteria_json: '[]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_CRITERIA_ARRAY')).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'i1', fields: { name: 'App', criteria_json: VALID_CRITERIA } },
        { name: 'i2', fields: { name: 'app', criteria_json: VALID_CRITERIA } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'DUPLICATE_NAME')).toBe(true)
  })
})

describe('extractCustomApplicationSpecs / buildCustomApplicationInput', () => {
  it('splits category tags and builds NAME refs', () => {
    const specs = extractCustomApplicationSpecs(
      makeCanvas([{ name: 'i1', fields: { name: 'App', category: ['Business', 'Cloud Storage'], criteria_json: VALID_CRITERIA } }]),
    )
    const input = buildCustomApplicationInput(specs[0])
    expect(input.category).toEqual([
      { by: 'NAME', input: 'Business' },
      { by: 'NAME', input: 'Cloud Storage' },
    ])
  })

  it('parses criteria_json into the criteria array', () => {
    const specs = extractCustomApplicationSpecs(makeCanvas([{ name: 'i1', fields: { name: 'App', criteria_json: VALID_CRITERIA } }]))
    const input = buildCustomApplicationInput(specs[0])
    expect(input.criteria).toEqual([{ destination: { fqdn: ['app.example.com'] }, port: [443], protocol: 'TCP' }])
  })

  it('defaults to an empty criteria array when criteria_json is missing', () => {
    const specs = extractCustomApplicationSpecs(makeCanvas([{ name: 'i1', fields: { name: 'App' } }]))
    const input = buildCustomApplicationInput(specs[0])
    expect(input.criteria).toEqual([])
  })
})

describe('parseJsonArray', () => {
  it('returns null for blank input', () => {
    expect(parseJsonArray('')).toBeNull()
    expect(parseJsonArray(undefined)).toBeNull()
  })

  it('returns undefined for invalid JSON or a non-array value', () => {
    expect(parseJsonArray('not json')).toBeUndefined()
    expect(parseJsonArray('{"a":1}')).toBeUndefined()
  })

  it('parses a valid JSON array', () => {
    expect(parseJsonArray('[1,2,3]')).toEqual([1, 2, 3])
  })
})
