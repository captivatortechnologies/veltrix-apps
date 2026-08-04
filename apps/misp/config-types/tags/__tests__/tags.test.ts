import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildTagFields, findTag, normalizeYesNo, normalizeNumber, tagsFromList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the MISP REST API via node:https inside mispApi, which
 * is impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'tlp:amber', colour: '#ffce3d', exportable: 'yes', local_only: 'no', hide_tag: 'no' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an invalid hex colour', async () => {
  const res = await validate(ctxOf([{ ...good, colour: 'amber' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_COLOUR'))
})

test('validate accepts a blank colour', async () => {
  const res = await validate(ctxOf([{ ...good, colour: '' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, colour: '#000000' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate rejects a non-numeric org_id', async () => {
  const res = await validate(ctxOf([{ ...good, org_id: 'not-a-number' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NUMBER'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildTagFields omits colour when blank', () => {
  const fields = buildTagFields({ name: 'test-tag', colour: '', exportable: 'yes' })
  assert.equal('colour' in fields, false)
  assert.equal(fields.name, 'test-tag')
  assert.equal(fields.exportable, true)
})

test('buildTagFields includes colour when set', () => {
  const fields = buildTagFields({ name: 'test-tag', colour: '#112233' })
  assert.equal(fields.colour, '#112233')
})

test('buildTagFields defaults org_id/user_id to 0', () => {
  const fields = buildTagFields({ name: 'test-tag' })
  assert.equal(fields.org_id, 0)
  assert.equal(fields.user_id, 0)
})

test('tagsFromList unwraps the Tag envelope', () => {
  const rows = tagsFromList([{ Tag: { id: 1, name: 'tlp:amber' } }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'tlp:amber')
})

test('findTag matches case-insensitively', () => {
  const tags = tagsFromList([{ Tag: { id: 1, name: 'TLP:AMBER' } }])
  assert.ok(findTag(tags, 'tlp:amber'))
  assert.equal(findTag(tags, 'tlp:red'), null)
})

test('normalizeYesNo handles strings and booleans', () => {
  assert.equal(normalizeYesNo('yes'), true)
  assert.equal(normalizeYesNo('no'), false)
  assert.equal(normalizeYesNo(true), true)
  assert.equal(normalizeYesNo(1), true)
})

test('normalizeNumber parses blanks as undefined', () => {
  assert.equal(normalizeNumber(''), undefined)
  assert.equal(normalizeNumber(undefined), undefined)
  assert.equal(normalizeNumber('42'), 42)
})
