import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildNotificationRuleBody,
  buildForwardSource,
  findRule,
  rulesFromResponse,
  ruleFromResponse,
  isValidFilterJson,
  normalizeName,
} from '../_shared'
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
  name: 'Critical Alerts to SOC',
  forward_type: 'alert',
  filter: '{"severity":"critical"}',
  email_distribution_list: ['soc@example.com'],
  mail_format: 'issue',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed notification rule', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing forward_type', async () => {
  const res = await validate(ctxOf([{ ...good, forward_type: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_FORWARD_TYPE'))
})

test('validate rejects invalid filter JSON', async () => {
  const res = await validate(ctxOf([{ ...good, filter: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FILTER_JSON'))
})

test('validate rejects a rule with no forward channel', async () => {
  const res = await validate(ctxOf([{ ...good, email_distribution_list: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NO_FORWARD_CHANNEL'))
})

test('validate accepts a Slack-only channel', async () => {
  const res = await validate(ctxOf([{ ...good, email_distribution_list: [], slack_channels: ['#soc'] }]))
  assert.equal(res.valid, true)
})

test('validate accepts a Syslog-only channel', async () => {
  const res = await validate(ctxOf([{ ...good, email_distribution_list: [], syslog_integration_id: 3 }]))
  assert.equal(res.valid, true)
})

test('validate rejects legacy_alert for slack_format', async () => {
  const res = await validate(ctxOf([{ ...good, slack_format: 'legacy_alert' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SLACK_FORMAT'))
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

test('buildNotificationRuleBody parses filter JSON and builds forward_source', () => {
  const body = buildNotificationRuleBody(good)
  assert.deepEqual(body.filter, { severity: 'critical' })
  assert.deepEqual(body.forward_source?.email?.distribution_list, ['soc@example.com'])
})

test('buildNotificationRuleBody throws when filter is blank', () => {
  assert.throws(() => buildNotificationRuleBody({ ...good, filter: '' }))
})

test('buildForwardSource returns undefined with no channel configured', () => {
  assert.equal(buildForwardSource({}), undefined)
})

test('buildForwardSource builds a syslog channel from a numeric id', () => {
  const source = buildForwardSource({ syslog_integration_id: 5 })
  assert.deepEqual(source?.syslog, { id: 5 })
})

test('isValidFilterJson rejects blank and malformed JSON', () => {
  assert.equal(isValidFilterJson(''), false)
  assert.equal(isValidFilterJson('{"a":1}'), true)
  assert.equal(isValidFilterJson('{a:1}'), false)
})

test('findRule matches case-insensitively on name', () => {
  const live = [{ name: 'CRITICAL ALERTS TO SOC', rule_uuid: 'abc-123' }]
  const match = findRule(live, 'critical alerts to soc')
  assert.ok(match)
  assert.equal(match?.rule_uuid, 'abc-123')
})

test('rulesFromResponse unwraps { data: [...] } and bare arrays', () => {
  assert.equal(rulesFromResponse([{ name: 'a' }]).length, 1)
  assert.equal(rulesFromResponse({ data: [{ name: 'b' }, { name: 'c' }] }).length, 2)
  assert.equal(rulesFromResponse(null).length, 0)
})

test('ruleFromResponse unwraps a single { data: {...} }', () => {
  const rule = ruleFromResponse({ data: { rule_uuid: 'xyz' } })
  assert.equal(rule?.rule_uuid, 'xyz')
  assert.equal(ruleFromResponse(null), null)
})

test('normalizeName trims and lowercases', () => {
  assert.equal(normalizeName('  Critical Alerts  '), 'critical alerts')
})
