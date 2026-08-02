import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import validate from '../validate'
import { normalizeEnabled, rulesFromResponse, findRule, readRuleFields, ruleParams, ruleIdOf } from '../_shared'

/**
 * The deploy/rollback/drift handlers apply over the Cloud WAF v1 API via fetch
 * inside impervaApi, which is impractical to mock here. Tests focus on validate.ts
 * and the pure _shared helpers (network-free).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  siteId: '123456',
  name: 'Block China',
  action: 'RULE_ACTION_BLOCK',
  filter: 'CountryCode == "CN"',
  enabled: 'enabled',
}

// --- validate ---------------------------------------------------------------

test('validate accepts a good ACL rule', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects a missing site ID', async () => {
  const res = await validate(ctxOf([{ ...good, siteId: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SITE_ID'))
})

test('validate rejects a non-numeric site ID', async () => {
  const res = await validate(ctxOf([{ ...good, siteId: 'abc' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SITE_ID'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unsupported action', async () => {
  const res = await validate(ctxOf([{ ...good, action: 'RULE_ACTION_REDIRECT' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION'))
})

test('validate accepts every supported security action', async () => {
  const actions = [
    'RULE_ACTION_BLOCK',
    'RULE_ACTION_ALERT',
    'RULE_ACTION_BLOCK_USER',
    'RULE_ACTION_BLOCK_IP',
    'RULE_ACTION_RETRY',
    'RULE_ACTION_INTRUSIVE_HTML',
    'RULE_ACTION_CAPTCHA',
  ]
  for (const action of actions) {
    const res = await validate(ctxOf([{ ...good, action }]))
    assert.equal(res.valid, true, `expected ${action} to be valid: ${JSON.stringify(res.errors)}`)
  }
})

test('validate warns on an empty filter (rule runs on every request)', async () => {
  const res = await validate(ctxOf([{ ...good, filter: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_FILTER'))
})

test('validate warns on a duplicate (site, name) pair — case-insensitive', async () => {
  const res = await validate(ctxOf([good, { ...good, name: 'block china' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate allows the same name on different sites', async () => {
  const res = await validate(ctxOf([good, { ...good, siteId: '999999' }]))
  assert.equal(res.valid, true)
  assert.ok(!res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('normalizeEnabled coerces strings/numbers/booleans, defaulting to enabled', () => {
  assert.equal(normalizeEnabled('enabled'), true)
  assert.equal(normalizeEnabled('disabled'), false)
  assert.equal(normalizeEnabled('false'), false)
  assert.equal(normalizeEnabled(0), false)
  assert.equal(normalizeEnabled(1), true)
  assert.equal(normalizeEnabled(true), true)
  assert.equal(normalizeEnabled(''), true)
})

test('rulesFromResponse unwraps the v1 list envelope in every tolerated shape', () => {
  assert.deepEqual(rulesFromResponse({ res: 0, incap_rules: [{ name: 'a' }] }), [{ name: 'a' }])
  assert.deepEqual(rulesFromResponse({ res: 0, rules: [{ name: 'b' }] }), [{ name: 'b' }])
  assert.deepEqual(rulesFromResponse({ res: 0, incap_rules: { All: [{ name: 'c' }] } }), [{ name: 'c' }])
  assert.deepEqual(rulesFromResponse([{ name: 'd' }]), [{ name: 'd' }])
  assert.deepEqual(rulesFromResponse({ res: 0 }), [])
  assert.deepEqual(rulesFromResponse(null), [])
})

test('findRule matches by name case-insensitively', () => {
  const rules = [{ name: 'Alpha', rule_id: 1 }, { name: 'Beta', rule_id: 2 }]
  assert.equal(findRule(rules, 'beta')?.rule_id, 2)
  assert.equal(findRule(rules, 'missing'), null)
})

test('ruleIdOf prefers rule_id then id', () => {
  assert.equal(ruleIdOf({ rule_id: 5 }), 5)
  assert.equal(ruleIdOf({ id: 7 }), 7)
  assert.equal(ruleIdOf({ name: 'x' }), null)
})

test('readRuleFields normalizes an item into a rule shape', () => {
  assert.deepEqual(readRuleFields(good), {
    siteId: '123456',
    name: 'Block China',
    action: 'RULE_ACTION_BLOCK',
    filter: 'CountryCode == "CN"',
    enabled: true,
  })
})

test('ruleParams omits an empty filter and stringifies enabled', () => {
  assert.deepEqual(ruleParams(readRuleFields(good)), {
    name: 'Block China',
    action: 'RULE_ACTION_BLOCK',
    enabled: 'true',
    filter: 'CountryCode == "CN"',
  })
  assert.deepEqual(ruleParams(readRuleFields({ ...good, filter: '', enabled: 'disabled' })), {
    name: 'Block China',
    action: 'RULE_ACTION_BLOCK',
    enabled: 'false',
  })
})
