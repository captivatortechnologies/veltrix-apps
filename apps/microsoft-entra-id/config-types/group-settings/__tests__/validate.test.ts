import validate, { canonicalValues, parseValues } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const TEMPLATE = '62375ab9-6b52-47ed-826b-58e47e0e304b'

function ctxWith(items: Array<{ id?: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('group-settings validate', () => {
  it('accepts a valid setting', () => {
    const r = validate(
      ctxWith([{ fields: { templateId: TEMPLATE, values: '[{"name":"EnableGroupCreation","value":"false"}]' } }]),
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a template id', () => {
    const r = validate(ctxWith([{ fields: { values: '[]' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a non-GUID template id', () => {
    const r = validate(ctxWith([{ fields: { templateId: 'unified' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_template_id')).toBe(true)
  })

  it('rejects invalid values JSON', () => {
    const r = validate(ctxWith([{ fields: { templateId: TEMPLATE, values: '{not array' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a value without a name', () => {
    const r = validate(ctxWith([{ fields: { templateId: TEMPLATE, values: '[{"value":"x"}]' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })
})

describe('helpers', () => {
  it('canonicalizes values independent of order', () => {
    const a = parseValues('[{"name":"a","value":"1"},{"name":"b","value":"2"}]') ?? []
    const b = parseValues('[{"name":"b","value":"2"},{"name":"a","value":"1"}]') ?? []
    expect(canonicalValues(a)).toBe(canonicalValues(b))
  })
})
