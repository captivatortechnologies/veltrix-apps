import validate, { extractPipelineSpecs, parseProcessors } from '../validate'
import { pipelineBody } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const PROCESSORS = JSON.stringify([{ type: 'FILTER', expression: 'true' }])

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('log-processing-pipelines validate', () => {
  it('accepts a valid pipeline', () => {
    const r = validate(ctxWith([{ name: 'p1', fields: { id: 'route_prod', displayName: 'Prod routing', processors: PROCESSORS } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires id, display name and processors', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid id', () => {
    const r = validate(ctxWith([{ name: 'p1', fields: { id: '1bad', displayName: 'x', processors: PROCESSORS } }]))
    expect(r.errors.some((e) => e.code === 'invalid_id')).toBe(true)
  })

  it('rejects processors that are not a JSON array', () => {
    const r = validate(ctxWith([{ name: 'p1', fields: { id: 'route', displayName: 'x', processors: '{}' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects duplicate ids', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { id: 'dup', displayName: 'x', processors: PROCESSORS } },
        { name: 'b', fields: { id: 'dup', displayName: 'y', processors: PROCESSORS } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_id')).toBe(true)
  })
})

describe('extractPipelineSpecs / pipelineBody', () => {
  it('maps items to specs with parsed processors', () => {
    const specs = extractPipelineSpecs(ctxWith([{ id: 'i1', name: 'p', fields: { id: 'route', displayName: 'R', processors: PROCESSORS } }]).canvas)
    expect(specs[0].itemId).toBe('i1')
    expect(specs[0].id).toBe('route')
    expect(specs[0].processors).toHaveLength(1)
  })

  it('builds a create/update body', () => {
    const specs = extractPipelineSpecs(ctxWith([{ name: 'p', fields: { id: 'route', displayName: 'R', description: 'd', processors: PROCESSORS } }]).canvas)
    const body = pipelineBody(specs[0]) as { displayName: string; description: string; processors: unknown[] }
    expect(body.displayName).toBe('R')
    expect(body.processors).toHaveLength(1)
    expect(parseProcessors('[]')).toHaveLength(0)
  })
})
