import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildExclusionBody, boolFromField, exclusionsFromReply, findExclusionByName, isValidFilterJson } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift apply over the (speculative) Cortex XDR REST API, which is
 * impractical to mock here. Tests focus on validate.ts and the pure _shared
 * helpers (identity matching + body building + filter/bool parsing) — all
 * network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Suppress test alerts', filter: '{"alert_name":"Test"}', comment: 'noise', disabled: false }

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed exclusion', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing filter', async () => {
  const res = await validate(ctxOf([{ ...good, filter: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_FILTER'))
})

test('validate rejects an invalid JSON filter', async () => {
  const res = await validate(ctxOf([{ ...good, filter: '{broken' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FILTER'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ----------------------------------------------------------

test('boolFromField reads checkbox-ish truthy values', () => {
  assert.equal(boolFromField(true), true)
  assert.equal(boolFromField('true'), true)
  assert.equal(boolFromField('yes'), true)
  assert.equal(boolFromField('1'), true)
  assert.equal(boolFromField(false), false)
  assert.equal(boolFromField(''), false)
  assert.equal(boolFromField('no'), false)
})

test('isValidFilterJson requires non-blank valid JSON', () => {
  assert.equal(isValidFilterJson(''), false)
  assert.equal(isValidFilterJson('{"a":1}'), true)
  assert.equal(isValidFilterJson('{a:1'), false)
})

test('buildExclusionBody parses filter, sets disabled, omits empty comment', () => {
  const body = buildExclusionBody({ name: 'X', filter: '{"a":1}', disabled: 'true' })
  assert.equal(body.name, 'X')
  assert.deepEqual(body.filter, { a: 1 })
  assert.equal(body.disabled, true)
  assert.equal('comment' in body, false)
})

test('exclusionsFromReply unwraps array, { exclusions } and { rules } shapes', () => {
  assert.equal(exclusionsFromReply([{ name: 'a' }]).length, 1)
  assert.equal(exclusionsFromReply({ exclusions: [{ name: 'b' }] }).length, 1)
  assert.equal(exclusionsFromReply({ rules: [{ name: 'c' }, { name: 'd' }] }).length, 2)
  assert.equal(exclusionsFromReply(null).length, 0)
})

test('findExclusionByName matches case-insensitively on name or rule_name', () => {
  const live = [{ rule_name: 'Noise', disabled: false }]
  const match = findExclusionByName(live, 'noise')
  assert.ok(match)
  assert.equal(match?.disabled, false)
})
