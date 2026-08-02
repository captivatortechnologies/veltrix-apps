import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate, { extractLabelSpecs, labelIdentity, MAX_KEY_LENGTH } from '../validate'
import { buildCreateBody, buildUpdateBody } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/driftDetect/healthCheck call the live PCE over node:https
 * inside illumioApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure body-builder helpers in deploy.ts, which are
 * network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.key ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { key: 'role', value: 'R-DB' }

// --- validate -----------------------------------------------------------------

test('validate accepts a good label', async () => {
  const res = validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate requires a key', async () => {
  const res = validate(ctxOf([{ key: '', value: 'R-DB' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field === 'items[0].key' && e.code === 'required'))
})

test('validate requires a value', async () => {
  const res = validate(ctxOf([{ key: 'role', value: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field === 'items[0].value' && e.code === 'required'))
})

test('validate rejects a key longer than 64 characters', async () => {
  const res = validate(ctxOf([{ key: 'x'.repeat(MAX_KEY_LENGTH + 1), value: 'v' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'too_long'))
})

test('validate accepts a key at exactly 64 characters', async () => {
  const res = validate(ctxOf([{ key: 'x'.repeat(MAX_KEY_LENGTH), value: 'v' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a duplicate (key, value) pair', async () => {
  const res = validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'duplicate_label'))
})

test('validate allows the same value under a different key', async () => {
  const res = validate(ctxOf([{ key: 'role', value: 'Prod' }, { key: 'env', value: 'Prod' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate allows the same key with different values', async () => {
  const res = validate(ctxOf([{ key: 'role', value: 'R-DB' }, { key: 'role', value: 'R-WEB' }]))
  assert.equal(res.valid, true)
})

// --- extractLabelSpecs / labelIdentity -----------------------------------------

test('extractLabelSpecs trims whitespace and carries through metadata fields', () => {
  const specs = extractLabelSpecs({
    items: [
      {
        id: 'i1',
        name: 'role',
        fields: { key: '  role  ', value: '  R-DB  ', externalDataSet: 'cmdb', externalDataReference: 'cmdb-42' },
      },
    ],
  } as unknown as PipelineContext['canvas'])
  assert.equal(specs[0].key, 'role')
  assert.equal(specs[0].value, 'R-DB')
  assert.equal(specs[0].externalDataSet, 'cmdb')
  assert.equal(specs[0].externalDataReference, 'cmdb-42')
})

test('labelIdentity distinguishes key/value combinations', () => {
  assert.equal(labelIdentity('role', 'R-DB'), labelIdentity('role', 'R-DB'))
  assert.notEqual(labelIdentity('role', 'R-DB'), labelIdentity('env', 'R-DB'))
  assert.notEqual(labelIdentity('role', 'R-DB'), labelIdentity('role', 'R-WEB'))
})

// --- deploy body builders -------------------------------------------------------

test('buildCreateBody includes key + value and omits blank metadata', () => {
  const body = buildCreateBody({ key: 'role', value: 'R-DB', externalDataSet: '', externalDataReference: '' })
  assert.deepEqual(body, { key: 'role', value: 'R-DB' })
})

test('buildCreateBody includes metadata when provided', () => {
  const body = buildCreateBody({ key: 'role', value: 'R-DB', externalDataSet: 'cmdb', externalDataReference: 'cmdb-42' })
  assert.deepEqual(body, { key: 'role', value: 'R-DB', external_data_set: 'cmdb', external_data_reference: 'cmdb-42' })
})

test('buildUpdateBody never includes key (immutable) and normalizes blank metadata', () => {
  const body = buildUpdateBody({ key: 'role', value: 'R-DB', externalDataSet: '', externalDataReference: '' })
  assert.deepEqual(body, { value: 'R-DB', external_data_set: '', external_data_reference: '' })
  assert.equal('key' in body, false)
})
