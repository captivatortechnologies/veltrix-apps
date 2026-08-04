import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { inventoryAddVQL, readTools, findTool, INVENTORY_VQL } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.tool ?? i), fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

const good = {
  tool: 'Osquery',
  version: '5.12.1',
  url: 'https://pkg.osquery.io/darwin/osquery-5.12.1.pkg',
  hash: 'a'.repeat(64),
  filename: 'osquery.pkg',
  serveLocally: true,
}

// --- validate -----------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a tool name', async () => {
  const res = await validate(ctxOf([{ ...good, tool: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TOOL'))
})

test('validate requires a URL', async () => {
  const res = await validate(ctxOf([{ ...good, url: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_URL'))
})

test('validate rejects a malformed URL', async () => {
  const res = await validate(ctxOf([{ ...good, url: 'not a url' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_URL'))
})

test('validate warns (does not error) when the hash is blank', async () => {
  const res = await validate(ctxOf([{ ...good, hash: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_HASH'))
})

test('validate rejects a non-hex hash', async () => {
  const res = await validate(ctxOf([{ ...good, hash: 'not-hex!!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_HASH'))
})

test('validate warns (does not error) on a hash of unexpected length', async () => {
  const res = await validate(ctxOf([{ ...good, hash: 'abcd1234' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNEXPECTED_HASH_LENGTH'))
})

test('validate warns on a duplicate tool name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, tool: 'OSQUERY' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TOOL'))
})

test('validate accepts a good tool', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- VQL builders ---------------------------------------------------------------

test('inventoryAddVQL includes only the provided optional args', () => {
  const vql = inventoryAddVQL({ tool: 'Osquery', url: 'https://x', serveLocally: true })
  assert.match(vql, /inventory_add\(tool='Osquery', url='https:\/\/x', serve_locally=TRUE\)/)
  assert.ok(!/version=/.test(vql))
  assert.ok(!/hash=/.test(vql))
})

test('inventoryAddVQL includes version/hash/filename when given, and renders serve_locally as FALSE', () => {
  const vql = inventoryAddVQL({ tool: 'Osquery', version: '5.12.1', url: 'https://x', hash: 'abcd', filename: 'osquery.pkg', serveLocally: false })
  assert.match(vql, /version='5\.12\.1'/)
  assert.match(vql, /hash='abcd'/)
  assert.match(vql, /filename='osquery\.pkg'/)
  assert.match(vql, /serve_locally=FALSE/)
})

// --- reading ----------------------------------------------------------------

test('readTools maps columns, tolerant of casing', () => {
  const tools = readTools([
    { tool: 'Osquery', version: '5.12.1', url: 'https://x', hash: 'abcd', serve_locally: true },
    { Tool: 'WinPmem' },
    { tool: '' },
  ])
  assert.equal(tools.length, 2)
  assert.equal(tools[0].tool, 'Osquery')
  assert.equal(tools[0].serveLocally, true)
  assert.equal(tools[1].tool, 'WinPmem')
})

test('findTool matches by case-insensitive tool name', () => {
  const live = readTools([{ tool: 'Osquery' }])
  assert.equal(findTool(live, 'osquery')?.tool, 'Osquery')
  assert.equal(findTool(live, 'missing'), null)
})

test('INVENTORY_VQL reads every tool', () => {
  assert.match(INVENTORY_VQL, /FROM inventory\(\)/)
})
