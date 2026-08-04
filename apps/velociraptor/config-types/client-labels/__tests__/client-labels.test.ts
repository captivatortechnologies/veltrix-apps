import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { labelSetVQL, labelRemoveVQL, clientsByLabelVQL, readClientIds, diffIds } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.label ?? i), fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

const good = { label: 'vip-servers', clientIds: 'C.1a2b3c4d, C.5e6f7890', enabled: true }

// --- validate -----------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a label', async () => {
  const res = await validate(ctxOf([{ ...good, label: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_LABEL'))
})

test('validate requires at least one client id when enabled', async () => {
  const res = await validate(ctxOf([{ ...good, clientIds: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CLIENT_IDS'))
})

test('validate accepts a disabled label with no client ids', async () => {
  const res = await validate(ctxOf([{ ...good, clientIds: '', enabled: false }]))
  assert.equal(res.valid, true)
})

test('validate rejects a malformed client id', async () => {
  const res = await validate(ctxOf([{ ...good, clientIds: 'not-a-client-id' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CLIENT_ID'))
})

test('validate checks client-id format even when disabled', async () => {
  const res = await validate(ctxOf([{ ...good, clientIds: 'bad-id', enabled: false }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CLIENT_ID'))
})

test('validate warns on a duplicate label (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, label: 'VIP-Servers' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_LABEL'))
})

test('validate accepts a good label', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- VQL builders ---------------------------------------------------------------

test('labelSetVQL / labelRemoveVQL name the client id, label and op', () => {
  assert.match(labelSetVQL('C.1a2b3c4d', 'vip-servers'), /label\(client_id='C\.1a2b3c4d', labels=\['vip-servers'\], op='set'\)/)
  assert.match(labelRemoveVQL('C.1a2b3c4d', 'vip-servers'), /label\(client_id='C\.1a2b3c4d', labels=\['vip-servers'\], op='remove'\)/)
})

test('labelSetVQL escapes single quotes in inputs', () => {
  assert.match(labelSetVQL("C.o'brien", "label's"), /client_id='C\.o''brien'/)
  assert.match(labelSetVQL("C.o'brien", "label's"), /labels=\['label''s'\]/)
})

test('clientsByLabelVQL filters clients() by the label search prefix', () => {
  assert.match(clientsByLabelVQL('vip-servers'), /clients\(search='label:vip-servers'\)/)
})

// --- reading + diffing ----------------------------------------------------------

test('readClientIds reads the client_id column, tolerant of casing and de-duplicated', () => {
  const ids = readClientIds([{ client_id: 'C.1' }, { ClientId: 'C.2' }, { client_id: 'C.1' }, { client_id: '' }])
  assert.deepEqual(ids, ['C.1', 'C.2'])
})

test('diffIds returns values in "a" that are not in "b"', () => {
  assert.deepEqual(diffIds(['a', 'b', 'c'], ['b']), ['a', 'c'])
  assert.deepEqual(diffIds([], ['a']), [])
  assert.deepEqual(diffIds(['a'], []), ['a'])
})
