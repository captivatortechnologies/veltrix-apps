import validate, { extractWorkflowSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const goodTrigger = '{"type":"EVENT","attributes":{"id":"idn:access-request"}}'
const goodDef = '{"start":"s1","steps":{}}'

describe('workflows validate', () => {
  it('accepts a valid workflow', () => {
    const r = validate(ctxWith([{ name: 'WF', fields: { name: 'WF', ownerId: 'o', trigger: goodTrigger, definition: goodDef } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name and owner', () => {
    const r = validate(ctxWith([{ name: '', fields: { trigger: goodTrigger, definition: goodDef } }]))
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].ownerId')).toBe(true)
  })

  it('requires a trigger with a type', () => {
    const r = validate(ctxWith([{ name: 'WF', fields: { name: 'WF', ownerId: 'o', trigger: '{}', definition: goodDef } }]))
    expect(r.errors.some((e) => e.code === 'invalid_trigger')).toBe(true)
  })

  it('requires a definition', () => {
    const r = validate(ctxWith([{ name: 'WF', fields: { name: 'WF', ownerId: 'o', trigger: goodTrigger } }]))
    expect(r.errors.some((e) => e.field === 'items[0].definition')).toBe(true)
  })
})

describe('extractWorkflowSpecs', () => {
  it('stringifies object trigger/definition', () => {
    const specs = extractWorkflowSpecs({
      items: [{ id: 'i1', name: 'WF', fields: { name: 'WF', ownerId: 'o', trigger: { type: 'EVENT' }, definition: { start: 's' }, enabled: true } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].triggerRaw).toBe('{"type":"EVENT"}')
    expect(specs[0].enabled).toBe(true)
  })
})
