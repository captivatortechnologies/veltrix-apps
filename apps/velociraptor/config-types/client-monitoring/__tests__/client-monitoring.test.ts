import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  mergeClientMonitoring,
  liveArtifactsForLabel,
  readClientMonitoring,
  setClientMonitoringVQL,
  isAllClientsLabel,
  GET_CLIENT_MONITORING_VQL,
  type ClientMonitoringConfig,
} from '../_shared'
import { splitList, asBool } from '../../../lib/velociraptorApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.label ?? i), fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

// --- validate -----------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires artifacts when a group is enabled', async () => {
  const res = await validate(ctxOf([{ label: 'Servers', artifacts: '', enabled: true }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ARTIFACTS'))
})

test('validate allows an empty artifact list when disabled', async () => {
  const res = await validate(ctxOf([{ label: 'Servers', artifacts: '', enabled: false }]))
  assert.equal(res.valid, true)
})

test('validate accepts a good group', async () => {
  const res = await validate(ctxOf([{ label: 'All', artifacts: 'Windows.Events.ProcessCreation\nGeneric.Client.Stats', enabled: true }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate label (case-insensitive)', async () => {
  const res = await validate(ctxOf([
    { label: 'Servers', artifacts: 'A', enabled: true },
    { label: 'servers', artifacts: 'B', enabled: true },
  ]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_LABEL'))
})

// --- helpers ------------------------------------------------------------------

test('splitList splits on commas and newlines, dedupes, trims', () => {
  assert.deepEqual(splitList('A, B\nC ,, A'), ['A', 'B', 'C'])
  assert.deepEqual(splitList(''), [])
  assert.deepEqual(splitList(null), [])
})

test('asBool coerces string / number / boolean forms', () => {
  assert.equal(asBool(true), true)
  assert.equal(asBool('false'), false)
  assert.equal(asBool('yes'), true)
  assert.equal(asBool(0), false)
  assert.equal(asBool(undefined, true), true)
})

test('isAllClientsLabel treats empty and "all" as all-clients', () => {
  assert.equal(isAllClientsLabel(''), true)
  assert.equal(isAllClientsLabel('All'), true)
  assert.equal(isAllClientsLabel('all'), true)
  assert.equal(isAllClientsLabel('Servers'), false)
})

// --- merge (ClientEventTable shaping) -----------------------------------------

test('mergeClientMonitoring sets the all-clients group at the top level', () => {
  const merged = mergeClientMonitoring(null, [{ label: 'All', artifacts: ['A', 'B'], enabled: true }])
  assert.deepEqual(merged.artifacts?.artifacts, ['A', 'B'])
  assert.deepEqual(merged.label_events, [])
})

test('mergeClientMonitoring upserts a labelled group into label_events', () => {
  const merged = mergeClientMonitoring(null, [{ label: 'Servers', artifacts: ['A'], enabled: true }])
  assert.equal(merged.label_events?.length, 1)
  assert.equal(merged.label_events?.[0].label, 'Servers')
  assert.deepEqual(merged.label_events?.[0].artifacts?.artifacts, ['A'])
})

test('mergeClientMonitoring replaces an existing labelled group and preserves others', () => {
  const current: ClientMonitoringConfig = {
    artifacts: { artifacts: ['Base'] },
    label_events: [
      { label: 'Servers', artifacts: { artifacts: ['Old'] } },
      { label: 'Workstations', artifacts: { artifacts: ['Keep'] } },
    ],
  }
  const merged = mergeClientMonitoring(current, [{ label: 'Servers', artifacts: ['New'], enabled: true }])
  assert.deepEqual(liveArtifactsForLabel(merged, 'Servers'), ['New'])
  assert.deepEqual(liveArtifactsForLabel(merged, 'Workstations'), ['Keep'])
  assert.deepEqual(liveArtifactsForLabel(merged, 'All'), ['Base'])
})

test('mergeClientMonitoring clears a disabled group to an empty list', () => {
  const merged = mergeClientMonitoring(null, [{ label: 'Servers', artifacts: ['A'], enabled: false }])
  assert.deepEqual(liveArtifactsForLabel(merged, 'Servers'), [])
})

test('mergeClientMonitoring does not mutate the input config', () => {
  const current: ClientMonitoringConfig = { artifacts: { artifacts: ['Base'] }, label_events: [] }
  mergeClientMonitoring(current, [{ label: 'All', artifacts: ['X'], enabled: true }])
  assert.deepEqual(current.artifacts?.artifacts, ['Base'])
})

// --- reading + VQL ------------------------------------------------------------

test('readClientMonitoring pulls the config column', () => {
  const cfg = readClientMonitoring([{ config: { artifacts: { artifacts: ['A'] } } }])
  assert.deepEqual(cfg?.artifacts?.artifacts, ['A'])
  assert.equal(readClientMonitoring([]), null)
})

test('setClientMonitoringVQL wraps the JSON in parse_json + set_client_monitoring', () => {
  const vql = setClientMonitoringVQL('{"artifacts":{"artifacts":["A"]}}')
  assert.match(vql, /set_client_monitoring\(value=parse_json\(data='/)
  assert.match(vql, /FROM scope\(\)/)
})

test('GET_CLIENT_MONITORING_VQL reads the current state', () => {
  assert.match(GET_CLIENT_MONITORING_VQL, /get_client_monitoring\(\)/)
})
