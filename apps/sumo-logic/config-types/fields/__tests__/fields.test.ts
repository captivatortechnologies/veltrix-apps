import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildFieldCreateBody,
  fieldsFromList,
  findField,
  isFieldEnabled,
  normalizeEnabled,
  type CustomField,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers (deploy/rollback/drift/health) apply over the Sumo Logic
 * Management API via `fetch`, which is impractical to mock here. Tests focus on
 * the pure, network-free pieces: validate.ts and _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.fieldName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { fieldName: 'client_ip', enabled: true }

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed field', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing field name', async () => {
  const res = await validate(ctxOf([{ ...good, fieldName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_FIELD_NAME'))
})

test('validate rejects a field name with illegal characters', async () => {
  const res = await validate(ctxOf([{ ...good, fieldName: 'client ip!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FIELD_NAME'))
})

test('validate warns on a duplicate field name', async () => {
  const res = await validate(ctxOf([good, { fieldName: 'client_ip', enabled: false }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_FIELD_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared ----------------------------------------------------------------

test('normalizeEnabled coerces booleans, strings and numbers', () => {
  assert.equal(normalizeEnabled(true), true)
  assert.equal(normalizeEnabled(false), false)
  assert.equal(normalizeEnabled('disabled'), false)
  assert.equal(normalizeEnabled('0'), false)
  assert.equal(normalizeEnabled('enabled'), true)
  assert.equal(normalizeEnabled(''), true)
})

test('isFieldEnabled reads the live state string', () => {
  assert.equal(isFieldEnabled({ fieldName: 'a', state: 'Enabled' }), true)
  assert.equal(isFieldEnabled({ fieldName: 'a', state: 'Disabled' }), false)
  assert.equal(isFieldEnabled({ fieldName: 'a' }), false)
  assert.equal(isFieldEnabled(null), false)
})

test('buildFieldCreateBody trims and sends only the field name', () => {
  assert.deepEqual(buildFieldCreateBody({ fieldName: '  client_ip  ', enabled: false }), { fieldName: 'client_ip' })
})

test('fieldsFromList unwraps the { data: [...] } envelope and bare arrays', () => {
  const fields: CustomField[] = [{ fieldId: '1', fieldName: 'a', dataType: 'String', state: 'Enabled' }]
  assert.deepEqual(fieldsFromList({ data: fields }), fields)
  assert.deepEqual(fieldsFromList(fields), fields)
  assert.deepEqual(fieldsFromList(null), [])
  assert.deepEqual(fieldsFromList({}), [])
})

test('findField matches by fieldName case-insensitively', () => {
  const fields: CustomField[] = [{ fieldId: '9', fieldName: 'Client_IP', state: 'Enabled' }]
  assert.equal(findField(fields, 'client_ip')?.fieldId, '9')
  assert.equal(findField(fields, 'missing'), null)
  assert.equal(findField(fields, ''), null)
})
