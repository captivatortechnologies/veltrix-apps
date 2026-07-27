import validate, { splitIds, extractAlertRuleSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('alert-rules validate', () => {
  it('accepts a valid alert rule', () => {
    const r = validate(ctxWith([{ name: 'Prod', fields: { name: 'Prod', accountGroups: 'ag-1' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { accountGroups: 'ag-1' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('requires at least one target account group', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.accountGroups'))).toBe(true)
  })

  it('warns when scan-all is off with no policies', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', accountGroups: 'ag-1', scanAll: false } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'no_policies')).toBe(true)
  })

  it('rejects invalid tags JSON', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', accountGroups: 'ag-1', tags: '{not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_tags')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', accountGroups: 'ag-1' } },
        { name: 'Dup', fields: { name: 'Dup', accountGroups: 'ag-1' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('splitIds', () => {
  it('splits, trims and de-duplicates', () => {
    expect(splitIds('a\nb, a')).toEqual(['a', 'b'])
    expect(splitIds('')).toEqual([])
  })
})

describe('extractAlertRuleSpecs', () => {
  it('defaults enabled and scanAll to true', () => {
    const specs = extractAlertRuleSpecs({
      items: [{ id: 'i1', name: 'R', fields: { name: 'R', accountGroups: 'ag-1' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].scanAll).toBe(true)
  })

  it('parses the notification delay as a number', () => {
    const specs = extractAlertRuleSpecs({
      items: [{ id: 'i1', name: 'R', fields: { name: 'R', accountGroups: 'ag-1', delayNotificationMs: '500' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].delayNotificationMs).toBe(500)
  })
})
