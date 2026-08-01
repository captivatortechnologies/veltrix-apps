import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  expectedExtension,
  fileNameMatchesType,
  findScriptByFileName,
  idFromLocation,
  normalizeContent,
  parseScriptFields,
  scriptFormFields,
  scriptItemPath,
  scriptUpdatePath,
  scriptsFromResponse,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Vision One REST API via fetch
 * (multipart uploads), impractical to mock here. Tests focus on validate.ts and the
 * pure _shared helpers (identity matching, field parsing, path building) — all
 * network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.fileName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  fileName: 'collect-logs.ps1',
  fileType: 'powershell',
  scriptContent: 'Write-Output "hello"',
  description: 'collects logs',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed custom script', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a bash script with a .sh name', async () => {
  const res = await validate(ctxOf([{ fileName: 'triage.sh', fileType: 'bash', scriptContent: 'echo hi' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a missing file name', async () => {
  const res = await validate(ctxOf([{ ...good, fileName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_FILENAME'))
})

test('validate rejects a file name without a .ps1/.sh extension', async () => {
  const res = await validate(ctxOf([{ ...good, fileName: 'collect-logs' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FILENAME'))
})

test('validate rejects a file name with a path separator', async () => {
  const res = await validate(ctxOf([{ ...good, fileName: 'sub/collect-logs.ps1' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FILENAME'))
})

test('validate rejects an unknown file type', async () => {
  const res = await validate(ctxOf([{ ...good, fileType: 'python' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FILE_TYPE'))
})

test('validate rejects an extension that does not match the file type', async () => {
  const res = await validate(ctxOf([{ ...good, fileName: 'collect-logs.sh', fileType: 'powershell' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EXTENSION_TYPE_MISMATCH'))
})

test('validate rejects empty script content', async () => {
  const res = await validate(ctxOf([{ ...good, scriptContent: '   ' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONTENT'))
})

test('validate rejects an over-length description', async () => {
  const res = await validate(ctxOf([{ ...good, description: 'x'.repeat(501) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('validate warns on a duplicate file name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_FILENAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ----------------------------------------------------------

test('expectedExtension maps file types to extensions', () => {
  assert.equal(expectedExtension('powershell'), '.ps1')
  assert.equal(expectedExtension('bash'), '.sh')
  assert.equal(expectedExtension('python'), null)
})

test('fileNameMatchesType checks the extension against the type', () => {
  assert.equal(fileNameMatchesType('a.ps1', 'powershell'), true)
  assert.equal(fileNameMatchesType('a.sh', 'bash'), true)
  assert.equal(fileNameMatchesType('a.sh', 'powershell'), false)
})

test('parseScriptFields returns a script for valid fields and null otherwise', () => {
  const parsed = parseScriptFields(good)
  assert.ok(parsed)
  assert.equal(parsed?.fileName, 'collect-logs.ps1')
  assert.equal(parsed?.fileType, 'powershell')
  assert.equal(parseScriptFields({ ...good, fileType: 'python' }), null)
  assert.equal(parseScriptFields({ ...good, scriptContent: '' }), null)
})

test('scriptFormFields includes description only when present', () => {
  assert.deepEqual(scriptFormFields({ fileName: 'a.sh', fileType: 'bash', content: 'x', description: 'd' }), {
    fileType: 'bash',
    description: 'd',
  })
  assert.deepEqual(scriptFormFields({ fileName: 'a.sh', fileType: 'bash', content: 'x', description: '' }), {
    fileType: 'bash',
  })
})

test('path builders encode the script id', () => {
  assert.equal(scriptItemPath('abc 123'), '/response/customScripts/abc%20123')
  assert.equal(scriptUpdatePath('abc'), '/response/customScripts/abc/update')
})

test('findScriptByFileName matches on the exact trimmed file name', () => {
  const live = [{ id: '1', fileName: 'collect-logs.ps1' }, { id: '2', fileName: 'triage.sh' }]
  assert.equal(findScriptByFileName(live, 'triage.sh')?.id, '2')
  assert.equal(findScriptByFileName(live, 'missing.ps1'), null)
})

test('scriptsFromResponse unwraps both the items and bare-array shapes', () => {
  assert.equal(scriptsFromResponse({ items: [{ id: '1' }, { id: '2' }] }).length, 2)
  assert.equal(scriptsFromResponse([{ id: '3' }]).length, 1)
  assert.equal(scriptsFromResponse(null).length, 0)
})

test('idFromLocation extracts the last path segment of a Location header', () => {
  assert.equal(idFromLocation({ location: 'https://api.xdr.trendmicro.com/v3.0/response/customScripts/abc123' }), 'abc123')
  assert.equal(idFromLocation({ location: '/v3.0/response/customScripts/xyz/' }), 'xyz')
  assert.equal(idFromLocation({}), null)
})

test('normalizeContent unifies line endings and trims trailing whitespace', () => {
  assert.equal(normalizeContent('echo hi\r\n'), 'echo hi')
  assert.equal(normalizeContent('echo hi\n\n  '), 'echo hi')
})
