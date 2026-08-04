import validate, {
  extractTransformSpecs,
  parseJsonObject,
  pickMutableKeys,
  stripMutableKeys,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'elastic-security',
    customerId: 'cust-1',
    configTypeId: 'transforms',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'elastic-security',
      entityType: 'transforms',
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

const PIVOT_DEFINITION =
  '{"pivot":{"group_by":{"host":{"terms":{"field":"host.name"}}},"aggregations":{"count":{"value_count":{"field":"_id"}}}}}'

describe('Elastic Security Transforms Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal pivot transform', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Transform',
          fields: {
            transformId: 'logs-by-host',
            sourceIndex: ['logs-*'],
            destIndex: 'logs-by-host-dest',
            definitionJson: PIVOT_DEFINITION,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing transformId', async () => {
    const result = await validate(
      makeCtx([{ name: 't1', fields: { sourceIndex: ['a'], destIndex: 'b', definitionJson: PIVOT_DEFINITION } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('transformId'))).toBe(true)
  })

  it('rejects no source index', async () => {
    const result = await validate(
      makeCtx([{ name: 't1', fields: { transformId: 't1', destIndex: 'b', definitionJson: PIVOT_DEFINITION } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('sourceIndex'))).toBe(true)
  })

  it('rejects a definition with both pivot and latest', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 't1',
          fields: {
            transformId: 't1',
            sourceIndex: ['a'],
            destIndex: 'b',
            definitionJson: '{"pivot":{},"latest":{}}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_aggregation')).toBe(true)
  })

  it('rejects a definition with neither pivot nor latest', async () => {
    const result = await validate(
      makeCtx([{ name: 't1', fields: { transformId: 't1', sourceIndex: ['a'], destIndex: 'b', definitionJson: '{"frequency":"5m"}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_aggregation')).toBe(true)
  })

  it('rejects invalid sourceQueryJson', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 't1',
          fields: {
            transformId: 't1',
            sourceIndex: ['a'],
            destIndex: 'b',
            sourceQueryJson: 'not json',
            definitionJson: PIVOT_DEFINITION,
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_source_query')).toBe(true)
  })

  it('rejects a duplicate transform id', async () => {
    const result = await validate(
      makeCtx([
        { name: 't1', fields: { transformId: 'dup', sourceIndex: ['a'], destIndex: 'b', definitionJson: PIVOT_DEFINITION } },
        { name: 't2', fields: { transformId: 'dup', sourceIndex: ['a'], destIndex: 'b', definitionJson: PIVOT_DEFINITION } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_transform')).toBe(true)
  })
})

describe('extractTransformSpecs', () => {
  it('trims fields and defaults enabled to true', () => {
    const specs = extractTransformSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'transforms',
      items: [],
      sections: [{ name: 'sec1', fields: { transformId: '  t1  ', sourceIndex: ['logs-*'], destIndex: 'dest' } }],
      snapshot: {},
    })
    expect(specs[0].transformId).toBe('t1')
    expect(specs[0].enabled).toBe(true)
  })
})

describe('stripMutableKeys / pickMutableKeys', () => {
  const definition = parseJsonObject('{"pivot":{"a":1},"frequency":"5m","sync":{"time":{"field":"@timestamp"}}}')!

  it('stripMutableKeys keeps only the immutable aggregation', () => {
    expect(stripMutableKeys(definition)).toEqual({ pivot: { a: 1 } })
  })
  it('pickMutableKeys keeps only the mutable settings', () => {
    expect(pickMutableKeys(definition)).toEqual({ frequency: '5m', sync: { time: { field: '@timestamp' } } })
  })
})
