import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parseText, parseBool, buildUpdateAttrsBody, buildRestoreBody, instancesFromResponse, findInstance } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.node_id ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { node_id: 'node-1', node_name: 'Master', hostname: 'axonius-master', use_as_environment_name: false }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing node_id', async () => {
  const res = await validate(ctxOf([{ ...good, node_id: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NODE_ID'))
})

test('validate rejects a missing display name', async () => {
  const res = await validate(ctxOf([{ ...good, node_name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NODE_NAME'))
})

test('validate warns on a duplicate node_id', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NODE_ID'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- field parsing ------------------------------------------------------------

test('parseBool accepts real booleans and the string "true"', () => {
  assert.equal(parseBool(true), true)
  assert.equal(parseBool('true'), true)
  assert.equal(parseBool(undefined), false)
})

test('parseText trims', () => {
  assert.equal(parseText('  x '), 'x')
})

// --- body building (flat, non-JSON:API — see _shared.ts) -------------------

test('buildUpdateAttrsBody is a flat object with a singular nodeIds string', () => {
  const body = buildUpdateAttrsBody({ nodeId: 'node-1', nodeName: 'Master', hostname: 'h', useAsEnvironmentName: true })
  assert.deepEqual(body, { nodeIds: 'node-1', node_name: 'Master', hostname: 'h', use_as_environment_name: true })
  assert.equal('data' in body, false)
})

test('buildRestoreBody restores prior attrs for the given node', () => {
  const body = buildRestoreBody('node-1', { node_name: 'Old Name', hostname: 'old-host', use_as_environment_name: false })
  assert.deepEqual(body, { nodeIds: 'node-1', node_name: 'Old Name', hostname: 'old-host', use_as_environment_name: false })
})

// --- response unwrapping + identity -----------------------------------------

const listResponse = {
  data: [
    { id: 'node-1', type: 'instances_schema', attributes: { node_id: 'node-1', node_name: 'Master', hostname: 'h1', is_master: true } },
    { id: 'node-2', type: 'instances_schema', attributes: { node_id: 'node-2', node_name: 'Collector', hostname: 'h2', is_master: false } },
  ],
}

test('instancesFromResponse flattens JSON:API rows', () => {
  const rows = instancesFromResponse(listResponse)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].node_name, 'Master')
})

test('findInstance matches by node_id', () => {
  const rows = instancesFromResponse(listResponse)
  assert.equal(findInstance(rows, 'node-2')?.node_name, 'Collector')
  assert.equal(findInstance(rows, 'nope'), null)
})
