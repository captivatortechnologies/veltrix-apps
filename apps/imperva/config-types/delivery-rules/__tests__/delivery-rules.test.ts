import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import validate from '../validate'
import { classifyDelivery, declaredDeliveryValues, liveDeliveryValues, readDeliveryFields } from '../_shared'

/**
 * The deploy/rollback/drift handlers call the Cloud WAF v1 API via fetch, which is
 * impractical to mock here. Tests cover validate.ts and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const redirect = { siteId: '123456', name: 'Old to new', action: 'RULE_ACTION_REDIRECT', filter: 'Full-URL == "/old"', from: 'https://a.com/old', to: 'https://a.com/new', response_code: '301' }
const simplifiedRedirect = { siteId: '123456', name: 'Simple redirect', action: 'RULE_ACTION_SIMPLIFIED_REDIRECT', to: 'https://a.com/new', response_code: '302' }
const rewriteUrl = { siteId: '123456', name: 'Rewrite path', action: 'RULE_ACTION_REWRITE_URL', filter: 'Full-URL contains "/api"', from: '/api/*', to: '/v2/*' }
const rewriteHeader = { siteId: '123456', name: 'Rewrite header', action: 'RULE_ACTION_REWRITE_HEADER', filter: '', rewrite_name: 'X-Custom', from: '', to: 'value1', add_missing: 'true', rewrite_existing: 'true' }
const deleteCookie = { siteId: '123456', name: 'Delete cookie', action: 'RULE_ACTION_DELETE_COOKIE', filter: '', rewrite_name: 'session_debug' }
const forwardDc = { siteId: '123456', name: 'Forward to DC', action: 'RULE_ACTION_FORWARD_TO_DC', filter: 'Full-URL contains "/static"', dc_id: '4242' }
const forwardPort = { siteId: '123456', name: 'Forward to port', action: 'RULE_ACTION_FORWARD_TO_PORT', filter: '', port_forwarding_context: 'Use Port Value', port_forwarding_value: '8443' }
const rate = { siteId: '123456', name: 'Rate limit login', action: 'RULE_ACTION_RATE', filter: 'Full-URL == "/login"', rate_context: 'IP', rate_interval: '60' }
const customError = { siteId: '123456', name: 'Custom 403', action: 'RULE_ACTION_CUSTOM_ERROR_RESPONSE', filter: 'Full-URL contains "/blocked"', response_code: '403', error_type: 'error.type.all', error_response_format: 'json', error_response_data: '{"errorCode":"$RR_CODE$"}' }
const responseCode = { siteId: '123456', name: 'Rewrite status', action: 'RULE_ACTION_RESPONSE_REWRITE_RESPONSE_CODE', filter: '', response_code: '200' }

// --- validate ---------------------------------------------------------------

test('validate accepts one good rule of every delivery kind', async () => {
  for (const good of [redirect, simplifiedRedirect, rewriteUrl, rewriteHeader, deleteCookie, forwardDc, forwardPort, rate, customError, responseCode]) {
    const res = await validate(ctxOf([good]))
    assert.equal(res.valid, true, `${good.action}: ${JSON.stringify(res.errors)}`)
  }
})

test('validate rejects a missing / non-numeric site ID', async () => {
  assert.ok((await validate(ctxOf([{ ...redirect, siteId: '' }]))).errors.some((e) => e.code === 'EMPTY_SITE_ID'))
  assert.ok((await validate(ctxOf([{ ...redirect, siteId: 'x' }]))).errors.some((e) => e.code === 'INVALID_SITE_ID'))
})

test('validate rejects an unsupported action (a security action belongs to acl-rules)', async () => {
  const res = await validate(ctxOf([{ ...redirect, action: 'RULE_ACTION_BLOCK' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION'))
})

test('validate requires from/to for a redirect and an invalid response code', async () => {
  assert.ok((await validate(ctxOf([{ ...redirect, from: '' }]))).errors.some((e) => e.code === 'EMPTY_FROM'))
  assert.ok((await validate(ctxOf([{ ...redirect, to: '' }]))).errors.some((e) => e.code === 'EMPTY_TO'))
  assert.ok((await validate(ctxOf([{ ...redirect, response_code: '299' }]))).errors.some((e) => e.code === 'INVALID_RESPONSE_CODE'))
})

test('validate does not warn on an empty filter for simplified redirect', async () => {
  const res = await validate(ctxOf([simplifiedRedirect]))
  assert.ok(!res.warnings.some((w) => w.code === 'EMPTY_FILTER'))
})

test('validate warns on an empty filter for every other action', async () => {
  const res = await validate(ctxOf([{ ...redirect, filter: '' }]))
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_FILTER'))
})

test('validate requires a header/cookie name to rewrite or delete', async () => {
  assert.ok((await validate(ctxOf([{ ...rewriteHeader, rewrite_name: '' }]))).errors.some((e) => e.code === 'EMPTY_REWRITE_NAME'))
  assert.ok((await validate(ctxOf([{ ...deleteCookie, rewrite_name: '' }]))).errors.some((e) => e.code === 'EMPTY_REWRITE_NAME'))
})

test('validate requires a data center id to forward to a DC', async () => {
  assert.ok((await validate(ctxOf([{ ...forwardDc, dc_id: '' }]))).errors.some((e) => e.code === 'EMPTY_DC_ID'))
})

test('validate requires a valid port forwarding context', async () => {
  assert.ok((await validate(ctxOf([{ ...forwardPort, port_forwarding_context: 'bogus' }]))).errors.some((e) => e.code === 'INVALID_PORT_FORWARDING_CONTEXT'))
})

test('validate enforces the rate interval bounds (multiple of 10, 10-300)', async () => {
  assert.ok((await validate(ctxOf([{ ...rate, rate_interval: '15' }]))).errors.some((e) => e.code === 'INVALID_RATE_INTERVAL'))
  assert.ok((await validate(ctxOf([{ ...rate, rate_interval: '5' }]))).errors.some((e) => e.code === 'INVALID_RATE_INTERVAL'))
  assert.ok((await validate(ctxOf([{ ...rate, rate_interval: '310' }]))).errors.some((e) => e.code === 'INVALID_RATE_INTERVAL'))
})

test('validate rejects an unsupported custom error response code / type / format', async () => {
  assert.ok((await validate(ctxOf([{ ...customError, response_code: '999' }]))).errors.some((e) => e.code === 'INVALID_RESPONSE_CODE'))
  assert.ok((await validate(ctxOf([{ ...customError, error_type: 'bogus' }]))).errors.some((e) => e.code === 'INVALID_ERROR_TYPE'))
  assert.ok((await validate(ctxOf([{ ...customError, error_response_format: 'yaml' }]))).errors.some((e) => e.code === 'INVALID_ERROR_RESPONSE_FORMAT'))
})

test('validate warns on a duplicate (site, name) pair and allows the same name on another site', async () => {
  assert.ok((await validate(ctxOf([redirect, { ...redirect, name: redirect.name.toLowerCase() }]))).warnings.some((w) => w.code === 'DUPLICATE_NAME'))
  assert.ok(!(await validate(ctxOf([redirect, { ...redirect, siteId: '999' }]))).warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('classifyDelivery maps every supported action, and rejects security actions', () => {
  assert.equal(classifyDelivery('RULE_ACTION_REDIRECT'), 'redirect')
  assert.equal(classifyDelivery('RULE_ACTION_REWRITE_HEADER'), 'rewrite_header_cookie')
  assert.equal(classifyDelivery('RULE_ACTION_DELETE_COOKIE'), 'delete_header_cookie')
  assert.equal(classifyDelivery('RULE_ACTION_RATE'), 'rate')
  assert.equal(classifyDelivery('RULE_ACTION_CUSTOM_ERROR_RESPONSE'), 'custom_error')
  assert.equal(classifyDelivery('RULE_ACTION_BLOCK'), null)
  assert.equal(classifyDelivery('RULE_ACTION_WAF_OVERRIDE'), null)
})

test('declaredDeliveryValues includes only the params the action kind uses', () => {
  const params = declaredDeliveryValues(readDeliveryFields(redirect))
  assert.deepEqual(params, {
    name: 'Old to new',
    action: 'RULE_ACTION_REDIRECT',
    enabled: 'true',
    filter: 'Full-URL == "/old"',
    response_code: '301',
    from: 'https://a.com/old',
    to: 'https://a.com/new',
  })
  const rateParams = declaredDeliveryValues(readDeliveryFields(rate))
  assert.deepEqual(rateParams, {
    name: 'Rate limit login',
    action: 'RULE_ACTION_RATE',
    enabled: 'true',
    filter: 'Full-URL == "/login"',
    rate_context: 'IP',
    rate_interval: '60',
  })
})

test('liveDeliveryValues reads back only the keys relevant to the kind', () => {
  const live = liveDeliveryValues({ from: 'https://a.com/old', to: 'https://a.com/new', response_code: 301, dc_id: 99 }, 'redirect')
  assert.deepEqual(live, { from: 'https://a.com/old', to: 'https://a.com/new', response_code: '301' })
})
