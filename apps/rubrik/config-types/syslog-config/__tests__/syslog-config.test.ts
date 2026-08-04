import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildSyslogBody,
  currentSyslogConfig,
  normalizeProtocol,
  normalizePort,
  summarizeSyslog,
  syslogConfigsEqual,
  syslogConfigsFromList,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Rubrik CDM REST API via
 * node:https inside rubrikApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared.ts builders, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `item-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { hostname: 'siem.example.com', protocol: 'UDP', port: 514 }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing hostname', async () => {
  const res = await validate(ctxOf([{ ...good, hostname: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_HOSTNAME'))
})

test('validate rejects an out-of-range port', async () => {
  const res = await validate(ctxOf([{ ...good, port: 70000 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PORT'))
})

test('validate errors when there is no item', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects more than one declared target (singleton)', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'SINGLETON'))
})

test('validate accepts a well-formed syslog target', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- normalizers --------------------------------------------------------------

test('normalizeProtocol upper-cases and falls back to UDP', () => {
  assert.equal(normalizeProtocol('tcp'), 'TCP')
  assert.equal(normalizeProtocol('bogus'), 'UDP')
  assert.equal(normalizeProtocol(undefined), 'UDP')
})

test('normalizePort accepts a valid range and falls back to 514', () => {
  assert.equal(normalizePort(6514), 6514)
  assert.equal(normalizePort(0), 514)
  assert.equal(normalizePort(-1), 514)
  assert.equal(normalizePort(999999), 514)
})

// --- buildSyslogBody ------------------------------------------------------------

test('buildSyslogBody normalizes hostname, protocol and port', () => {
  const body = buildSyslogBody({ hostname: '  siem.example.com  ', protocol: 'tcp', port: '601' })
  assert.deepEqual(body, { hostname: 'siem.example.com', protocol: 'TCP', port: 601 })
})

// --- list parsing ---------------------------------------------------------------

test('syslogConfigsFromList unwraps the { data } envelope and bare arrays', () => {
  assert.equal(syslogConfigsFromList({ data: [{ hostname: 'a' }], total: 1 }).length, 1)
  assert.equal(syslogConfigsFromList([{ hostname: 'b' }]).length, 1)
  assert.equal(syslogConfigsFromList(null).length, 0)
})

test('currentSyslogConfig returns the first (only) entry or null', () => {
  assert.equal(currentSyslogConfig({ data: [{ hostname: 'a' }] })?.hostname, 'a')
  assert.equal(currentSyslogConfig({ data: [] }), null)
})

// --- drift summary + equality -----------------------------------------------------

test('summarizeSyslog flattens fields for comparison', () => {
  const s = summarizeSyslog({ hostname: 'siem.example.com', protocol: 'udp', port: 514 })
  assert.deepEqual(s, { hostname: 'siem.example.com', protocol: 'UDP', port: '514' })
})

test('syslogConfigsEqual compares hostname/protocol/port and handles absence', () => {
  assert.equal(syslogConfigsEqual(null, null), true)
  assert.equal(syslogConfigsEqual(null, { hostname: 'a', protocol: 'UDP', port: 514 }), false)
  assert.equal(
    syslogConfigsEqual({ hostname: 'a', protocol: 'UDP', port: 514 }, { hostname: 'a', protocol: 'udp', port: 514 }),
    true,
  )
})
