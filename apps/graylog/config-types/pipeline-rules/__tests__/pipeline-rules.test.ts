import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractRuleName, buildRuleBody, normalizeSource, rulesFromList, findRule } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Graylog REST API via
 * node:https inside graylogApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers (rule-name extraction, body building,
 * source normalization, identity matching).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.title ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  title: 'add-source-tag',
  description: 'tag processed messages',
  source: 'rule "add-source-tag"\nwhen has_field("message")\nthen set_field("processed", true);\nend',
}

test('validate accepts a well-formed rule whose title matches the source', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing title', async () => {
  const res = await validate(ctxOf([{ ...good, title: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TITLE'))
})

test('validate rejects a missing source', async () => {
  const res = await validate(ctxOf([{ ...good, source: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SOURCE'))
})

test('validate rejects a source with no rule declaration', async () => {
  const res = await validate(ctxOf([{ ...good, source: 'when true then end' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NO_RULE_NAME'))
})

test('validate rejects a title that does not match the rule name', async () => {
  const res = await validate(ctxOf([{ ...good, title: 'different-name' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'RULE_NAME_MISMATCH'))
})

test('validate warns when a structural keyword is missing', async () => {
  const res = await validate(ctxOf([{ ...good, source: 'rule "add-source-tag" then set_field("x", 1); end' }]))
  assert.ok(res.warnings.some((w) => w.code === 'MISSING_KEYWORD'))
})

test('validate warns on a duplicate rule title', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TITLE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('extractRuleName pulls the quoted name from the DSL', () => {
  assert.equal(extractRuleName('rule "my rule" when true then end'), 'my rule')
  assert.equal(extractRuleName('  rule   "spaced"\nwhen'), 'spaced')
  assert.equal(extractRuleName('no rule here'), null)
})

test('buildRuleBody trims the source and carries title + description', () => {
  const body = buildRuleBody({ ...good, source: `  ${good.source}  ` })
  assert.equal(body.title, 'add-source-tag')
  assert.equal(body.description, 'tag processed messages')
  assert.ok(body.source.startsWith('rule "add-source-tag"'))
})

test('normalizeSource collapses whitespace so formatting is not drift', () => {
  const a = normalizeSource('rule "x"\n  when   true\nthen end')
  const b = normalizeSource('rule "x" when true then end')
  assert.equal(a, b)
})

test('rulesFromList + findRule match by title from the bare array', () => {
  const live = rulesFromList([{ id: '1', title: 'add-source-tag' }, { id: '2', title: 'drop-noise' }])
  assert.equal(live.length, 2)
  assert.equal(findRule(live, 'drop-noise')?.id, '2')
  assert.equal(findRule(live, 'nope'), null)
})
