import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildSloBody, extractSloSpec, findSloByName, parseMonitorIds, sloKey, sloToBody, type DatadogSlo } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const metricSlo = {
  name: 'API availability',
  type: 'metric',
  numerator: 'sum:trace.http.request.hits{env:prod,!http.status_code:5*}.as_count()',
  denominator: 'sum:trace.http.request.hits{env:prod}.as_count()',
  thresholds: JSON.stringify([{ timeframe: '30d', target: 99.9 }]),
}
const monitorSlo = { name: 'Checkout uptime', type: 'monitor', monitor_ids: '12345678', thresholds: JSON.stringify([{ timeframe: '7d', target: 99 }]) }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed metric SLO and a well-formed monitor SLO', async () => {
  const m = await validate(ctxOf([metricSlo]))
  assert.equal(m.valid, true, JSON.stringify(m.errors))
  const mon = await validate(ctxOf([monitorSlo]))
  assert.equal(mon.valid, true, JSON.stringify(mon.errors))
})

test('validate warns (does not error) on time_slice, an unmodeled type', async () => {
  const res = await validate(ctxOf([{ ...metricSlo, type: 'time_slice', numerator: '', denominator: '' }]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.ok(res.warnings.some((w) => w.code === 'UNMODELED_TYPE'))
})

test('validate rejects an unsupported type', async () => {
  const res = await validate(ctxOf([{ ...metricSlo, type: 'made-up' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate requires numerator/denominator for a metric SLO', async () => {
  const res = await validate(ctxOf([{ ...metricSlo, numerator: '', denominator: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NUMERATOR'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DENOMINATOR'))
})

test('validate requires at least one monitor id for a monitor SLO', async () => {
  const res = await validate(ctxOf([{ ...monitorSlo, monitor_ids: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_MONITOR_IDS'))
})

test('validate rejects non-integer monitor ids', async () => {
  const res = await validate(ctxOf([{ ...monitorSlo, monitor_ids: 'not-an-id' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MONITOR_IDS'))
})

test('validate requires thresholds and rejects a bad timeframe/target', async () => {
  const empty = await validate(ctxOf([{ ...metricSlo, thresholds: '' }]))
  assert.equal(empty.valid, false)
  assert.ok(empty.errors.some((e) => e.code === 'EMPTY_THRESHOLDS'))

  const bad = await validate(ctxOf([{ ...metricSlo, thresholds: JSON.stringify([{ timeframe: '1d', target: 'high' }]) }]))
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((e) => e.code === 'INVALID_TIMEFRAME'))
  assert.ok(bad.errors.some((e) => e.code === 'INVALID_TARGET'))
})

test('validate rejects a duplicate SLO name (case-insensitive)', async () => {
  const res = await validate(ctxOf([metricSlo, { ...metricSlo, name: metricSlo.name.toUpperCase() }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('sloKey normalizes case and whitespace', () => {
  assert.equal(sloKey('  API Availability '), 'api availability')
})

test('findSloByName matches case-insensitively', () => {
  const slos: DatadogSlo[] = [{ id: 's1', name: 'API Availability' }]
  assert.equal(findSloByName(slos, 'api availability')?.id, 's1')
  assert.equal(findSloByName(slos, 'missing'), null)
})

test('parseMonitorIds parses a comma list of integers and rejects non-integers', () => {
  assert.deepEqual(parseMonitorIds('1, 2,3'), { ids: [1, 2, 3], ok: true })
  assert.equal(parseMonitorIds('1,not-a-number').ok, false)
  assert.deepEqual(parseMonitorIds(''), { ids: [], ok: true })
})

test('buildSloBody sets query only for metric and monitor_ids/groups only for monitor', () => {
  const metricSpec = extractSloSpec(metricSlo)
  const metricBody = buildSloBody(metricSpec, [{ timeframe: '30d', target: 99.9 }], [])
  assert.ok(metricBody.query)
  assert.equal('monitor_ids' in metricBody, false)

  const monitorSpec = extractSloSpec(monitorSlo)
  const monitorBody = buildSloBody(monitorSpec, [{ timeframe: '7d', target: 99 }], [12345678])
  assert.deepEqual(monitorBody.monitor_ids, [12345678])
  assert.equal('query' in monitorBody, false)
})

test('sloToBody rebuilds a body from a captured live SLO, defaulting missing fields', () => {
  const body = sloToBody({ name: 'S', type: 'metric', query: { numerator: 'n', denominator: 'd' } })
  assert.equal(body.name, 'S')
  assert.deepEqual(body.query, { numerator: 'n', denominator: 'd' })
  assert.deepEqual(body.thresholds, [])
})
