import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildAutomationBody, normalizeStatus } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers apply over the Orca REST API via lib/orcaApi (fetch),
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Notify on public buckets',
  description: 'Slack the team when a public S3 bucket is found',
  status: 'enabled',
  businessUnits: ['bu-1'],
  sonarQuery: '{"models":["Alert"],"type":"object_set"}',
  actions: '[{"type":1,"data":{"channel":"#sec"}}]',
}

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed automation', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown status', async () => {
  const res = await validate(ctxOf([{ ...good, status: 'paused' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_STATUS'))
})

test('validate rejects a non-JSON Sonar query', async () => {
  const res = await validate(ctxOf([{ ...good, sonarQuery: 'not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SONAR_QUERY'))
})

test('validate rejects a Sonar query that is a JSON array (not an object)', async () => {
  const res = await validate(ctxOf([{ ...good, sonarQuery: '[1,2,3]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SONAR_QUERY'))
})

test('validate rejects an empty actions array', async () => {
  const res = await validate(ctxOf([{ ...good, actions: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTIONS'))
})

test('validate rejects non-JSON actions', async () => {
  const res = await validate(ctxOf([{ ...good, actions: '{oops}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTIONS'))
})

test('validate warns on a duplicate automation name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ---------------------------------------------------------

test('normalizeStatus defaults to enabled and recognises disabled', () => {
  assert.equal(normalizeStatus('enabled'), 'enabled')
  assert.equal(normalizeStatus('DISABLED'), 'disabled')
  assert.equal(normalizeStatus(''), 'enabled')
  assert.equal(normalizeStatus('nonsense'), 'enabled')
})

test('buildAutomationBody nests the Sonar query under filter and carries actions', () => {
  const body = buildAutomationBody(good, { models: ['Alert'] }, [{ type: 1 }])
  assert.equal(body.name, good.name)
  assert.equal(body.description, good.description)
  assert.equal(body.status, 'enabled')
  assert.deepEqual(body.business_units, ['bu-1'])
  assert.deepEqual(body.filter, { sonar_query: { models: ['Alert'] } })
  assert.deepEqual(body.actions, [{ type: 1 }])
})
