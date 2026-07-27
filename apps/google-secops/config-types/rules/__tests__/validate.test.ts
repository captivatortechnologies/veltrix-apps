import validate, { extractRuleName, extractRuleSpecs, normalizeRuleText } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const RULE = `rule suspicious_login {
  meta:
    author = "soc"
    severity = "Medium"
  events:
    $e.metadata.event_type = "USER_LOGIN"
  condition:
    $e
}`

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('rules validate', () => {
  it('accepts a valid YARA-L rule', () => {
    const r = validate(ctxWith([{ name: 'r1', fields: { text: RULE } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires rule text', () => {
    const r = validate(ctxWith([{ name: 'r1', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects text with no rule declaration', () => {
    const r = validate(ctxWith([{ name: 'r1', fields: { text: 'events:\n  $e\ncondition:\n  $e' } }]))
    expect(r.errors.some((e) => e.code === 'no_rule_name')).toBe(true)
  })

  it('rejects a rule with no condition section', () => {
    const r = validate(ctxWith([{ name: 'r1', fields: { text: 'rule no_cond {\n  events:\n    $e\n}' } }]))
    expect(r.errors.some((e) => e.code === 'no_condition')).toBe(true)
  })

  it('rejects duplicate rule names', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { text: RULE } },
        { name: 'b', fields: { text: RULE } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })
})

describe('extractRuleName / extractRuleSpecs', () => {
  it('parses the rule name out of the source', () => {
    expect(extractRuleName(RULE)).toBe('suspicious_login')
  })
  it('returns an empty name when there is no rule header', () => {
    expect(extractRuleName('condition:\n  $e')).toBe('')
  })
  it('maps items to specs with the parsed identity', () => {
    const specs = extractRuleSpecs({
      items: [{ id: 'i1', name: 'r', fields: { text: RULE } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].itemId).toBe('i1')
    expect(specs[0].ruleName).toBe('suspicious_login')
  })
})

describe('normalizeRuleText', () => {
  it('collapses whitespace so re-formatting is not read as a change', () => {
    expect(normalizeRuleText('rule  x {\n\n  condition:\n    $e\n}')).toBe(normalizeRuleText('rule x { condition: $e }'))
  })
})
