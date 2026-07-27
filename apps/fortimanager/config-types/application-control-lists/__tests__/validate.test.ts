import validate, { extractAppControlSpecs, asToggle } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('application-control-lists validate', () => {
  it('accepts a valid profile with entries', () => {
    const r = validate(ctxWith([{ name: 'AppCtl', fields: { name: 'AppCtl', otherApplicationAction: 'block', unknownApplicationAction: 'pass', entries: '[{"id":1,"action":"block"}]' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { entries: '[]' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid action', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', otherApplicationAction: 'drop' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('rejects invalid entries JSON', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', entries: '[oops' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects non-array entries', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', entries: '{"id":1}' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json_shape')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup' } },
        { name: 'Dup', fields: { name: 'Dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('asToggle', () => {
  it('maps checkbox booleans to enable/disable', () => {
    expect(asToggle(true)).toBe('enable')
    expect(asToggle(false)).toBe('disable')
  })
})

describe('extractAppControlSpecs', () => {
  it('lowercases actions and defaults them to pass', () => {
    const specs = extractAppControlSpecs({
      items: [{ id: 'i1', name: 'P', fields: { name: 'P', otherApplicationAction: 'BLOCK' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].otherApplicationAction).toBe('block')
    expect(specs[0].unknownApplicationAction).toBe('pass')
  })
})
