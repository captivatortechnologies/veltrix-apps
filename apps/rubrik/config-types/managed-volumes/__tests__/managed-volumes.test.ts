import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  BYTES_PER_GIB,
  buildManagedVolumeBody,
  buildManagedVolumePatchBody,
  findManagedVolumeByName,
  managedVolumeToFields,
  managedVolumesFromList,
  normalizeApplicationTag,
  summarizeManagedVolume,
  type RubrikManagedVolume,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Rubrik CDM REST API via
 * node:https inside rubrikApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared.ts builders, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'oracle-mv', numChannels: 2, volumeSizeGb: 100, applicationTag: 'Oracle' }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects zero channels', async () => {
  const res = await validate(ctxOf([{ ...good, numChannels: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NO_CHANNELS'))
})

test('validate rejects zero size', async () => {
  const res = await validate(ctxOf([{ ...good, volumeSizeGb: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NO_SIZE'))
})

test('validate rejects duplicate names', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('validate warns on a high channel count', async () => {
  const res = await validate(ctxOf([{ ...good, numChannels: 12 }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'HIGH_CHANNELS'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed managed volume', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- normalizeApplicationTag ------------------------------------------------

test('normalizeApplicationTag keeps known tags and drops unknown ones', () => {
  assert.equal(normalizeApplicationTag('PostgreSql'), 'PostgreSql')
  assert.equal(normalizeApplicationTag('bogus'), undefined)
  assert.equal(normalizeApplicationTag(''), undefined)
})

// --- buildManagedVolumeBody -------------------------------------------------

test('buildManagedVolumeBody converts GiB to bytes and emits channels', () => {
  const body = buildManagedVolumeBody({ name: '  mv  ', numChannels: 4, volumeSizeGb: 2 }) as Record<string, unknown>
  assert.equal(body.name, 'mv')
  assert.equal(body.numChannels, 4)
  assert.equal(body.volumeSize, 2 * BYTES_PER_GIB)
})

test('buildManagedVolumeBody omits size/subnet/tag/export when unset', () => {
  const body = buildManagedVolumeBody({ name: 'mv', numChannels: 1, volumeSizeGb: 0 }) as Record<string, unknown>
  assert.equal('volumeSize' in body, false)
  assert.equal('subnet' in body, false)
  assert.equal('applicationTag' in body, false)
  assert.equal('exportConfig' in body, false)
})

test('buildManagedVolumeBody nests host patterns under exportConfig', () => {
  const body = buildManagedVolumeBody({ name: 'mv', numChannels: 1, volumeSizeGb: 1, hostPatterns: ['db-*', '10.0.0.0/24'] }) as { exportConfig?: { hostPatterns?: string[] } }
  assert.deepEqual(body.exportConfig?.hostPatterns, ['db-*', '10.0.0.0/24'])
})

test('buildManagedVolumePatchBody carries only the mutable subset', () => {
  const patch = buildManagedVolumePatchBody({ name: 'mv', numChannels: 8, volumeSizeGb: 500, hostPatterns: ['h1'] }) as Record<string, unknown>
  assert.equal(patch.name, 'mv')
  assert.equal('numChannels' in patch, false)
  assert.equal('volumeSize' in patch, false)
  assert.deepEqual((patch.exportConfig as { hostPatterns: string[] }).hostPatterns, ['h1'])
})

// --- round-trip prior -> fields --------------------------------------------

test('managedVolumeToFields inverts a live MV back to canvas fields (bytes -> GiB)', () => {
  const mv: RubrikManagedVolume = { id: '1', name: 'mv', numChannels: 3, volumeSize: 5 * BYTES_PER_GIB, applicationTag: 'MsSql', exportConfig: { hostPatterns: ['h1'] } }
  const f = managedVolumeToFields(mv)
  assert.equal(f.volumeSizeGb, 5)
  assert.equal(f.numChannels, 3)
  assert.equal(f.applicationTag, 'MsSql')
  assert.deepEqual(f.hostPatterns, ['h1'])
})

// --- list parsing + identity match ------------------------------------------

test('managedVolumesFromList unwraps the { data } envelope and bare arrays', () => {
  assert.equal(managedVolumesFromList({ data: [{ name: 'A' }], total: 1 }).length, 1)
  assert.equal(managedVolumesFromList([{ name: 'B' }]).length, 1)
  assert.equal(managedVolumesFromList(null).length, 0)
})

test('findManagedVolumeByName matches on the exact trimmed name', () => {
  const list: RubrikManagedVolume[] = [{ id: '1', name: 'mv-a' }, { id: '2', name: 'mv-b' }]
  assert.equal(findManagedVolumeByName(list, ' mv-a ')?.id, '1')
  assert.equal(findManagedVolumeByName(list, 'mv-x'), null)
})

// --- drift summary ----------------------------------------------------------

test('summarizeManagedVolume flattens fields and sorts host patterns', () => {
  const s = summarizeManagedVolume({ numChannels: 2, volumeSize: BYTES_PER_GIB, applicationTag: 'Oracle', subnet: '10.0.0.0/24', exportConfig: { hostPatterns: ['b', 'a'] } })
  assert.equal(s.channels, '2')
  assert.equal(s.sizeBytes, String(BYTES_PER_GIB))
  assert.equal(s.applicationTag, 'Oracle')
  assert.equal(s.hostPatterns, 'a|b')
})
