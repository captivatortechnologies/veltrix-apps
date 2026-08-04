import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildCustomTagRuleBody, createIdFromEnvelope, tagRuleFromEnvelope } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers apply over the Orca REST API via lib/orcaApi (fetch),
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodString = {
  name: 'Tag public EC2 instances',
  description: 'Auto-tag internet-facing EC2 instances',
  ruleType: 'string',
  rule: 'AwsEc2Instance with PublicIps',
  tags: { exposure: 'public' },
  disabled: false,
}

const goodJson = {
  name: 'Tag internet-facing EC2 instances',
  ruleType: 'json',
  rule: JSON.stringify({ type: 'object_set', models: ['AwsEc2Instance'] }),
  tags: { exposure: 'internet-facing' },
}

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed string rule', async () => {
  const res = await validate(ctxOf([goodString]))
  assert.equal(res.valid, true)
})

test('validate accepts a well-formed json rule', async () => {
  const res = await validate(ctxOf([goodJson]))
  assert.equal(res.valid, true)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...goodString, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects malformed JSON when rule type is json', async () => {
  const res = await validate(ctxOf([{ ...goodJson, rule: '{oops}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RULE_JSON'))
})

test('validate rejects an empty rule', async () => {
  const res = await validate(ctxOf([{ ...goodString, rule: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_RULE'))
})

test('validate rejects no tags', async () => {
  const res = await validate(ctxOf([{ ...goodString, tags: {} }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TAGS'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([goodString, { ...goodString }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ---------------------------------------------------------

test('buildCustomTagRuleBody keeps a string rule as-is', () => {
  const result = buildCustomTagRuleBody(goodString)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.body.rule, goodString.rule)
    assert.equal(result.body.rule_type, 'string')
    assert.deepEqual(result.body.tags, { exposure: 'public' })
    assert.equal(result.body.disabled, false)
  }
})

test('buildCustomTagRuleBody parses a json rule into an object', () => {
  const result = buildCustomTagRuleBody(goodJson)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.body.rule, { type: 'object_set', models: ['AwsEc2Instance'] })
    assert.equal(result.body.rule_type, 'json')
  }
})

test('buildCustomTagRuleBody reports an error for malformed json', () => {
  const result = buildCustomTagRuleBody({ ...goodJson, rule: '{oops}' })
  assert.equal(result.ok, false)
})

test('tagRuleFromEnvelope and createIdFromEnvelope unwrap their envelopes', () => {
  assert.deepEqual(tagRuleFromEnvelope({ data: { id: 'r1' } }), { id: 'r1' })
  assert.equal(tagRuleFromEnvelope(null), null)
  assert.equal(createIdFromEnvelope({ data: { tags_rule_id: 'r1' } }), 'r1')
  assert.equal(createIdFromEnvelope({ data: {} }), null)
})
