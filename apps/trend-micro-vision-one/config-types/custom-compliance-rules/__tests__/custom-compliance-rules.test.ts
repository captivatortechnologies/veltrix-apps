import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildCustomRuleBody,
  extractCustomRuleFields,
  findRuleByName,
  normalizeName,
  parseJsonArray,
  readStringArray,
  ruleIdFromResponse,
  rulesFromResponse,
  stripRuleId,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Vision One REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (identity matching + body building) — both network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'S3 buckets must enable encryption',
  description: 'Flags any S3 bucket without default encryption enabled.',
  categories: ['security'],
  riskLevel: 'HIGH',
  provider: 'aws',
  service: 'S3',
  resourceType: 'bucket',
  enabled: true,
  attributes: JSON.stringify([{ name: 'encryption', path: '$.ServerSideEncryptionConfiguration' }]),
  eventRules: JSON.stringify([{ conditions: { field: 'encryption', operator: 'exists' }, description: 'Encryption must be configured' }]),
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed custom rule', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an empty categories list', async () => {
  const res = await validate(ctxOf([{ ...good, categories: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CATEGORIES'))
})

test('validate rejects an unknown category', async () => {
  const res = await validate(ctxOf([{ ...good, categories: ['not-a-category'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CATEGORY'))
})

test('validate rejects an unknown risk level', async () => {
  const res = await validate(ctxOf([{ ...good, riskLevel: 'CATASTROPHIC' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RISK_LEVEL'))
})

test('validate rejects an unknown provider', async () => {
  const res = await validate(ctxOf([{ ...good, provider: 'ibmCloud' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROVIDER'))
})

test('validate rejects malformed attributes JSON', async () => {
  const res = await validate(ctxOf([{ ...good, attributes: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ATTRIBUTES_JSON'))
})

test('validate rejects an empty attributes array', async () => {
  const res = await validate(ctxOf([{ ...good, attributes: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ATTRIBUTES'))
})

test('validate rejects an empty eventRules array', async () => {
  const res = await validate(ctxOf([{ ...good, eventRules: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_EVENT_RULES'))
})

test('validate warns when an attribute is missing name/path', async () => {
  const res = await validate(ctxOf([{ ...good, attributes: JSON.stringify([{ foo: 'bar' }]) }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'ATTRIBUTE_SHAPE_UNVERIFIED'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ----------------------------------------------------------

test('readStringArray accepts an array or a comma/newline separated string', () => {
  assert.deepEqual(readStringArray(['security', 'security', 'reliability']), ['security', 'reliability'])
  assert.deepEqual(readStringArray('security,reliability'), ['security', 'reliability'])
  assert.deepEqual(readStringArray(undefined), [])
})

test('parseJsonArray parses a JSON array and rejects non-array JSON', () => {
  assert.deepEqual(parseJsonArray('[1,2]', 'x').value, [1, 2])
  assert.equal(parseJsonArray('{"a":1}', 'x').value, null)
  assert.equal(parseJsonArray('not json', 'x').error?.includes('not valid JSON'), true)
  assert.deepEqual(parseJsonArray('', 'x'), { value: [], error: null })
})

test('extractCustomRuleFields parses categories and enabled from raw canvas fields', () => {
  const fields = extractCustomRuleFields({ ...good, enabled: false })
  assert.deepEqual(fields.categories, ['security'])
  assert.equal(fields.enabled, false)
  assert.equal(fields.name, good.name)
})

test('buildCustomRuleBody omits optional fields when blank', () => {
  const fields = extractCustomRuleFields({ ...good, resolutionReferenceLink: '', remediationNote: '' })
  const body = buildCustomRuleBody(fields, [{ name: 'a', path: '$.a' }], [{ conditions: {} }])
  assert.equal('resolutionReferenceLink' in body, false)
  assert.equal('remediationNote' in body, false)
  assert.equal(body.name, good.name)
})

test('ruleIdFromResponse reads the id when present', () => {
  assert.equal(ruleIdFromResponse({ id: 'rule-123' }), 'rule-123')
  assert.equal(ruleIdFromResponse({}), null)
  assert.equal(ruleIdFromResponse(null), null)
})

test('stripRuleId removes only the id key', () => {
  const stripped = stripRuleId({ id: 'rule-123', name: 'x', enabled: true })
  assert.deepEqual(stripped, { name: 'x', enabled: true })
})

test('findRuleByName matches case-insensitively', () => {
  const live = [{ id: 'r1', name: 'S3 Buckets Must Enable Encryption' }]
  const match = findRuleByName(live, 'S3 buckets must enable encryption')
  assert.ok(match)
  assert.equal(match?.id, 'r1')
})

test('rulesFromResponse unwraps both the items and bare-array shapes', () => {
  assert.equal(rulesFromResponse({ items: [{ name: 'a' }, { name: 'b' }] }).length, 2)
  assert.equal(rulesFromResponse([{ name: 'c' }]).length, 1)
  assert.equal(rulesFromResponse(null).length, 0)
})

test('normalizeName trims and lowercases', () => {
  assert.equal(normalizeName('  My Rule '), 'my rule')
  assert.equal(normalizeName(undefined), '')
})
