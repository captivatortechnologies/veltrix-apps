import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  parseMetadataEntries,
  readServerMetadata,
  liveMetadataValue,
  serverSetMetadataVQL,
  GET_SERVER_METADATA_VQL,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.scope ?? i), fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

const good = { scope: 'server', metadata: { environment: 'production', owner: 'secops-team' } }

// --- validate -----------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a scope', async () => {
  const res = await validate(ctxOf([{ ...good, scope: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCOPE'))
})

test('validate warns (does not error) on empty metadata', async () => {
  const res = await validate(ctxOf([{ ...good, metadata: {} }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_METADATA'))
})

test('validate warns when more than one item is provided (singleton)', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.ok(res.warnings.some((w) => w.code === 'SINGLETON'))
})

test('validate accepts a good singleton', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects an oversized metadata key', async () => {
  const res = await validate(ctxOf([{ ...good, metadata: { [`k${'x'.repeat(200)}`]: 'v' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'KEY_TOO_LONG'))
})

test('validate rejects an oversized metadata value', async () => {
  const res = await validate(ctxOf([{ ...good, metadata: { k: 'v'.repeat(5000) } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'VALUE_TOO_LONG'))
})

// --- value shaping --------------------------------------------------------------

test('parseMetadataEntries coerces a keyvalue object into a clean entry list', () => {
  const entries = parseMetadataEntries({ a: 'x', b: 1, c: null, '': 'ignored' })
  assert.deepEqual(entries, [
    { key: 'a', value: 'x' },
    { key: 'b', value: '1' },
    { key: 'c', value: '' },
  ])
})

test('parseMetadataEntries returns an empty list for non-object input', () => {
  assert.deepEqual(parseMetadataEntries(undefined), [])
  assert.deepEqual(parseMetadataEntries(['a', 'b']), [])
})

test('readServerMetadata pulls the metadata column, tolerant of shape', () => {
  assert.deepEqual(readServerMetadata([{ metadata: { a: '1' } }]), { a: '1' })
  assert.deepEqual(readServerMetadata([{ Metadata: { a: '1' } }]), { a: '1' })
  assert.deepEqual(readServerMetadata([]), {})
})

test('liveMetadataValue distinguishes "missing" from "present but empty"', () => {
  const current = { a: 'x', b: '' }
  assert.equal(liveMetadataValue(current, 'a'), 'x')
  assert.equal(liveMetadataValue(current, 'b'), '')
  assert.equal(liveMetadataValue(current, 'missing'), undefined)
})

// --- VQL builders ---------------------------------------------------------------

test('serverSetMetadataVQL wraps the dict in parse_json + server_set_metadata', () => {
  const vql = serverSetMetadataVQL({ environment: 'production' })
  assert.match(vql, /server_set_metadata\(metadata=parse_json\(data='/)
  assert.match(vql, /FROM scope\(\)/)
})

test('GET_SERVER_METADATA_VQL reads the current state', () => {
  assert.match(GET_SERVER_METADATA_VQL, /server_metadata\(\)/)
})
