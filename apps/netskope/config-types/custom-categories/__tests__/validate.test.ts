import validate, { extractCustomCategorySpecs, splitEntries } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('custom-categories validate', () => {
  it('accepts a valid category', () => {
    const r = validate(ctxWith([{ name: 'Approved SaaS', fields: { name: 'Approved SaaS', included_url_lists: 'Approved' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', included_url_lists: 'A' } },
        { name: 'Dup', fields: { name: 'Dup', included_url_lists: 'B' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a name over the max length', () => {
    const r = validate(ctxWith([{ name: 'A'.repeat(101), fields: { name: 'A'.repeat(101) } }]))
    expect(r.errors.some((e) => e.code === 'too_long')).toBe(true)
  })

  it('rejects non-numeric predefined category ids', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A', included_predefined_categories: 'Financial_Services' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_predefined_category_id')).toBe(true)
  })

  it('accepts numeric predefined category ids', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A', included_predefined_categories: '500' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_predefined_category_id')).toBe(false)
  })

  it('warns when the category has no membership at all', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A' } }]))
    expect(r.warnings.some((w) => w.code === 'empty_category')).toBe(true)
  })
})

describe('extractCustomCategorySpecs', () => {
  it('reads fields and splits list entries', () => {
    const specs = extractCustomCategorySpecs({
      items: [
        {
          id: 'i1',
          name: 'F',
          fields: {
            name: ' Approved SaaS ',
            included_url_lists: 'Approved\nMore',
            excluded_url_lists: 'Blocked',
            included_destination_profiles: 'Corp Network',
            included_predefined_categories: '500, 501',
          },
        },
      ],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('Approved SaaS')
    expect(specs[0].includedUrlLists).toEqual(['Approved', 'More'])
    expect(specs[0].excludedUrlLists).toEqual(['Blocked'])
    expect(specs[0].includedDestinationProfiles).toEqual(['Corp Network'])
    expect(specs[0].includedPredefinedCategories).toEqual(['500', '501'])
  })
})

describe('splitEntries', () => {
  it('splits arrays and delimited strings, trimming', () => {
    expect(splitEntries(['a', ' b '])).toEqual(['a', 'b'])
    expect(splitEntries('a\nb, c')).toEqual(['a', 'b', 'c'])
  })
})
