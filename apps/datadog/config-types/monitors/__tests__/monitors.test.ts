import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildMonitorBody,
  deepSubsetEqual,
  extractMonitorSpec,
  findMonitorByName,
  monitorKey,
  monitorToBody,
  parseJsonObject,
  parsePriority,
  sameTagSet,
  stableStringify,
  type DatadogMonitor,
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
  name: 'High CPU usage',
  type: 'metric alert',
  query: 'avg(last_5m):avg:system.cpu.user{*} > 80',
  message: 'CPU is high on {{host.name}}',
  priority: 3,
  tags: ['team:security'],
  options: JSON.stringify({ notify_no_data: false, renotify_interval: 0, thresholds: { critical: 80, warning: 60 } }),
}

// --- validate ------------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed monitor', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.equal(res.warnings.length, 0)
})

test('validate rejects missing name/type/query', async () => {
  const res = await validate(ctxOf([{ ...good, name: '', type: '', query: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TYPE'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_QUERY'))
})

test('validate warns (does not error) on an unrecognized monitor type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'made-up alert' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNRECOGNIZED_TYPE'))
})

test('validate rejects an out-of-range priority', async () => {
  const res = await validate(ctxOf([{ ...good, priority: 9 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PRIORITY'))
})

test('validate accepts a blank priority', async () => {
  const res = await validate(ctxOf([{ ...good, priority: '' }]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects malformed options JSON and wrong sub-field types', async () => {
  const bad = await validate(ctxOf([{ ...good, options: '{not json' }]))
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((e) => e.code === 'INVALID_OPTIONS_JSON'))

  const wrongTypes = await validate(
    ctxOf([{ ...good, options: JSON.stringify({ notify_no_data: 'yes', renotify_interval: '5', thresholds: 'bad' }) }]),
  )
  assert.equal(wrongTypes.valid, false)
  assert.equal(wrongTypes.errors.filter((e) => e.code === 'INVALID_OPTION_TYPE').length, 3)
})

test('validate rejects a duplicate monitor name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, name: good.name.toUpperCase() }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

// --- _shared helpers -------------------------------------------------------------

test('extractMonitorSpec trims fields and reads a numeric priority', () => {
  const spec = extractMonitorSpec(good)
  assert.equal(spec.name, 'High CPU usage')
  assert.equal(spec.priorityRaw, '3')
  assert.deepEqual(spec.tags, ['team:security'])
})

test('monitorKey normalizes case and whitespace', () => {
  assert.equal(monitorKey('  High CPU '), 'high cpu')
})

test('findMonitorByName matches case-insensitively', () => {
  const monitors: DatadogMonitor[] = [{ id: 1, name: 'High CPU' }, { id: 2, name: 'Other' }]
  assert.equal(findMonitorByName(monitors, 'high cpu')?.id, 1)
  assert.equal(findMonitorByName(monitors, 'missing'), null)
})

test('parsePriority: blank is undefined, a number parses, garbage is NaN', () => {
  assert.equal(parsePriority(''), undefined)
  assert.equal(parsePriority('3'), 3)
  assert.ok(Number.isNaN(parsePriority('not-a-number')))
})

test('parseJsonObject accepts empty text as ok-but-undefined and rejects non-objects', () => {
  assert.deepEqual(parseJsonObject(''), { value: undefined, ok: true })
  assert.equal(parseJsonObject('[1,2]').ok, false)
  assert.deepEqual(parseJsonObject('{"a":1}'), { value: { a: 1 }, ok: true })
})

test('buildMonitorBody only sets priority when defined', () => {
  const spec = extractMonitorSpec(good)
  const withPriority = buildMonitorBody(spec, {}, 3)
  assert.equal(withPriority.priority, 3)

  const withoutPriority = buildMonitorBody(spec, {}, undefined)
  assert.equal('priority' in withoutPriority, false)
})

test('monitorToBody rebuilds a body from a captured live monitor, defaulting missing fields', () => {
  const monitor: DatadogMonitor = { name: 'M', type: 'metric alert', query: 'q' }
  const body = monitorToBody(monitor)
  assert.equal(body.name, 'M')
  assert.deepEqual(body.tags, [])
  assert.deepEqual(body.options, {})
  assert.equal('priority' in body, false)
})

test('sameTagSet is order-insensitive', () => {
  assert.equal(sameTagSet(['a', 'b'], ['b', 'a']), true)
  assert.equal(sameTagSet(['a'], ['a', 'b']), false)
})

test('deepSubsetEqual matches a declared subset even with extra live keys', () => {
  assert.equal(deepSubsetEqual({ notify_no_data: false }, { notify_no_data: false, silenced: {} }), true)
})

test('stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
})
