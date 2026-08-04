import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractPasswordManagerPolicySpecs, normalizeDisableExport } from '../_shared'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: `item${i}`, fields }))
  return { items, sections: items } as unknown as CanvasSnapshot
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

// --- validate -----------------------------------------------------------------

test('validate rejects an empty canvas', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects more than one item (singleton)', async () => {
  const res = await validate(ctxOf([{ disableExport: true }, { disableExport: false }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'SINGLETON'))
})

test('validate accepts exactly one item', async () => {
  const res = await validate(ctxOf([{ disableExport: true }]))
  assert.equal(res.valid, true)
})

// --- _shared helpers ----------------------------------------------------------

test('normalizeDisableExport defaults to false and honours truthy strings', () => {
  assert.equal(normalizeDisableExport(undefined), false)
  assert.equal(normalizeDisableExport(true), true)
  assert.equal(normalizeDisableExport('true'), true)
  assert.equal(normalizeDisableExport('false'), false)
})

test('extractPasswordManagerPolicySpecs reads the singleton item', () => {
  const specs = extractPasswordManagerPolicySpecs(canvasOf([{ disableExport: true }]))
  assert.equal(specs.length, 1)
  assert.equal(specs[0].disableExport, true)
})
