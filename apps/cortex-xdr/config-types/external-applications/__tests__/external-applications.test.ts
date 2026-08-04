import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildApplicationBody,
  findApplication,
  applicationsFromResponse,
  applicationFromResponse,
  isValidConnectionConfig,
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
  name: 'SOC Webhook',
  application_type: 'webhook',
  connection_config: '{"url":"https://soc.example.com/hook","headers":{"Authorization":"Bearer x"}}',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed external application', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown application type', async () => {
  const res = await validate(ctxOf([{ ...good, application_type: 'pagerduty' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_APPLICATION_TYPE'))
})

test('validate rejects invalid connection_config JSON', async () => {
  const res = await validate(ctxOf([{ ...good, connection_config: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONNECTION_CONFIG'))
})

test('validate warns on empty connection_config', async () => {
  const res = await validate(ctxOf([{ ...good, connection_config: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_CONNECTION_CONFIG'))
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

test('buildApplicationBody parses connection_config JSON', () => {
  const body = buildApplicationBody(good)
  assert.equal(body.name, 'SOC Webhook')
  assert.deepEqual(body.connection_config, { url: 'https://soc.example.com/hook', headers: { Authorization: 'Bearer x' } })
})

test('buildApplicationBody throws on invalid connection_config JSON', () => {
  assert.throws(() => buildApplicationBody({ ...good, connection_config: '{not json' }))
})

test('isValidConnectionConfig tolerates blank and rejects malformed JSON', () => {
  assert.equal(isValidConnectionConfig(''), true)
  assert.equal(isValidConnectionConfig('{"a":1}'), true)
  assert.equal(isValidConnectionConfig('[1,2]'), false)
  assert.equal(isValidConnectionConfig('{a:1}'), false)
})

test('findApplication matches case-insensitively on name', () => {
  const live = [{ name: 'SOC WEBHOOK', application_id: 42 }]
  const match = findApplication(live, 'soc webhook')
  assert.ok(match)
  assert.equal(match?.application_id, 42)
})

test('applicationsFromResponse unwraps { data: [...] } and bare arrays', () => {
  assert.equal(applicationsFromResponse([{ name: 'a' }]).length, 1)
  assert.equal(applicationsFromResponse({ data: [{ name: 'b' }, { name: 'c' }] }).length, 2)
  assert.equal(applicationsFromResponse(null).length, 0)
})

test('applicationFromResponse unwraps a single { data: {...} }', () => {
  const app = applicationFromResponse({ data: { application_id: 7, application_type: 'webhook' } })
  assert.equal(app?.application_id, 7)
  assert.equal(applicationFromResponse(null), null)
})

test('normalizeName trims and lowercases', () => {
  assert.equal(normalizeName('  SOC Webhook  '), 'soc webhook')
})
