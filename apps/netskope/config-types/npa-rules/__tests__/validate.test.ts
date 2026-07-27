import validate, { extractRuleSpecs, splitEntries, trimBrackets } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('npa-rules validate', () => {
  it('accepts a valid rule', () => {
    const r = validate(
      ctxWith([{ name: 'Allow CRM', fields: { rule_name: 'Allow CRM', action: 'allow', private_apps: 'CRM' } }])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a rule name', () => {
    const r = validate(ctxWith([{ name: '', fields: { action: 'allow' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid action', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { rule_name: 'A', action: 'drop' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('warns when no apps or tags are set', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { rule_name: 'A', action: 'block' } }]))
    expect(r.warnings.some((w) => w.code === 'no_apps')).toBe(true)
  })

  it('rejects duplicate rule names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { rule_name: 'Dup', action: 'allow', private_apps: 'A' } },
        { name: 'Dup', fields: { rule_name: 'Dup', action: 'block', private_apps: 'B' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractRuleSpecs', () => {
  it('reads fields, arrays and booleans', () => {
    const specs = extractRuleSpecs({
      items: [
        {
          id: 'i1',
          name: 'F',
          fields: {
            rule_name: ' Allow CRM ',
            action: 'block',
            group: 'Corp',
            enabled: false,
            private_apps: 'CRM\nWiki',
            users: 'alice@corp.com',
            b_negate_src_countries: true,
          },
        },
      ],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('Allow CRM')
    expect(specs[0].action).toBe('block')
    expect(specs[0].group).toBe('Corp')
    expect(specs[0].enabled).toBe(false)
    expect(specs[0].privateApps).toEqual(['CRM', 'Wiki'])
    expect(specs[0].users).toEqual(['alice@corp.com'])
    expect(specs[0].negateSrcCountries).toBe(true)
  })

  it('defaults enabled to true and action to allow when absent', () => {
    const specs = extractRuleSpecs({
      items: [{ id: 'i2', name: 'F', fields: { rule_name: 'F' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].action).toBe('allow')
  })
})

describe('trimBrackets', () => {
  it('strips netskope bracket-wrapped app names', () => {
    expect(trimBrackets('[CRM]')).toBe('CRM')
    expect(trimBrackets('CRM')).toBe('CRM')
  })
})

describe('splitEntries', () => {
  it('splits arrays and delimited strings, trimming', () => {
    expect(splitEntries(['a', ' b '])).toEqual(['a', 'b'])
    expect(splitEntries('a\nb, c')).toEqual(['a', 'b', 'c'])
    expect(splitEntries('')).toEqual([])
  })
})
