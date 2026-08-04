import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildCorrelationRuleFields, findCorrelationRule, correlationRulesFromReply, normalizeName } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Cortex XDR REST API via fetch,
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
  name: 'Repeated Failed Logins',
  xql_query: 'dataset = xdr_data | filter event_type = AUTH_LOGIN_FAILED | comp count() by user',
  severity: 'SEV_030_MEDIUM',
  execution_mode: 'SCHEDULED',
  simple_schedule: 'every 1 hour',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed correlation rule', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing XQL query', async () => {
  const res = await validate(ctxOf([{ ...good, xql_query: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_XQL_QUERY'))
})

test('validate rejects an unknown severity', async () => {
  const res = await validate(ctxOf([{ ...good, severity: 'SEV_050_CRITICAL' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SEVERITY'))
})

test('validate rejects an unknown execution mode', async () => {
  const res = await validate(ctxOf([{ ...good, execution_mode: 'CONTINUOUS' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EXECUTION_MODE'))
})

test('validate defaults execution_mode to SCHEDULED when blank', async () => {
  const { execution_mode: _drop, ...rest } = good
  const res = await validate(ctxOf([rest]))
  assert.equal(res.valid, true)
})

test('validate rejects an unknown drilldown timeframe', async () => {
  const res = await validate(ctxOf([{ ...good, drilldown_query_timeframe: 'NEVER' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DRILLDOWN_TIMEFRAME'))
})

test('validate rejects an unknown mapping strategy', async () => {
  const res = await validate(ctxOf([{ ...good, mapping_strategy: 'MANUAL' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MAPPING_STRATEGY'))
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

test('buildCorrelationRuleFields defaults is_enabled true and execution_mode SCHEDULED', () => {
  const rule = buildCorrelationRuleFields({ name: 'R', xql_query: 'x', severity: 'SEV_010_INFO' })
  assert.equal(rule.is_enabled, true)
  assert.equal(rule.execution_mode, 'SCHEDULED')
})

test('buildCorrelationRuleFields respects an explicit false is_enabled', () => {
  const rule = buildCorrelationRuleFields({ ...good, is_enabled: false })
  assert.equal(rule.is_enabled, false)
})

test('buildCorrelationRuleFields omits empty optional fields', () => {
  const rule = buildCorrelationRuleFields({ name: 'R', xql_query: 'x', severity: 'SEV_010_INFO' })
  assert.equal('description' in rule, false)
  assert.equal('suppression_fields' in rule, false)
})

test('findCorrelationRule matches case-insensitively on name', () => {
  const live = [{ name: 'REPEATED FAILED LOGINS', severity: 'SEV_020_LOW' }]
  const match = findCorrelationRule(live, 'repeated failed logins')
  assert.ok(match)
  assert.equal(match?.severity, 'SEV_020_LOW')
})

test('correlationRulesFromReply unwraps both the array and { objects } shapes', () => {
  assert.equal(correlationRulesFromReply([{ name: 'a' }]).length, 1)
  assert.equal(correlationRulesFromReply({ objects: [{ name: 'b' }, { name: 'c' }] }).length, 2)
  assert.equal(correlationRulesFromReply(null).length, 0)
})

test('normalizeName trims and lowercases', () => {
  assert.equal(normalizeName('  Rule Name  '), 'rule name')
})
