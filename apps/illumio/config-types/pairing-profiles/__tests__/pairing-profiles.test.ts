import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate, { extractPairingProfileSpecs, isUnlimitedOrValidRange, MAX_NAME_LENGTH } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Production VENs', enforcementMode: 'visibility_only', allowedUsesPerKey: 'unlimited', keyLifespan: '3600' }

test('validate accepts a good pairing profile', () => {
  const res = validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate applies sensible defaults when fields are omitted', () => {
  const res = validate(ctxOf([{ name: 'Defaults' }]))
  assert.equal(res.valid, true)
})

test('validate requires a name', () => {
  const res = validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field === 'items[0].name' && e.code === 'required'))
})

test('validate rejects a name longer than 255 characters', () => {
  const res = validate(ctxOf([{ ...good, name: 'x'.repeat(MAX_NAME_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'too_long'))
})

test('validate rejects a duplicate name', () => {
  const res = validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'duplicate_name'))
})

test('validate rejects an invalid enforcement mode', () => {
  const res = validate(ctxOf([{ ...good, enforcementMode: 'always' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_enforcement_mode'))
})

test('validate rejects an invalid visibility level', () => {
  const res = validate(ctxOf([{ ...good, visibilityLevel: 'everything' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_visibility_level'))
})

test('validate accepts a blank visibility level (PCE default)', () => {
  const res = validate(ctxOf([{ ...good, visibilityLevel: '' }]))
  assert.equal(res.valid, true)
})

test('validate rejects an out-of-range allowedUsesPerKey', () => {
  const res = validate(ctxOf([{ ...good, allowedUsesPerKey: '0' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_range' && e.field === 'items[0].allowedUsesPerKey'))
})

test('validate rejects a non-numeric, non-unlimited keyLifespan', () => {
  const res = validate(ctxOf([{ ...good, keyLifespan: 'forever' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_range' && e.field === 'items[0].keyLifespan'))
})

test('validate rejects invalid JSON in labelsJson', () => {
  const res = validate(ctxOf([{ ...good, labelsJson: '{bad' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_json'))
})

test('extractPairingProfileSpecs defaults enforcementMode and limits', () => {
  const specs = extractPairingProfileSpecs({ items: [{ id: 'i1', name: 'A', fields: { name: 'A' } }] } as unknown as PipelineContext['canvas'])
  assert.equal(specs[0].enforcementMode, 'visibility_only')
  assert.equal(specs[0].allowedUsesPerKey, 'unlimited')
  assert.equal(specs[0].keyLifespan, 'unlimited')
  assert.equal(specs[0].enabled, true)
  assert.equal(specs[0].envLabelLock, true)
})

test('isUnlimitedOrValidRange', () => {
  assert.equal(isUnlimitedOrValidRange('unlimited'), true)
  assert.equal(isUnlimitedOrValidRange('1'), true)
  assert.equal(isUnlimitedOrValidRange('2147483647'), true)
  assert.equal(isUnlimitedOrValidRange('0'), false)
  assert.equal(isUnlimitedOrValidRange('-5'), false)
  assert.equal(isUnlimitedOrValidRange('abc'), false)
})
