import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import validate from '../validate'
import { exceptionParams, exceptionSignature, liveExceptionFields, readExceptionFields, ruleFamily, statusRulesFor, toList } from '../_shared'

/**
 * The deploy/rollback/drift handlers call the Cloud WAF v1 API via fetch, which is
 * impractical to mock here. Tests cover validate.ts and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.ruleId ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const sqli = { siteId: '123456', ruleId: 'api.threats.sql_injection', ips: [], urls: ['/api/search'], countries: ['CN'] }
const aclIp = { siteId: '123456', ruleId: 'api.acl.blacklisted_ips', ips: ['203.0.113.5'] }

// --- validate ---------------------------------------------------------------

test('validate accepts a good exception for a WAF rule and an ACL rule', async () => {
  for (const good of [sqli, aclIp]) {
    const res = await validate(ctxOf([good]))
    assert.equal(res.valid, true, JSON.stringify(res.errors))
  }
})

test('validate rejects a missing / non-numeric site ID', async () => {
  assert.ok((await validate(ctxOf([{ ...sqli, siteId: '' }]))).errors.some((e) => e.code === 'EMPTY_SITE_ID'))
  assert.ok((await validate(ctxOf([{ ...sqli, siteId: 'x' }]))).errors.some((e) => e.code === 'INVALID_SITE_ID'))
})

test('validate rejects an unsupported rule id', async () => {
  const res = await validate(ctxOf([{ ...sqli, ruleId: 'api.threats.unknown' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RULE_ID'))
})

test('validate requires at least one match condition', async () => {
  const res = await validate(ctxOf([{ siteId: '1', ruleId: 'api.threats.sql_injection' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONDITIONS'))
})

test('validate warns when a declared field is not supported by the chosen rule', async () => {
  // "ips" is not in sql_injection's supported param set.
  const res = await validate(ctxOf([{ ...sqli, ips: ['203.0.113.5'] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNSUPPORTED_CONDITION'))
})

test('validate warns on an exact duplicate exception for the same (site, rule)', async () => {
  const res = await validate(ctxOf([sqli, { ...sqli }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_EXCEPTION'))
})

test('validate does not warn when the same rule has two DIFFERENT conditions', async () => {
  const res = await validate(ctxOf([sqli, { ...sqli, urls: ['/api/other'] }]))
  assert.ok(!res.warnings.some((w) => w.code === 'DUPLICATE_EXCEPTION'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('ruleFamily classifies ACL vs WAF rule ids', () => {
  assert.equal(ruleFamily('api.acl.blacklisted_ips'), 'acl')
  assert.equal(ruleFamily('api.threats.sql_injection'), 'waf')
  assert.equal(ruleFamily('api.unknown'), null)
})

test('toList accepts arrays and comma/newline strings, dropping blanks', () => {
  assert.deepEqual(toList(['a', ' b ', '']), ['a', 'b'])
  assert.deepEqual(toList('a, b\nc,'), ['a', 'b', 'c'])
})

test('exceptionParams includes only the params the rule id accepts, comma-joined', () => {
  const params = exceptionParams(readExceptionFields(sqli))
  assert.deepEqual(params, { urls: '/api/search', countries: 'CN' })
})

test('exceptionSignature is order-insensitive within a field and distinguishes different conditions', () => {
  const a = readExceptionFields({ ...sqli, urls: ['/a', '/b'] })
  const b = readExceptionFields({ ...sqli, urls: ['/b', '/a'] })
  assert.equal(exceptionSignature(a), exceptionSignature(b))
  const c = readExceptionFields({ ...sqli, urls: ['/a'] })
  assert.notEqual(exceptionSignature(a), exceptionSignature(c))
})

test('statusRulesFor + liveExceptionFields navigate the /sites/status exceptions shape', () => {
  const status = {
    res: 0,
    security: {
      waf: {
        rules: [
          {
            id: 'api.threats.sql_injection',
            exceptions: [{ id: 42, values: [{ id: 'api.rule_exception_type.url', urls: [{ value: '/api/search' }] }, { id: 'api.rule_exception_type.country', geo: { countries: ['CN'] } }] }],
          },
        ],
      },
    },
  }
  const rules = statusRulesFor(status, 'waf')
  assert.equal(rules.length, 1)
  const [exception] = rules[0].exceptions ?? []
  assert.equal(exception.id, 42)
  const fields = liveExceptionFields('api.threats.sql_injection', '123456', exception)
  assert.deepEqual(fields.urls, ['/api/search'])
  assert.deepEqual(fields.countries, ['CN'])
  assert.deepEqual(statusRulesFor(null, 'waf'), [])
})
