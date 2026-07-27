import validate, { canonical } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const CONDITIONS = '{"@odata.type":"#microsoft.graph.identityGovernance.triggerAndScopeBasedConditions"}'
const TASKS = '[{"continueOnError":false,"taskDefinitionId":"abc","arguments":[]}]'

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('lifecycle-workflows validate', () => {
  it('accepts a valid workflow', () => {
    const r = validate(
      ctxWith([{ fields: { name: 'Onboard', category: 'joiner', executionConditions: CONDITIONS, tasks: TASKS } }]),
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name, category, conditions and tasks', () => {
    const r = validate(ctxWith([{ fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_execution_conditions')).toBe(true)
    expect(r.errors.some((e) => e.code === 'invalid_tasks')).toBe(true)
  })

  it('rejects an invalid category', () => {
    const r = validate(
      ctxWith([{ fields: { name: 'X', category: 'stayer', executionConditions: CONDITIONS, tasks: TASKS } }]),
    )
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_category')).toBe(true)
  })

  it('rejects an empty tasks array', () => {
    const r = validate(
      ctxWith([{ fields: { name: 'X', category: 'joiner', executionConditions: CONDITIONS, tasks: '[]' } }]),
    )
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_tasks')).toBe(true)
  })
})

describe('helpers', () => {
  it('canonicalizes independent of key order', () => {
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }))
  })
})
