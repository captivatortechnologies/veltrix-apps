import validate, { extractRateLimitSpecs, parseJsonObject } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const valid = { name: 'GptRl', criteria: '{"provider":"openai"}', limit: '{"requests":100}' }

describe('aig-rate-limits validate', () => {
  it('accepts a valid rule', () => {
    const r = validate(ctxWith([{ name: 'GptRl', fields: { ...valid } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires criteria and limit', () => {
    const r = validate(ctxWith([{ name: 'GptRl', fields: { name: 'GptRl' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.criteria'))).toBe(true)
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.limit'))).toBe(true)
  })

  it('rejects invalid JSON in criteria', () => {
    const r = validate(ctxWith([{ name: 'GptRl', fields: { ...valid, criteria: '{bad' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a too-long name', () => {
    const r = validate(ctxWith([{ name: 'x'.repeat(16), fields: { ...valid, name: 'x'.repeat(16) } }]))
    expect(r.errors.some((e) => e.code === 'too_long')).toBe(true)
  })

  it('rejects too many appliance ids', () => {
    const r = validate(ctxWith([{ name: 'GptRl', fields: { ...valid, appliance_ids: 'a\nb\nc\nd\ne\nf' } }]))
    expect(r.errors.some((e) => e.code === 'too_many')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { ...valid, name: 'Dup' } },
        { name: 'Dup', fields: { ...valid, name: 'Dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseJsonObject', () => {
  it('parses objects and reports errors', () => {
    expect(parseJsonObject('{"a":1}').value).toEqual({ a: 1 })
    expect(parseJsonObject('').provided).toBe(false)
    expect(typeof parseJsonObject('[1]').error).toBe('string')
  })
})

describe('extractRateLimitSpecs', () => {
  it('reads fields and appliance ids', () => {
    const specs = extractRateLimitSpecs({
      items: [{ id: 'i1', name: 'F', fields: { name: 'GptRl', criteria: '{}', limit: '{}', appliance_ids: 'a1\na2' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('GptRl')
    expect(specs[0].applianceIds).toEqual(['a1', 'a2'])
  })
})
