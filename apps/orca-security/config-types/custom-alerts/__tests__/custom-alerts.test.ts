import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildAlertBody, normalizeBool, normalizeScore, priorRuleId, type AlertRollbackEntry } from '../_shared'
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

const good = {
  name: 'Public EC2 without required tag',
  description: 'Flags internet-facing EC2 instances missing an owner tag',
  category: 'Best practices',
  orcaScore: 7,
  contextScore: true,
  enabled: true,
  rule: 'AwsEc2Instance with (PublicIpAddress)',
}

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed alert', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing Sonar query', async () => {
  const res = await validate(ctxOf([{ ...good, rule: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_RULE'))
})

test('validate rejects an unknown category', async () => {
  const res = await validate(ctxOf([{ ...good, category: 'Nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CATEGORY'))
})

test('validate rejects an out-of-range score', async () => {
  const res = await validate(ctxOf([{ ...good, orcaScore: 42 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SCORE'))
})

test('validate rejects a missing score', async () => {
  const res = await validate(ctxOf([{ ...good, orcaScore: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCORE'))
})

test('validate warns on a duplicate alert name', async () => {
  const res = await validate(ctxOf([good, { ...good, rule: 'AwsS3Bucket' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ---------------------------------------------------------

test('buildAlertBody maps canvas fields to the Orca payload', () => {
  const body = buildAlertBody(good)
  assert.equal(body.name, good.name)
  assert.equal(body.details, good.description)
  assert.equal(body.category, 'Best practices')
  assert.equal(body.orca_score, 7)
  assert.equal(body.context_score, true)
  assert.equal(body.enabled, true)
  assert.equal(body.rule, good.rule)
})

test('normalizeBool coerces strings and falls back', () => {
  assert.equal(normalizeBool('false'), false)
  assert.equal(normalizeBool('0'), false)
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool(undefined, true), true)
  assert.equal(normalizeBool('', false), false)
})

test('normalizeScore clamps to the 1..10 range', () => {
  assert.equal(normalizeScore(5), 5)
  assert.equal(normalizeScore(0), 1)
  assert.equal(normalizeScore(99), 10)
  assert.equal(normalizeScore('8'), 8)
  assert.equal(normalizeScore('nope', 5), 5)
})

test('priorRuleId matches by stable item id first, then by name', () => {
  const previous: AlertRollbackEntry[] = [
    { itemId: 'i0', name: 'Old name', ruleId: 'rule-1', existed: false, prior: null },
    { itemId: 'i1', name: 'Second', ruleId: 'rule-2', existed: true, prior: null },
  ]
  // Renamed item (same id) still resolves — supports rename.
  assert.equal(priorRuleId(previous, 'i0', 'Renamed'), 'rule-1')
  // Unknown id falls back to a name match.
  assert.equal(priorRuleId(previous, 'zzz', 'Second'), 'rule-2')
  // No match at all.
  assert.equal(priorRuleId(previous, 'zzz', 'Nothing'), null)
  assert.equal(priorRuleId(undefined, 'i0', 'x'), null)
})
