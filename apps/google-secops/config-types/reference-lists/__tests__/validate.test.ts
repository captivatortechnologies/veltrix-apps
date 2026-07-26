import validate, { mapSyntaxType, splitEntries, extractReferenceListSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('reference-lists validate', () => {
  it('accepts a valid plain list', () => {
    const r = validate(ctxWith([{ name: 'Bad_Domains', fields: { name: 'Bad_Domains', syntax: 'plain', entries: 'a.com\nb.com' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a valid CIDR list', () => {
    const r = validate(ctxWith([{ name: 'Ranges', fields: { name: 'Ranges', syntax: 'cidr', entries: '10.0.0.0/8\n192.168.0.0/16' } }]))
    expect(r.valid).toBe(true)
  })

  it('rejects an invalid CIDR entry', () => {
    const r = validate(ctxWith([{ name: 'Ranges', fields: { name: 'Ranges', syntax: 'cidr', entries: '10.0.0.0/33' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_cidr')).toBe(true)
  })

  it('rejects an invalid reference list id', () => {
    const r = validate(ctxWith([{ name: '9bad-name', fields: { name: '9bad-name', syntax: 'plain' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { syntax: 'plain' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid syntax', () => {
    const r = validate(ctxWith([{ name: 'L', fields: { name: 'L', syntax: 'yaral' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_syntax')).toBe(true)
  })

  it('warns on an empty list', () => {
    const r = validate(ctxWith([{ name: 'Empty', fields: { name: 'Empty', syntax: 'plain' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_list')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', syntax: 'plain', entries: 'a' } },
        { name: 'Dup', fields: { name: 'Dup', syntax: 'plain', entries: 'b' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('mapSyntaxType', () => {
  it('maps the canvas syntax to the API enum', () => {
    expect(mapSyntaxType('plain')).toBe('REFERENCE_LIST_SYNTAX_TYPE_PLAIN_TEXT_STRING')
    expect(mapSyntaxType('regex')).toBe('REFERENCE_LIST_SYNTAX_TYPE_REGEX')
    expect(mapSyntaxType('cidr')).toBe('REFERENCE_LIST_SYNTAX_TYPE_CIDR')
    expect(mapSyntaxType('anything')).toBe('REFERENCE_LIST_SYNTAX_TYPE_PLAIN_TEXT_STRING')
  })
})

describe('splitEntries / extractReferenceListSpecs', () => {
  it('splits entries by line', () => {
    expect(splitEntries('a\n b \nc')).toEqual(['a', 'b', 'c'])
  })
  it('lowercases syntax', () => {
    const specs = extractReferenceListSpecs({
      items: [{ id: 'i1', name: 'L', fields: { name: 'L', syntax: 'CIDR', entries: '10.0.0.0/8' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].syntax).toBe('cidr')
  })
})
