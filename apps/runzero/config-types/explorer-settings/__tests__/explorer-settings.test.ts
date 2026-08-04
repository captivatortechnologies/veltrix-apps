import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  resolveExplorerId,
  findExplorerById,
  resolveSiteId,
  buildPatchedSettings,
  declaresChange,
  positiveIntOrUndefined,
  type RunzeroExplorer,
} from '../_shared'
import { coerceList } from '../../../lib/runzeroApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift/health hit the runZero console API via fetch, which is impractical to
 * mock here. Tests focus on validate.ts and the network-free _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.explorer ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { explorer: 'RUNZERO-AGENT-01', site: 'HQ' }

// --- validate -------------------------------------------------------------

test('validate rejects a missing explorer reference', async () => {
  const res = await validate(ctxOf([{ ...good, explorer: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_EXPLORER'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid item', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate explorer reference', async () => {
  const res = await validate(ctxOf([good, { ...good, site: 'Branch' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_EXPLORER'))
})

test('validate warns when an item declares no change', async () => {
  const res = await validate(ctxOf([{ explorer: 'RUNZERO-AGENT-01' }]))
  assert.ok(res.warnings.some((w) => w.code === 'NO_OP_ITEM'))
})

test('validate warns on a non-positive max concurrent scans', async () => {
  const res = await validate(ctxOf([{ ...good, maxConcurrentScans: -1 }]))
  assert.ok(res.warnings.some((w) => w.code === 'SUSPECT_MAX_CONCURRENT_SCANS'))
})

// --- _shared helpers ------------------------------------------------------

test('positiveIntOrUndefined rejects zero/negative/blank', () => {
  assert.equal(positiveIntOrUndefined(''), undefined)
  assert.equal(positiveIntOrUndefined(0), undefined)
  assert.equal(positiveIntOrUndefined(-5), undefined)
  assert.equal(positiveIntOrUndefined(5), 5)
})

test('declaresChange requires at least one of site/maxConcurrentScans', () => {
  assert.equal(declaresChange({}), false)
  assert.equal(declaresChange({ site: 'HQ' }), true)
  assert.equal(declaresChange({ maxConcurrentScans: 5 }), true)
})

test('resolveExplorerId matches by name and falls back to a raw id', () => {
  const explorers = [{ id: 'e-1', name: 'RUNZERO-AGENT-01' }]
  assert.equal(resolveExplorerId(explorers, 'RUNZERO-AGENT-01'), 'e-1')
  assert.equal(resolveExplorerId(explorers, 'e-explicit'), 'e-explicit')
})

test('findExplorerById looks up by resolved id', () => {
  const explorers: RunzeroExplorer[] = [{ id: 'e-1', name: 'A', site_id: 's-1' }]
  assert.equal(findExplorerById(explorers, 'e-1')?.site_id, 's-1')
  assert.equal(findExplorerById(explorers, 'nope'), null)
})

test('resolveSiteId matches by name and falls back to a raw id', () => {
  const sites = [{ id: 's-1', name: 'HQ' }]
  assert.equal(resolveSiteId(sites, 'HQ'), 's-1')
  assert.equal(resolveSiteId(sites, 's-explicit'), 's-explicit')
})

test('buildPatchedSettings omits keys that are not declared', () => {
  const sites = [{ id: 's-1', name: 'HQ' }]
  assert.deepEqual(buildPatchedSettings({ site: 'HQ' }, sites), { site_id: 's-1' })
  assert.deepEqual(buildPatchedSettings({ maxConcurrentScans: 5 }, sites), { settings: { max_concurrent_scans: 5 } })
  assert.deepEqual(buildPatchedSettings({}, sites), {})
})

test('coerceList accepts a bare array and a { data } envelope', () => {
  assert.equal(coerceList([{ id: '1' }]).length, 1)
  assert.equal(coerceList({ data: [{ id: '1' }, { id: '2' }] }).length, 2)
  assert.equal(coerceList(null).length, 0)
})
