import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parseRules, buildStreamBody, normalizeMatchingType, findStream, streamsFromList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Graylog REST API via node:https
 * inside graylogApi, which is impractical to mock here. Tests focus on validate.ts
 * and the pure _shared helpers (rule parsing, body building, identity matching).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.title ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  title: 'Firewall',
  description: 'Firewall messages',
  matching_type: 'AND',
  remove_matches_from_default_stream: false,
  rules: '[{"field":"source","type":1,"value":"firewall","inverted":false}]',
}

test('validate rejects a missing title', async () => {
  const res = await validate(ctxOf([{ ...good, title: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TITLE'))
})

test('validate rejects an invalid matching type', async () => {
  const res = await validate(ctxOf([{ ...good, matching_type: 'XOR' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MATCHING_TYPE'))
})

test('validate rejects malformed rules JSON', async () => {
  const res = await validate(ctxOf([{ ...good, rules: '{ not valid json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RULES_JSON'))
})

test('validate rejects a rule with an unknown type', async () => {
  const res = await validate(ctxOf([{ ...good, rules: '[{"field":"source","type":99,"value":"x"}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'RULE_INVALID_TYPE'))
})

test('validate rejects a value-requiring rule with no value', async () => {
  const res = await validate(ctxOf([{ ...good, rules: '[{"field":"source","type":1}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'RULE_MISSING_VALUE'))
})

test('validate allows a presence rule (type 5) with no value', async () => {
  const res = await validate(ctxOf([{ ...good, rules: '[{"field":"user_id","type":5}]' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate stream title', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TITLE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('parseRules coerces string types and inverted flags', () => {
  const { rules, error } = parseRules('[{"field":"a","type":"6","value":"x","inverted":"true"}]')
  assert.equal(error, undefined)
  assert.equal(rules.length, 1)
  assert.equal(rules[0].type, 6)
  assert.equal(rules[0].inverted, true)
})

test('parseRules treats blank as an empty rule set', () => {
  assert.deepEqual(parseRules('').rules, [])
  assert.deepEqual(parseRules('   ').rules, [])
  assert.deepEqual(parseRules(null).rules, [])
})

test('normalizeMatchingType defaults unknown values to AND', () => {
  assert.equal(normalizeMatchingType('or'), 'OR')
  assert.equal(normalizeMatchingType('nonsense'), 'AND')
  assert.equal(normalizeMatchingType(undefined), 'AND')
})

test('buildStreamBody threads the index set id and normalizes fields', () => {
  const body = buildStreamBody(good, 'idx-123')
  assert.equal(body.index_set_id, 'idx-123')
  assert.equal(body.matching_type, 'AND')
  assert.equal(body.remove_matches_from_default_stream, false)
  assert.equal(body.rules?.length, 1)
  assert.equal(body.title, 'Firewall')
})

test('streamsFromList + findStream match by title from the API envelope', () => {
  const live = streamsFromList({ total: 2, streams: [{ id: '1', title: 'Firewall' }, { id: '2', title: 'DNS' }] })
  assert.equal(live.length, 2)
  assert.equal(findStream(live, 'DNS')?.id, '2')
  assert.equal(findStream(live, 'Nope'), null)
})
