import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, toNetworkDeviceGroupBody, MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a name over the ERS length limit', async () => {
  const res = await validate(ctxOf([{ name: 'a'.repeat(MAX_NAME_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate rejects a description over the ERS length limit', async () => {
  const res = await validate(ctxOf([{ name: 'Location#All Locations#SF', description: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('validate warns on a duplicate group name (case-insensitive)', async () => {
  const res = await validate(ctxOf([{ name: 'Location#All Locations#SF' }, { name: 'location#all locations#sf' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate warns on a root-level name with no "#"', async () => {
  const res = await validate(ctxOf([{ name: 'MyCustomCategory' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'ROOT_LEVEL_NAME'))
})

test('validate accepts a well-formed child group with no warnings', async () => {
  const res = await validate(ctxOf([{ name: 'Device Type#All Device Types#Switches', description: 'Access switches' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
  assert.equal(res.warnings.length, 0)
})

test('specFromItem trims name and description', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: { name: '  Location#All Locations#SF  ' } })
  assert.equal(spec.name, 'Location#All Locations#SF')
  assert.equal(spec.description, '')
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([{ name: 'A' }, { name: 'B#C' }]))
  assert.equal(specs.length, 2)
  assert.deepEqual(specs.map((s) => s.name), ['A', 'B#C'])
})

test('toNetworkDeviceGroupBody derives othername from the name\'s root segment', () => {
  assert.equal(toNetworkDeviceGroupBody({ name: 'Location#All Locations#SF', description: '' }).othername, 'Location')
  assert.equal(toNetworkDeviceGroupBody({ name: 'Device Type#All Device Types', description: 'x' }).othername, 'Device Type')
  assert.equal(toNetworkDeviceGroupBody({ name: 'CustomRoot', description: '' }).othername, 'CustomRoot')
})
