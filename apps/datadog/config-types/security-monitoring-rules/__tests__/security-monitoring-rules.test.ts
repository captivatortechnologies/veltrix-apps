import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildRuleBody,
  deepSubsetEqual,
  extractRuleSpec,
  findRuleByName,
  parseJsonArray,
  parseJsonObject,
  readStringArray,
  ruleKey,
  ruleToBody,
  stableStringify,
  type DatadogRule,
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
  name: 'Failed console logins',
  message: 'Multiple failed console logins for {{@userIdentity.arn}}',
  type: 'log_detection',
  isEnabled: true,
  hasExtendedTitle: false,
  tags: ['security:attack'],
  queries: JSON.stringify([
    { name: 'q1', query: 'source:cloudtrail @evt.name:ConsoleLogin', aggregation: 'count', groupByFields: ['@userIdentity.arn'] },
  ]),
  cases: JSON.stringify([{ status: 'medium', condition: 'a > 5' }]),
  options: JSON.stringify({ evaluationWindow: 900, keepAlive: 3600, maxSignalDuration: 86400 }),
  filters: '[]',
}

// --- validate ----------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed log_detection rule', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name and message', async () => {
  const res = await validate(ctxOf([{ ...good, name: '', message: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_MESSAGE'))
})

test('validate rejects a name longer than 255 characters', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'x'.repeat(256) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate rejects an unsupported rule type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'made_up_type' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects malformed queries/cases/options JSON', async () => {
  const res = await validate(ctxOf([{ ...good, queries: '{not json', cases: '{also bad', options: '[not-an-object]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_QUERIES_JSON'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CASES_JSON'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_OPTIONS_JSON'))
})

test('validate requires a "query" string on each standard-type query', async () => {
  const res = await validate(ctxOf([{ ...good, queries: JSON.stringify([{ aggregation: 'count' }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_QUERY_STRING'))
})

test('validate rejects an unsupported query aggregation / dataSource', async () => {
  const res = await validate(
    ctxOf([{ ...good, queries: JSON.stringify([{ query: 'x', aggregation: 'bogus', dataSource: 'bogus' }]) }]),
  )
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_AGGREGATION'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DATA_SOURCE'))
})

test('validate requires at least one case and a supported status', async () => {
  const empty = await validate(ctxOf([{ ...good, cases: '[]' }]))
  assert.equal(empty.valid, false)
  assert.ok(empty.errors.some((e) => e.code === 'EMPTY_CASES'))

  const badStatus = await validate(ctxOf([{ ...good, cases: JSON.stringify([{ status: 'catastrophic' }]) }]))
  assert.equal(badStatus.valid, false)
  assert.ok(badStatus.errors.some((e) => e.code === 'INVALID_CASE_STATUS'))
})

test('validate enforces exactly one case for cloud_configuration rules', async () => {
  const res = await validate(
    ctxOf([
      {
        ...good,
        type: 'cloud_configuration',
        queries: '[]',
        cases: JSON.stringify([{ status: 'high' }, { status: 'low' }]),
        options: JSON.stringify({ complianceRuleOptions: { resourceType: 'aws_s3_bucket', regoRule: { policy: 'package datadog', resourceTypes: ['aws_s3_bucket'] } } }),
      },
    ]),
  )
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'CLOUD_CONFIG_CASE_COUNT'))
})

test('validate warns (does not error) when cloud_configuration options omit complianceRuleOptions', async () => {
  const res = await validate(
    ctxOf([{ ...good, type: 'cloud_configuration', queries: '[]', cases: JSON.stringify([{ status: 'high' }]), options: '{}' }]),
  )
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'CLOUD_CONFIG_MISSING_COMPLIANCE_OPTIONS'))
})

test('validate requires a ruleId on signal_correlation queries', async () => {
  const res = await validate(
    ctxOf([{ ...good, type: 'signal_correlation', queries: JSON.stringify([{ correlatedByFields: ['host'] }]) }]),
  )
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_RULE_ID'))
})

test('validate rejects an out-of-range evaluationWindow and an unsupported detectionMethod', async () => {
  const res = await validate(
    ctxOf([{ ...good, options: JSON.stringify({ evaluationWindow: 42, detectionMethod: 'guesswork' }) }]),
  )
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_WINDOW_VALUE'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DETECTION_METHOD'))
})

test('validate rejects an unsupported filter action', async () => {
  const res = await validate(ctxOf([{ ...good, filters: JSON.stringify([{ query: 'x', action: 'ignore' }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FILTER_ACTION'))
})

test('validate rejects a duplicate rule name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, name: good.name.toUpperCase() }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

// --- _shared helpers -----------------------------------------------------------

test('extractRuleSpec trims, defaults and reads the tags list', () => {
  const spec = extractRuleSpec({ ...good, name: '  Spaced  ', tags: ['a', ' b ', ''] })
  assert.equal(spec.name, 'Spaced')
  assert.deepEqual(spec.tags, ['a', 'b'])
  assert.equal(spec.type, 'log_detection')
  assert.equal(spec.isEnabled, true)
})

test('extractRuleSpec defaults an unset type to log_detection and reads a comma tag string', () => {
  const spec = extractRuleSpec({ name: 'n', message: 'm', tags: 'a, b ,a' })
  assert.equal(spec.type, 'log_detection')
  assert.deepEqual(spec.tags, ['a', 'b'])
})

test('readStringArray accepts an array or a comma/newline string, trims and drops blanks', () => {
  assert.deepEqual(readStringArray(['a', ' b ', '']), ['a', 'b'])
  assert.deepEqual(readStringArray('a,b\nc'), ['a', 'b', 'c'])
  assert.deepEqual(readStringArray(undefined), [])
})

test('ruleKey normalizes case and whitespace', () => {
  assert.equal(ruleKey('  Failed Logins '), 'failed logins')
})

test('findRuleByName matches case-insensitively and trims', () => {
  const rules: DatadogRule[] = [{ id: 'r1', name: 'Failed Logins' }, { id: 'r2', name: 'Other' }]
  assert.equal(findRuleByName(rules, 'failed logins')?.id, 'r1')
  assert.equal(findRuleByName(rules, 'missing'), null)
  assert.equal(findRuleByName(rules, ''), null)
})

test('parseJsonArray / parseJsonObject accept empty text as ok-but-undefined and reject the wrong shape', () => {
  assert.deepEqual(parseJsonArray(''), { value: undefined, ok: true })
  assert.equal(parseJsonArray('{"a":1}').ok, false)
  assert.deepEqual(parseJsonArray('[1,2]'), { value: [1, 2], ok: true })

  assert.deepEqual(parseJsonObject(''), { value: undefined, ok: true })
  assert.equal(parseJsonObject('[1,2]').ok, false)
  assert.deepEqual(parseJsonObject('{"a":1}'), { value: { a: 1 }, ok: true })
})

test('buildRuleBody assembles the full write body and only sets version when given', () => {
  const spec = extractRuleSpec(good)
  const withoutVersion = buildRuleBody(spec, { queries: [], cases: [{ status: 'medium' }], options: {}, filters: [] })
  assert.equal('version' in withoutVersion, false)

  const withVersion = buildRuleBody(spec, { queries: [], cases: [{ status: 'medium' }], options: {}, filters: [] }, 7)
  assert.equal(withVersion.version, 7)
  assert.equal(withVersion.name, spec.name)
  assert.equal(withVersion.message, spec.message)
})

test('ruleToBody rebuilds a body from a captured live rule, defaulting missing collections', () => {
  const rule: DatadogRule = { name: 'R', message: 'M', type: 'log_detection', isEnabled: false }
  const body = ruleToBody(rule, 3)
  assert.equal(body.name, 'R')
  assert.equal(body.isEnabled, false)
  assert.deepEqual(body.queries, [])
  assert.deepEqual(body.options, {})
  assert.equal(body.version, 3)
})

test('deepSubsetEqual matches a declared subset even when the live object carries extra keys', () => {
  const expected = [{ status: 'medium', condition: 'a > 0' }]
  const actualWithExtras = [{ status: 'medium', condition: 'a > 0', name: '', notifications: [] }]
  assert.equal(deepSubsetEqual(expected, actualWithExtras), true)
})

test('deepSubsetEqual detects a changed declared value and a changed array length', () => {
  assert.equal(deepSubsetEqual([{ status: 'medium' }], [{ status: 'high' }]), false)
  assert.equal(deepSubsetEqual([{ status: 'medium' }], []), false)
})

test('stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
})
