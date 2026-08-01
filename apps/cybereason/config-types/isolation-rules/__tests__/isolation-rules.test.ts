import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildIsolationBody,
  ruleIdentity,
  rulesFromResponse,
  indexByIdentity,
  liveRuleIdentity,
  normalizePort,
  normalizeBool,
  isValidIpv4,
  createdRuleId,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy / rollback / drift / health apply over the Cybereason REST API via
 * node:https, which is impractical to mock here. Tests focus on validate.ts and
 * the pure _shared helpers (identity + body building + response parsing) — all
 * network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.ipAddressString ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { ipAddressString: '10.0.0.1', direction: 'ALL', port: 0, blocking: true }

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed rule', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a rule with a blank port', async () => {
  const res = await validate(ctxOf([{ ipAddressString: '10.0.0.2', direction: 'INCOMING', port: '', blocking: false }]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects a missing IP', async () => {
  const res = await validate(ctxOf([{ ...good, ipAddressString: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_IP'))
})

test('validate rejects a malformed IPv4', async () => {
  const res = await validate(ctxOf([{ ...good, ipAddressString: '999.1.1.1' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_IP'))
})

test('validate rejects an unknown direction', async () => {
  const res = await validate(ctxOf([{ ...good, direction: 'SIDEWAYS' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DIRECTION'))
})

test('validate rejects an out-of-range port', async () => {
  const res = await validate(ctxOf([{ ...good, port: 99999 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PORT'))
})

test('validate warns on a duplicate composite identity', async () => {
  const res = await validate(ctxOf([good, { ...good, blocking: false }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_RULE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('isValidIpv4 enforces dotted-quad shape', () => {
  assert.equal(isValidIpv4('10.0.0.1'), true)
  assert.equal(isValidIpv4('256.0.0.1'), false)
  assert.equal(isValidIpv4('nope'), false)
})

test('normalizePort maps blank to empty, keeps ints, drops junk', () => {
  assert.equal(normalizePort(''), '')
  assert.equal(normalizePort(undefined), '')
  assert.equal(normalizePort(0), 0)
  assert.equal(normalizePort('443'), 443)
  assert.equal(normalizePort('abc'), '')
})

test('normalizeBool coerces common truthy strings', () => {
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool('on'), true)
  assert.equal(normalizeBool(false), false)
  assert.equal(normalizeBool(undefined), false)
})

test('ruleIdentity builds the ip|direction|port composite (case + default normalized)', () => {
  assert.equal(ruleIdentity({ ipAddressString: '10.0.0.1', direction: 'all', port: 0 }), '10.0.0.1|ALL|0')
  assert.equal(ruleIdentity({ ipAddressString: '10.0.0.1', direction: '', port: '' }), '10.0.0.1|ALL|')
})

test('buildIsolationBody creates with ruleId null and no lastUpdated', () => {
  const body = buildIsolationBody(good, null)
  assert.equal(body.ruleId, null)
  assert.equal(body.ipAddressString, '10.0.0.1')
  assert.equal(body.port, 0)
  assert.equal(body.blocking, true)
  assert.equal(body.direction, 'ALL')
  assert.equal('lastUpdated' in body, false)
})

test('buildIsolationBody update carries the live ruleId + lastUpdated', () => {
  const existing = { ruleId: 'r-9', ipAddressString: '10.0.0.1', port: 0, blocking: false, direction: 'ALL', lastUpdated: 1525594605852 }
  const body = buildIsolationBody({ ...good, blocking: true }, existing)
  assert.equal(body.ruleId, 'r-9')
  assert.equal(body.lastUpdated, 1525594605852)
  assert.equal(body.blocking, true)
})

test('rulesFromResponse unwraps a bare array and wrapped envelopes', () => {
  assert.equal(rulesFromResponse(JSON.stringify([{ ruleId: 'a' }])).length, 1)
  assert.equal(rulesFromResponse(JSON.stringify({ rules: [{ ruleId: 'b' }] })).length, 1)
  assert.equal(rulesFromResponse(JSON.stringify({ isolationRules: [{ ruleId: 'c' }, { ruleId: 'd' }] })).length, 2)
  assert.equal(rulesFromResponse('not json').length, 0)
})

test('indexByIdentity keys live rules by their composite identity', () => {
  const rules = [{ ruleId: 'a', ipAddressString: '10.0.0.1', direction: 'ALL', port: 0 }]
  const idx = indexByIdentity(rules)
  assert.ok(idx.get('10.0.0.1|ALL|0'))
  assert.equal(liveRuleIdentity(rules[0]), '10.0.0.1|ALL|0')
})

test('createdRuleId reads ruleId from a create response', () => {
  assert.equal(createdRuleId(JSON.stringify({ ruleId: 'new-1' })), 'new-1')
  assert.equal(createdRuleId('not json'), '')
})
