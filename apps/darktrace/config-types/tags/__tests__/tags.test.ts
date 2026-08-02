import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildCreateBody, findTag, normalizeColor, tagsFromList, tidFrom } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Darktrace REST API via
 * node:https inside darktraceApi, which is impractical to mock here (the signer
 * itself is unit-tested in lib/__tests__). These tests cover validate.ts and the
 * pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Critical-Assets', color: 200, description: 'Mission-critical infrastructure' }

test('validate accepts a good tag', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.equal(res.errors.length, 0)
})

test('validate accepts a tag with no colour or description', async () => {
  const res = await validate(ctxOf([{ name: 'Servers' }]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate accepts hue 0 (a valid HSL hue)', async () => {
  const res = await validate(ctxOf([{ ...good, color: 0 }]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an over-long name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'x'.repeat(129) }]))
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate rejects a name with invalid characters', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'bad/name' }]))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a non-numeric colour', async () => {
  const res = await validate(ctxOf([{ ...good, color: 'teal' }]))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_COLOR'))
})

test('validate rejects an out-of-range colour', async () => {
  const res = await validate(ctxOf([{ ...good, color: 400 }]))
  assert.ok(res.errors.some((e) => e.code === 'COLOR_OUT_OF_RANGE'))
})

test('validate rejects an over-long description', async () => {
  const res = await validate(ctxOf([{ ...good, description: 'x'.repeat(257) }]))
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('validate warns on a duplicate tag name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'dup' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TAG'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildCreateBody includes only non-empty fields', () => {
  assert.deepEqual(buildCreateBody({ name: 'Servers', color: 200, description: '' }), {
    name: 'Servers',
    color: 200,
  })
})

test('buildCreateBody keeps hue 0 but omits a blank colour', () => {
  assert.deepEqual(buildCreateBody({ name: 'A', color: 0 }), { name: 'A', color: 0 })
  assert.deepEqual(buildCreateBody({ name: 'B', color: '' }), { name: 'B' })
})

test('normalizeColor truncates numbers and rejects blanks / non-numbers', () => {
  assert.equal(normalizeColor(200.7), 200)
  assert.equal(normalizeColor('120'), 120)
  assert.equal(normalizeColor(''), null)
  assert.equal(normalizeColor(undefined), null)
  assert.equal(normalizeColor('teal'), null)
})

test('tagsFromList normalizes a bare array and a { tags: [...] } envelope', () => {
  assert.equal(tagsFromList([{ tid: 1, name: 'A' }]).length, 1)
  const enveloped = tagsFromList({ tags: [{ tid: 2, name: 'B' }] })
  assert.equal(enveloped.length, 1)
  assert.equal(enveloped[0].name, 'B')
  assert.equal(tagsFromList(null).length, 0)
})

test('findTag matches case-insensitively', () => {
  const rows = tagsFromList([{ tid: 5, name: 'Critical-Assets' }])
  assert.ok(findTag(rows, 'critical-assets'))
  assert.equal(findTag(rows, 'unknown'), null)
})

test('tidFrom extracts a tid from a number, object and single-element array', () => {
  assert.equal(tidFrom(7), 7)
  assert.equal(tidFrom('9'), 9)
  assert.equal(tidFrom({ tid: 12 }), 12)
  assert.equal(tidFrom({ id: 13 }), 13)
  assert.equal(tidFrom([{ tid: 14 }]), 14)
  assert.equal(tidFrom({ name: 'no-tid' }), null)
  assert.equal(tidFrom(null), null)
})
