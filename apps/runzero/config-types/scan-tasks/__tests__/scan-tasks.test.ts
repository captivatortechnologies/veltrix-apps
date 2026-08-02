import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildScanOptions,
  buildTaskUpdate,
  taskUpdateFromPrior,
  normalizeFrequency,
  normalizeTargets,
  resolveSiteId,
  findRecurringTask,
  type RunzeroTask,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift/health hit the runZero console API via fetch, which is impractical to
 * mock here. Tests focus on validate.ts and the network-free _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.scanName ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { scanName: 'Nightly HQ', site: 'HQ', targets: 'defaults', frequency: 'daily' }

// --- validate -------------------------------------------------------------

test('validate rejects a missing scan name', async () => {
  const res = await validate(ctxOf([{ ...good, scanName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing site', async () => {
  const res = await validate(ctxOf([{ ...good, site: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SITE'))
})

test('validate rejects empty targets', async () => {
  const res = await validate(ctxOf([{ ...good, targets: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TARGETS'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects an unknown frequency', async () => {
  const res = await validate(ctxOf([{ ...good, frequency: 'fortnightly' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FREQUENCY'))
})

test('validate accepts a valid scan task', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate (site + name)', async () => {
  const res = await validate(ctxOf([good, { ...good, targets: '10.0.0.0/24' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TASK'))
})

// --- _shared helpers ------------------------------------------------------

test('normalizeFrequency maps to the vocabulary and defaults unknown to once', () => {
  assert.equal(normalizeFrequency('WEEKLY'), 'weekly')
  assert.equal(normalizeFrequency('bogus'), 'once')
  assert.equal(normalizeFrequency(''), 'once')
})

test('normalizeTargets collapses newlines/commas to a single space-separated string', () => {
  assert.equal(normalizeTargets('10.0.0.0/24, 192.168.1.1\n\n 172.16.0.0/16 '), '10.0.0.0/24 192.168.1.1 172.16.0.0/16')
  assert.equal(normalizeTargets('defaults'), 'defaults')
  assert.equal(normalizeTargets(''), '')
})

test('buildScanOptions maps camelCase fields onto hyphenated ScanOptions keys', () => {
  const opts = buildScanOptions({
    scanName: '  Nightly  ',
    site: 'HQ',
    targets: '10.0.0.0/24, 10.0.1.0/24',
    frequency: 'daily',
    description: 'nightly sweep',
    tcpPorts: '1-1000',
    tags: 'owner=IT',
  })
  assert.equal(opts['scan-name'], 'Nightly')
  assert.equal(opts.targets, '10.0.0.0/24 10.0.1.0/24')
  assert.equal(opts['scan-frequency'], 'daily')
  assert.equal(opts['scan-description'], 'nightly sweep')
  assert.equal(opts['tcp-ports'], '1-1000')
  assert.equal(opts['scan-tags'], 'owner=IT')
})

test('buildScanOptions defaults blank targets to "defaults" and omits empty optionals', () => {
  const opts = buildScanOptions({ scanName: 'S', frequency: 'once', targets: '' })
  assert.equal(opts.targets, 'defaults')
  assert.equal('scan-description' in opts, false)
  assert.equal('tcp-ports' in opts, false)
})

test('buildTaskUpdate marks recur false for once and true otherwise, merging prior params', () => {
  const prior: RunzeroTask = { id: 't1', name: 'S', params: { existing: 'keep' } }
  const once = buildTaskUpdate(prior, { scanName: 'S', frequency: 'once', targets: 'defaults' })
  assert.equal(once.recur, false)
  const weekly = buildTaskUpdate(prior, { scanName: 'S', frequency: 'weekly', targets: '10.0.0.0/24', tcpPorts: '80' })
  assert.equal(weekly.recur, true)
  assert.equal(weekly.recur_frequency, 'weekly')
  assert.deepEqual(weekly.params, { existing: 'keep', targets: '10.0.0.0/24', 'tcp-ports': '80' })
})

test('taskUpdateFromPrior echoes the prior recurrence for restore', () => {
  const prior: RunzeroTask = { id: 't1', name: 'S', description: 'd', recur: true, recur_frequency: 'hourly', params: { a: 'b' } }
  assert.deepEqual(taskUpdateFromPrior(prior), {
    name: 'S',
    description: 'd',
    recur: true,
    recur_frequency: 'hourly',
    params: { a: 'b' },
  })
})

test('resolveSiteId maps a site name to its id and passes a raw ref through', () => {
  const sites = [{ id: 's1', name: 'HQ' }, { id: 's2', name: 'Branch' }]
  assert.equal(resolveSiteId(sites, 'hq'), 's1')
  assert.equal(resolveSiteId(sites, 'Branch'), 's2')
  assert.equal(resolveSiteId(sites, 'e77602e0-uuid'), 'e77602e0-uuid')
})

test('findRecurringTask matches only recurring tasks by site + name', () => {
  const tasks: RunzeroTask[] = [
    { id: 't1', name: 'Nightly', site_id: 's1', recur: true, recur_frequency: 'daily' },
    { id: 't2', name: 'Nightly', site_id: 's1', recur: false }, // a one-off run — ignored
    { id: 't3', name: 'Other', site_id: 's1', recur: true },
  ]
  assert.equal(findRecurringTask(tasks, 's1', 'nightly')?.id, 't1')
  assert.equal(findRecurringTask(tasks, 's1', 'missing'), null)
  assert.equal(findRecurringTask(tasks, 's2', 'Nightly'), null)
})
