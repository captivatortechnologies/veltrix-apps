import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildFilesetTemplateBody,
  filesetTemplatesFromList,
  findTemplateByName,
  normalizeOsType,
  summarizeTemplate,
  toStringArray,
  type RubrikFilesetTemplate,
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

const good = { name: 'Linux Home', operatingSystemType: 'Linux', includes: ['/home'] }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a template with no include paths', async () => {
  const res = await validate(ctxOf([{ name: 'Empty', operatingSystemType: 'Linux', includes: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NO_INCLUDES'))
})

test('validate rejects duplicate names', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('validate warns when Windows VSS is set on a Linux template', async () => {
  const res = await validate(ctxOf([{ ...good, useWindowsVss: true }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'VSS_ON_LINUX'))
})

test('validate warns on exceptions without excludes', async () => {
  const res = await validate(ctxOf([{ ...good, exceptions: ['/home/keep'] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EXCEPTIONS_WITHOUT_EXCLUDES'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed template', async () => {
  const res = await validate(ctxOf([{ name: 'App', operatingSystemType: 'Windows', includes: ['C:\\Data'], excludes: ['C:\\Data\\tmp'], exceptions: ['C:\\Data\\tmp\\keep'] }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- toStringArray ----------------------------------------------------------

test('toStringArray accepts arrays and CSV/newline strings, dropping blanks + dupes', () => {
  assert.deepEqual(toStringArray(['/a', ' /b ', '/a', '']), ['/a', '/b'])
  assert.deepEqual(toStringArray('/a, /b\n/a'), ['/a', '/b'])
  assert.deepEqual(toStringArray(undefined), [])
})

// --- normalizeOsType --------------------------------------------------------

test('normalizeOsType keeps known values and defaults the rest to Linux', () => {
  assert.equal(normalizeOsType('Windows'), 'Windows')
  assert.equal(normalizeOsType('Linux'), 'Linux')
  assert.equal(normalizeOsType('bogus'), 'Linux')
})

// --- buildFilesetTemplateBody -----------------------------------------------

test('buildFilesetTemplateBody emits name, os and path arrays; omits empty extras', () => {
  const body = buildFilesetTemplateBody({ name: '  Home  ', operatingSystemType: 'Linux', includes: ['/home'], excludes: [], exceptions: [] }) as Record<string, unknown>
  assert.equal(body.name, 'Home')
  assert.equal(body.operatingSystemType, 'Linux')
  assert.deepEqual(body.includes, ['/home'])
  assert.deepEqual(body.excludes, [])
  assert.equal('preBackupScript' in body, false)
  assert.equal('useWindowsVss' in body, false) // Linux -> VSS omitted
})

test('buildFilesetTemplateBody emits useWindowsVss only for Windows', () => {
  const win = buildFilesetTemplateBody({ name: 'W', operatingSystemType: 'Windows', includes: ['C:\\D'], useWindowsVss: true }) as Record<string, unknown>
  assert.equal(win.useWindowsVss, true)
})

test('buildFilesetTemplateBody keeps only a valid error-handling enum', () => {
  const ok = buildFilesetTemplateBody({ name: 'A', operatingSystemType: 'Linux', includes: ['/x'], backupScriptErrorHandling: 'continue' }) as Record<string, unknown>
  assert.equal(ok.backupScriptErrorHandling, 'continue')
  const bad = buildFilesetTemplateBody({ name: 'A', operatingSystemType: 'Linux', includes: ['/x'], backupScriptErrorHandling: 'nope' }) as Record<string, unknown>
  assert.equal('backupScriptErrorHandling' in bad, false)
})

// --- list parsing + identity match ------------------------------------------

test('filesetTemplatesFromList unwraps the v1 { data } envelope and bare arrays', () => {
  assert.equal(filesetTemplatesFromList({ data: [{ name: 'A' }], total: 1 }).length, 1)
  assert.equal(filesetTemplatesFromList([{ name: 'B' }]).length, 1)
  assert.equal(filesetTemplatesFromList(null).length, 0)
})

test('findTemplateByName matches on the exact trimmed name', () => {
  const list: RubrikFilesetTemplate[] = [{ id: '1', name: 'Home' }, { id: '2', name: 'Data' }]
  assert.equal(findTemplateByName(list, ' Home ')?.id, '1')
  assert.equal(findTemplateByName(list, 'Nope'), null)
})

// --- drift summary ----------------------------------------------------------

test('summarizeTemplate sorts path sets so ordering is not drift', () => {
  const a = summarizeTemplate({ operatingSystemType: 'Linux', includes: ['/b', '/a'], excludes: [], exceptions: [] })
  const b = summarizeTemplate({ operatingSystemType: 'Linux', includes: ['/a', '/b'], excludes: [], exceptions: [] })
  assert.equal(a.includes, b.includes)
  assert.equal(a.includes, '/a|/b')
})
