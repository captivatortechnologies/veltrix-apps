import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  classifyDestination,
  extractDestinationListSpecs,
  splitDestinations,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Umbrella REST API, which is
 * impractical to mock here. Tests focus on the pure, network-free pieces:
 * validate.ts and the _shared parsing/classification helpers.
 */
function ctxWith(list: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>): PipelineContext {
  const items = list.map((row, i) => ({ id: row.id ?? `i${i}`, name: row.name ?? String(i), fields: row.fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

const good = { name: 'Corp Blocklist', access: 'block', isGlobal: false, destinations: 'evil.example\nbad.example.com' }

test('validate accepts a valid block list', () => {
  const res = validate(ctxWith([{ fields: good }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', () => {
  const res = validate(ctxWith([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a name', () => {
  const res = validate(ctxWith([{ name: '', fields: { ...good, name: '' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'required'))
})

test('validate rejects an invalid access mode', () => {
  const res = validate(ctxWith([{ fields: { ...good, access: 'deny' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_access'))
})

test('validate rejects a too-long name', () => {
  const res = validate(ctxWith([{ fields: { ...good, name: 'x'.repeat(51) } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'too_long'))
})

test('validate rejects duplicate names', () => {
  const res = validate(ctxWith([{ fields: good }, { fields: { ...good } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'duplicate_name'))
})

test('validate rejects more than 500 destinations', () => {
  const destinations = Array.from({ length: 501 }, (_, i) => `d${i}.example.com`).join('\n')
  const res = validate(ctxWith([{ fields: { ...good, destinations } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'too_many_destinations'))
})

test('validate warns on a URL in an allow list', () => {
  const res = validate(ctxWith([{ fields: { name: 'Allow', access: 'allow', destinations: 'example.com/path' } }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'url_on_allow_list'))
})

test('validate warns on an IPv4 in a block list', () => {
  const res = validate(ctxWith([{ fields: { name: 'Block', access: 'block', destinations: '10.0.0.1' } }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'ip_on_block_list'))
})

test('validate warns on an empty destination list', () => {
  const res = validate(ctxWith([{ fields: { name: 'Empty', access: 'block', destinations: '' } }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'empty_destinations'))
})

test('splitDestinations splits, trims and dedupes case-insensitively', () => {
  const out = splitDestinations('  a.com \n b.com, a.com\nA.COM\n')
  assert.deepEqual(out, ['a.com', 'b.com'])
})

test('classifyDestination distinguishes domain, url and ipv4', () => {
  assert.equal(classifyDestination('example.com'), 'domain')
  assert.equal(classifyDestination('example.com/malware'), 'url')
  assert.equal(classifyDestination('https://example.com'), 'url')
  assert.equal(classifyDestination('10.0.0.1'), 'ipv4')
  assert.equal(classifyDestination('192.168.0.0/16'), 'ipv4')
})

test('extractDestinationListSpecs reads fields with defaults', () => {
  const specs = extractDestinationListSpecs({
    items: [{ id: 'i1', name: 'Fallback', fields: { name: '  Corp  ', access: 'ALLOW', isGlobal: true, destinations: 'a.com' } }],
  } as unknown as PipelineContext['canvas'])
  assert.equal(specs[0].name, 'Corp')
  assert.equal(specs[0].access, 'allow')
  assert.equal(specs[0].isGlobal, true)
  assert.deepEqual(specs[0].destinations, ['a.com'])
})
