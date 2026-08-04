import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildOrchestrationPathBody,
  EMPTY_ORCHESTRATION_PATH,
  extractServiceOrchestrationSpecs,
  findServiceId,
  parseCatchAll,
  parseOrchestrationSets,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

// These handlers apply over the PagerDuty REST API via fetch inside pagerdutyApi,
// which is impractical to mock here. Tests focus on validate.ts + the pure
// _shared helpers (parsing / extraction / body building), which are network-free.

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.service ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const SETS = '[{"id":"start","rules":[{"label":"P1 critical","actions":{"severity":"critical"}}]}]'
const good = { service: 'Payments API', active: true, sets: SETS, catch_all: '{"actions":{}}' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid service orchestration', async () => {
  const res = await validate(ctxOf([{ ...good }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a blank (optional) catch_all', async () => {
  const res = await validate(ctxOf([{ ...good, catch_all: '' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a missing service name', async () => {
  const res = await validate(ctxOf([{ ...good, service: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SERVICE'))
})

test('validate warns on a duplicate service', async () => {
  const res = await validate(ctxOf([good, { ...good, active: false }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_SERVICE'))
})

test('validate rejects missing sets', async () => {
  const res = await validate(ctxOf([{ ...good, sets: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SETS'))
})

test('validate rejects sets that parse to an empty array', async () => {
  const res = await validate(ctxOf([{ ...good, sets: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SETS'))
})

test('validate rejects a set missing an id', async () => {
  const res = await validate(ctxOf([{ ...good, sets: '[{"rules":[]}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SETS'))
})

test('validate rejects a malformed catch_all', async () => {
  const res = await validate(ctxOf([{ ...good, catch_all: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CATCH_ALL'))
})

test('parseOrchestrationSets returns typed sets for a valid array', () => {
  const parsed = parseOrchestrationSets(SETS)
  assert.equal(parsed.error, null)
  assert.equal(parsed.sets?.length, 1)
  assert.equal(parsed.sets?.[0].id, 'start')
})

test('parseOrchestrationSets flags rules that are not an array', () => {
  const parsed = parseOrchestrationSets('[{"id":"start","rules":"nope"}]')
  assert.equal(parsed.sets, null)
  assert.ok(parsed.error)
})

test('parseOrchestrationSets flags a rule that is not an object', () => {
  const parsed = parseOrchestrationSets('[{"id":"start","rules":[42]}]')
  assert.equal(parsed.sets, null)
  assert.ok(parsed.error)
})

test('parseCatchAll defaults a blank input to {"actions":{}}', () => {
  const parsed = parseCatchAll('')
  assert.equal(parsed.error, null)
  assert.deepEqual(parsed.catchAll?.actions, {})
})

test('parseCatchAll rejects an object with no actions key', () => {
  const parsed = parseCatchAll('{"foo":"bar"}')
  assert.equal(parsed.catchAll, null)
  assert.ok(parsed.error)
})

test('extractServiceOrchestrationSpecs trims service name, defaults active to true, and carries raw JSON as-is', () => {
  const specs = extractServiceOrchestrationSpecs(ctxOf([{ service: '  Payments  ', sets: SETS }]).canvas)
  assert.equal(specs[0].service, 'Payments')
  assert.equal(specs[0].active, true)
  assert.equal(specs[0].setsJson, SETS)
})

test('extractServiceOrchestrationSpecs honors an explicit active: false', () => {
  const specs = extractServiceOrchestrationSpecs(ctxOf([{ service: 'Payments', active: false, sets: SETS }]).canvas)
  assert.equal(specs[0].active, false)
})

test('buildOrchestrationPathBody wraps sets/catch_all under orchestration_path', () => {
  const body = buildOrchestrationPathBody([{ id: 'start' }], { actions: {} })
  assert.deepEqual(body, { orchestration_path: { sets: [{ id: 'start' }], catch_all: { actions: {} } } })
})

test('findServiceId resolves a service name to its id case-insensitively', () => {
  const services = [{ id: 'PS1', name: 'Payments API' }, { id: 'PS2', name: 'Web' }]
  assert.equal(findServiceId(services, 'payments api'), 'PS1')
  assert.equal(findServiceId(services, 'missing'), null)
})

test('EMPTY_ORCHESTRATION_PATH is the documented PagerDuty baseline', () => {
  assert.deepEqual(EMPTY_ORCHESTRATION_PATH, { sets: [{ id: 'start', rules: [] }], catch_all: { actions: {} } })
})
