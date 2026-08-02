import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  attributesToBody,
  buildSuppressionBody,
  extractSuppressionSpec,
  findSuppressionByName,
  isNonEditableSuppression,
  parseEpochMs,
  sameTagSet,
  suppressionKey,
  toCreatePayload,
  toUpdatePayload,
  type SuppressionResource,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/healthCheck/driftDetect handlers apply over the Datadog
 * API via lib/datadogApi (global fetch), which is impractical to mock here.
 * Tests focus on validate.ts and the pure _shared helpers, which are
 * network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Suppress staging brute-force',
  description: 'Suppresses low-severity staging signals',
  enabled: true,
  rule_query: 'type:log_detection source:cloudtrail',
  suppression_query: 'env:staging status:low',
  tags: ['technique:T1110'],
}

// --- validate ------------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed suppression', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects missing name and rule_query', async () => {
  const res = await validate(ctxOf([{ ...good, name: '', rule_query: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_RULE_QUERY'))
})

test('validate rejects a name longer than 255 characters', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'x'.repeat(256) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate rejects a non-numeric start_date / expiration_date', async () => {
  const res = await validate(ctxOf([{ ...good, start_date: 'not-a-date', expiration_date: 'also-bad' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_START_DATE'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXPIRATION_DATE'))
})

test('validate rejects an expiration_date before start_date', async () => {
  const res = await validate(ctxOf([{ ...good, start_date: 2000, expiration_date: 1000 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EXPIRATION_BEFORE_START'))
})

test('validate accepts a valid start/expiration window', async () => {
  const res = await validate(ctxOf([{ ...good, start_date: 1000, expiration_date: 2000 }]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects a duplicate suppression name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, name: good.name.toUpperCase() }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

// --- _shared helpers -------------------------------------------------------------

test('extractSuppressionSpec trims fields and reads tags', () => {
  const spec = extractSuppressionSpec(good)
  assert.equal(spec.name, good.name)
  assert.equal(spec.ruleQuery, good.rule_query)
  assert.deepEqual(spec.tags, ['technique:T1110'])
})

test('suppressionKey normalizes case and whitespace', () => {
  assert.equal(suppressionKey('  Suppress Staging '), 'suppress staging')
})

test('findSuppressionByName matches case-insensitively', () => {
  const rules: SuppressionResource[] = [
    { id: 'r1', type: 'suppressions', attributes: { name: 'Suppress Staging' } },
    { id: 'r2', type: 'suppressions', attributes: { name: 'Other' } },
  ]
  assert.equal(findSuppressionByName(rules, 'suppress staging')?.id, 'r1')
  assert.equal(findSuppressionByName(rules, 'missing'), null)
})

test('isNonEditableSuppression is true only when editable === false', () => {
  assert.equal(isNonEditableSuppression({ attributes: { editable: false } }), true)
  assert.equal(isNonEditableSuppression({ attributes: { editable: true } }), false)
  assert.equal(isNonEditableSuppression({ attributes: {} }), false)
  assert.equal(isNonEditableSuppression(null), false)
})

test('parseEpochMs: blank is undefined, a number parses, garbage is NaN', () => {
  assert.equal(parseEpochMs(''), undefined)
  assert.equal(parseEpochMs('1700000000000'), 1700000000000)
  assert.ok(Number.isNaN(parseEpochMs('not-a-date')))
})

test('buildSuppressionBody only sets dates when defined', () => {
  const spec = extractSuppressionSpec(good)
  const withDates = buildSuppressionBody(spec, 1000, 2000)
  assert.equal(withDates.start_date, 1000)
  assert.equal(withDates.expiration_date, 2000)

  const withoutDates = buildSuppressionBody(spec, undefined, undefined)
  assert.equal('start_date' in withoutDates, false)
  assert.equal('expiration_date' in withoutDates, false)
})

test('attributesToBody rebuilds a body from captured live attributes, defaulting missing fields', () => {
  const body = attributesToBody({ name: 'N', enabled: false })
  assert.equal(body.name, 'N')
  assert.equal(body.enabled, false)
  assert.deepEqual(body.tags, [])
  assert.equal('start_date' in body, false)
})

test('toCreatePayload / toUpdatePayload wrap the body in the JSON:API envelope', () => {
  const spec = extractSuppressionSpec(good)
  const body = buildSuppressionBody(spec, undefined, undefined)

  const created = toCreatePayload(body)
  assert.equal(created.data.type, 'suppressions')
  assert.equal(created.data.attributes.name, good.name)
  assert.equal('id' in created.data, false)

  const updated = toUpdatePayload('sup-1', body)
  assert.equal(updated.data.id, 'sup-1')
  assert.equal(updated.data.type, 'suppressions')
})

test('sameTagSet is order-insensitive', () => {
  assert.equal(sameTagSet(['a', 'b'], ['b', 'a']), true)
  assert.equal(sameTagSet(['a'], ['a', 'b']), false)
})
