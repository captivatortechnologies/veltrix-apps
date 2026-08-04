import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { buildCreateTagCommand, buildModifyTagCommand, buildDeleteTagCommand, parseTags } from '../../../lib/gmp/tags'
import { buildTagInput, findTagByName } from '../_shared'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}
const good = { name: 'geo:long', resourceType: 'target', resourceIds: ['b493b7a8-0001-0000-0000-000000000001'], value: '52.2788' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a non-UUID resource id', async () => {
  const res = await validate(ctxOf([{ ...good, resourceIds: ['not-a-uuid'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RESOURCE_ID'))
})

test('validate warns on a duplicate tag name', async () => {
  const res = await validate(ctxOf([good, { ...good, value: '99.0' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a tag with no attached resources', async () => {
  const res = await validate(ctxOf([{ ...good, resourceIds: [] }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- command builders --------------------------------------------------------

test('buildCreateTagCommand wraps resources in a <resources><type/> ... wrapper', () => {
  const xml = buildCreateTagCommand({ name: 'geo:long', resourceType: 'target', resourceIds: ['b493b7a8-0001'], value: '52.2788' })
  assert.ok(xml.includes('<resources><type>target</type><resource id="b493b7a8-0001"/></resources>'))
  assert.ok(xml.includes('<value>52.2788</value>'))
})

test('buildCreateTagCommand supports zero attached resources', () => {
  const xml = buildCreateTagCommand({ name: 'geo:long', resourceType: 'target', resourceIds: [] })
  assert.ok(xml.includes('<resources><type>target</type></resources>'))
})

test('buildModifyTagCommand sends resources with action="set"', () => {
  const xml = buildModifyTagCommand('t1', { name: 'geo:long', resourceType: 'target', resourceIds: ['id-1', 'id-2'] })
  assert.ok(xml.includes('<resources action="set"><type>target</type><resource id="id-1"/><resource id="id-2"/></resources>'))
})

test('buildDeleteTagCommand sets ultimate', () => {
  assert.equal(buildDeleteTagCommand('t1', true), '<delete_tag tag_id="t1" ultimate="1"/>')
})

// --- response parsing ---------------------------------------------------------

test('parseTags extracts name/value/active/resourceType', () => {
  const xml = `<get_tags_response><tag id="t1"><name>geo:long</name><value>52.2788</value><active>1</active><resources><type>target</type></resources></tag></get_tags_response>`
  const [t] = parseTags(xml)
  assert.equal(t.id, 't1')
  assert.equal(t.value, '52.2788')
  assert.equal(t.active, true)
  assert.equal(t.resourceType, 'target')
})

// --- _shared helpers -----------------------------------------------------------

test('buildTagInput accepts a comma-separated resourceIds string too', () => {
  const input = buildTagInput({ name: 'geo:long', resourceType: 'target', resourceIds: 'a, b ,c' })
  assert.deepEqual(input.resourceIds, ['a', 'b', 'c'])
})

test('findTagByName matches on the trimmed name', () => {
  const tags = parseTags('<get_tags_response><tag id="t1"><name>geo:long</name></tag></get_tags_response>')
  assert.equal(findTagByName(tags, 'geo:long')?.id, 't1')
  assert.equal(findTagByName(tags, 'Nope'), null)
})
