import validate, { parseBodyJson, asBool, extractWebFilterProfileSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('webfilter-profiles validate', () => {
  it('accepts a profile with no advanced body', () => {
    const r = validate(ctxWith([{ name: 'Corp', fields: { name: 'Corp' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a profile with a valid ftgd-wf body', () => {
    const r = validate(ctxWith([{ name: 'Corp', fields: { name: 'Corp', bodyJson: '{"ftgd-wf":{"filters":[{"category":26,"action":"block"}]}}' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a malformed advanced body', () => {
    const r = validate(ctxWith([{ name: 'Corp', fields: { name: 'Corp', bodyJson: '{not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects an advanced body that is not an object', () => {
    const r = validate(ctxWith([{ name: 'Corp', fields: { name: 'Corp', bodyJson: '[1,2,3]' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
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

describe('parseBodyJson', () => {
  it('treats empty as a valid empty object', () => {
    const r = parseBodyJson('')
    expect(r.ok).toBe(true)
    expect(r.value).toEqual({})
  })
  it('rejects a JSON array', () => {
    expect(parseBodyJson('[1]').ok).toBe(false)
  })
})

describe('asBool', () => {
  it('reads enable / true / 1 as true', () => {
    expect(asBool('enable')).toBe(true)
    expect(asBool(true)).toBe(true)
    expect(asBool(1)).toBe(true)
    expect(asBool('disable')).toBe(false)
  })
})

describe('extractWebFilterProfileSpecs', () => {
  it('coerces checkbox toggles to booleans', () => {
    const specs = extractWebFilterProfileSpecs({
      items: [{ id: 'i1', name: 'Corp', fields: { name: 'Corp', logAllUrl: true } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].logAllUrl).toBe(true)
    expect(specs[0].wisp).toBe(false)
  })
})
