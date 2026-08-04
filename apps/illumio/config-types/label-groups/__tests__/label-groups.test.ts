import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate, { extractLabelGroupSpecs, MAX_KEY_LENGTH, MAX_NAME_LENGTH } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Non-Prod Envs', key: 'env', labelsJson: '[{"key":"env","value":"E-Dev"},{"key":"env","value":"E-Stage"}]' }

test('validate accepts a good label group', () => {
  const res = validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a label group with no members yet', () => {
  const res = validate(ctxOf([{ name: 'Empty', key: 'env' }]))
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
  assert.ok(res.errors.some((e) => e.code === 'too_long' && e.field === 'items[0].name'))
})

test('validate rejects a duplicate name', () => {
  const res = validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'duplicate_name'))
})

test('validate requires a key', () => {
  const res = validate(ctxOf([{ ...good, key: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field === 'items[0].key' && e.code === 'required'))
})

test('validate rejects a key longer than 64 characters', () => {
  const res = validate(ctxOf([{ ...good, key: 'x'.repeat(MAX_KEY_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'too_long' && e.field === 'items[0].key'))
})

test('validate rejects invalid JSON in labelsJson', () => {
  const res = validate(ctxOf([{ ...good, labelsJson: '{bad' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_json'))
})

test('validate rejects a member label whose key does not match the group key', () => {
  const res = validate(ctxOf([{ name: 'Mismatch', key: 'env', labelsJson: '[{"key":"role","value":"R-DB"}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'label_key_mismatch'))
})

test('validate rejects a member label ref missing a value', () => {
  const res = validate(ctxOf([{ name: 'Bad', key: 'env', labelsJson: '[{"key":"env"}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_label_ref'))
})

test('extractLabelGroupSpecs parses labels JSON', () => {
  const specs = extractLabelGroupSpecs({
    items: [{ id: 'i1', name: 'A', fields: good }],
  } as unknown as PipelineContext['canvas'])
  assert.equal(specs[0].key, 'env')
  assert.equal(specs[0].labels.length, 2)
  assert.equal(specs[0].labels[0].value, 'E-Dev')
})
