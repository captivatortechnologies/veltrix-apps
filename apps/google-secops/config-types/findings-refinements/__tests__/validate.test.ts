import validate, { extractFindingsRefinementSpecs, parseOutcomeFilters } from '../validate'
import { refinementBody, refinementIdOf } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const FILTERS = JSON.stringify([{ field: 'risk_score', operator: 'EQUAL', value: '0' }])

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('findings-refinements validate', () => {
  it('accepts a valid refinement', () => {
    const r = validate(ctxWith([{ name: 'x1', fields: { displayName: 'Exclude test host', query: 'principal.hostname = "t"', outcomeFilters: FILTERS } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a display name and a query', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects malformed outcome filters JSON', () => {
    const r = validate(ctxWith([{ name: 'x1', fields: { displayName: 'x', query: 'q', outcomeFilters: '{not array}' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects an invalid outcome filter operator', () => {
    const bad = JSON.stringify([{ field: 'f', operator: 'LIKE', value: 'v' }])
    const r = validate(ctxWith([{ name: 'x1', fields: { displayName: 'x', query: 'q', outcomeFilters: bad } }]))
    expect(r.errors.some((e) => e.code === 'invalid_operator')).toBe(true)
  })

  it('rejects duplicate display names', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { displayName: 'dup', query: 'q' } },
        { name: 'b', fields: { displayName: 'dup', query: 'q' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractFindingsRefinementSpecs / refinementBody', () => {
  it('maps items to specs with parsed outcome filters', () => {
    const specs = extractFindingsRefinementSpecs(ctxWith([{ id: 'i1', name: 'x', fields: { displayName: 'X', query: 'q', outcomeFilters: FILTERS } }]).canvas)
    expect(specs[0].itemId).toBe('i1')
    expect(specs[0].outcomeFilters).toHaveLength(1)
  })

  it('builds a create/update body with the DETECTION_EXCLUSION type', () => {
    const specs = extractFindingsRefinementSpecs(ctxWith([{ name: 'x', fields: { displayName: 'X', query: 'q', outcomeFilters: FILTERS } }]).canvas)
    const body = refinementBody(specs[0]) as { displayName: string; type: string; query: string }
    expect(body.type).toBe('DETECTION_EXCLUSION')
    expect(body.query).toBe('q')
    expect(refinementIdOf('projects/p/locations/us/instances/i/findingsRefinements/fr-3')).toBe('fr-3')
  })

  it('treats an empty outcome-filter blob as an empty array', () => {
    expect(parseOutcomeFilters('')).toHaveLength(0)
  })
})
