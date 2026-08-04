import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildGroupBody,
  buildRuleBody,
  extractGroupSpec,
  findGroupByName,
  groupAttributesToBody,
  groupKey,
  isGroupResource,
  isRuleResource,
  ruleKey,
  ruleResourceToBody,
  type ScannerGroupResource,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodRule = { name: 'Credit card', pattern: '\\b(?:\\d[ -]*?){13,16}\\b', priority: 1, is_enabled: true }
const good = {
  name: 'PII scanning',
  description: 'Scans for common PII patterns',
  is_enabled: true,
  product_list: ['logs'],
  filter_query: '*',
  rules: JSON.stringify([goodRule]),
}

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed group with a custom-pattern rule', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate accepts a standard_pattern_id rule instead of pattern', async () => {
  const res = await validate(
    ctxOf([{ ...good, rules: JSON.stringify([{ name: 'SSN', standard_pattern_id: 'abc-123' }]) }]),
  )
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects missing name and empty product_list', async () => {
  const res = await validate(ctxOf([{ ...good, name: '', product_list: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PRODUCT_LIST'))
})

test('validate rejects an unsupported product', async () => {
  const res = await validate(ctxOf([{ ...good, product_list: ['traces'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PRODUCT'))
})

test('validate requires rules and rejects malformed JSON', async () => {
  const empty = await validate(ctxOf([{ ...good, rules: '' }]))
  assert.equal(empty.valid, false)
  assert.ok(empty.errors.some((e) => e.code === 'EMPTY_RULES'))

  const bad = await validate(ctxOf([{ ...good, rules: '{not json' }]))
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((e) => e.code === 'INVALID_RULES_JSON'))
})

test('validate rejects a rule with both pattern and standard_pattern_id, and one with neither', async () => {
  const both = await validate(
    ctxOf([{ ...good, rules: JSON.stringify([{ name: 'x', pattern: 'p', standard_pattern_id: 's' }]) }]),
  )
  assert.equal(both.valid, false)
  assert.ok(both.errors.some((e) => e.code === 'INVALID_PATTERN_CHOICE'))

  const neither = await validate(ctxOf([{ ...good, rules: JSON.stringify([{ name: 'x' }]) }]))
  assert.equal(neither.valid, false)
  assert.ok(neither.errors.some((e) => e.code === 'INVALID_PATTERN_CHOICE'))
})

test('validate rejects an out-of-range priority and a bad text_replacement type', async () => {
  const res = await validate(
    ctxOf([{ ...good, rules: JSON.stringify([{ ...goodRule, priority: 9, text_replacement: { type: 'bogus' } }]) }]),
  )
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PRIORITY'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TEXT_REPLACEMENT_TYPE'))
})

test('validate rejects a duplicate rule name within a group', async () => {
  const res = await validate(ctxOf([{ ...good, rules: JSON.stringify([goodRule, { ...goodRule, pattern: 'different' }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_RULE_NAME'))
})

test('validate rejects a duplicate group name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, name: good.name.toUpperCase() }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_GROUP_NAME'))
})

test('groupKey / ruleKey normalize case and whitespace', () => {
  assert.equal(groupKey('  PII Scanning '), 'pii scanning')
  assert.equal(ruleKey('  Credit Card '), 'credit card')
})

test('findGroupByName matches case-insensitively', () => {
  const groups: ScannerGroupResource[] = [{ id: 'g1', attributes: { name: 'PII Scanning' } }]
  assert.equal(findGroupByName(groups, 'pii scanning')?.id, 'g1')
  assert.equal(findGroupByName(groups, 'missing'), null)
})

test('isGroupResource / isRuleResource discriminate by type', () => {
  assert.equal(isGroupResource({ type: 'sensitive_data_scanner_group' }), true)
  assert.equal(isRuleResource({ type: 'sensitive_data_scanner_group' } as never), false)
  assert.equal(isRuleResource({ type: 'sensitive_data_scanner_rule' }), true)
})

test('buildGroupBody assembles the group attributes', () => {
  const spec = extractGroupSpec(good)
  const body = buildGroupBody(spec)
  assert.equal(body.name, good.name)
  assert.deepEqual(body.product_list, ['logs'])
  assert.deepEqual(body.filter, { query: '*' })
})

test('buildRuleBody extracts standard_pattern_id as a separate return value', () => {
  const withPattern = buildRuleBody(goodRule)
  assert.equal(withPattern.standardPatternId, null)
  assert.equal(withPattern.body.pattern, goodRule.pattern)
  assert.equal('standard_pattern_id' in withPattern.body, false)

  const withStandard = buildRuleBody({ name: 'SSN', standard_pattern_id: 'sp-1' })
  assert.equal(withStandard.standardPatternId, 'sp-1')
  assert.equal('standard_pattern_id' in withStandard.body, false)
})

test('buildRuleBody defaults is_enabled to true and priority to 3 when unset', () => {
  const { body } = buildRuleBody({ name: 'x', pattern: 'y' })
  assert.equal(body.is_enabled, true)
  assert.equal(body.priority, 3)
})

test('groupAttributesToBody and ruleResourceToBody rebuild bodies from captured live state', () => {
  const groupBody = groupAttributesToBody({ name: 'G' })
  assert.equal(groupBody.name, 'G')
  assert.deepEqual(groupBody.product_list, [])
  assert.deepEqual(groupBody.filter, { query: '*' })

  const { body: ruleBody, standardPatternId } = ruleResourceToBody({
    id: 'r1',
    attributes: { name: 'R', pattern: 'p' },
    relationships: { standard_pattern: { data: { id: 'sp-1' } } },
  })
  assert.equal(ruleBody.name, 'R')
  assert.equal(standardPatternId, 'sp-1')
})
