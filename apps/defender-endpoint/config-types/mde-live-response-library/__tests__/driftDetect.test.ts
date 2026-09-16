// =============================================================================
// Drift-detection handler tests against a FAKE Defender API.
//
// The library API never returns a file's bytes, so drift compares the SHA-256
// of the DECLARED content against the sha256 Defender reports. That is the only
// way a hand-edited script shows up at all — and it must never require reading
// the script content back.
// =============================================================================

import driftDetect, { contentSha256 } from '../driftDetect'
import type { CanvasItemSnapshot, DriftDiff } from '@veltrixsecops/app-sdk'
import { apiError, driftCtx, mockMdeFetch } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-live-response-library'
const FILE_NAME = 'Get-Logs.ps1'
const CONTENT = 'Get-EventLog -LogName Security -Newest 100\n'
const DESCRIPTION = 'Collects the last 100 security events'

function item(fields: Record<string, unknown> = {}): CanvasItemSnapshot {
  return {
    name: 'Collect security log',
    fields: {
      file_name: FILE_NAME,
      description: DESCRIPTION,
      has_parameters: false,
      parameters_description: '',
      content: CONTENT,
      ...fields,
    },
  }
}

function live(extra: Record<string, unknown> = {}) {
  return {
    fileName: FILE_NAME,
    sha256: contentSha256(CONTENT),
    description: DESCRIPTION,
    hasParameters: false,
    ...extra,
  }
}

const listing = (files: unknown[]) => () => ({ status: 200, body: { value: files } })
const find = (diffs: DriftDiff[], field: string): DriftDiff | undefined => diffs.find((d) => d.field === field)

describe('Defender Live Response Library Drift Handler', () => {
  it('makes no call and raises no diff when no credential is configured', async () => {
    const calls = mockMdeFetch(listing([]))
    const result = await driftDetect(driftCtx(TYPE, [item()], { credential: null }))

    expect(result.hasDrift).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('reports no drift when the live file matches content and metadata', async () => {
    mockMdeFetch(listing([live()]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('reports a deleted file as critical drift', async () => {
    mockMdeFetch(listing([]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(find(result.diffs, FILE_NAME)?.expected).toBe('exists')
    expect(find(result.diffs, FILE_NAME)?.severity).toBe('critical')
  })

  it('detects a hand-edited script from its hash alone, without reading the content back', async () => {
    const calls = mockMdeFetch(listing([live({ sha256: 'f'.repeat(64) })]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    const diff = find(result.diffs, `${FILE_NAME}.content`)
    expect(diff?.severity).toBe('warning')
    expect(String(diff?.expected)).toBe(`sha256:${contentSha256(CONTENT)}`)
    expect(String(diff?.actual)).toBe(`sha256:${'f'.repeat(64)}`)
    // Neither side of the comparison logs the script itself.
    expect(String(diff?.expected).includes(CONTENT.trim())).toBe(false)
    expect(calls.filter((c) => c.method !== 'GET' && c.method !== 'POST')).toHaveLength(0)
  })

  it('compares the reported hash case-insensitively', async () => {
    mockMdeFetch(listing([live({ sha256: contentSha256(CONTENT).toUpperCase() })]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(false)
  })

  it('reports an edited description and a flipped parameters flag as warnings', async () => {
    mockMdeFetch(listing([live({ description: 'Changed in the portal', hasParameters: true })]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(find(result.diffs, `${FILE_NAME}.description`)?.actual).toBe('Changed in the portal')
    expect(find(result.diffs, `${FILE_NAME}.description`)?.severity).toBe('warning')
    expect(find(result.diffs, `${FILE_NAME}.hasParameters`)?.expected).toBe(false)
    expect(find(result.diffs, `${FILE_NAME}.hasParameters`)?.actual).toBe(true)
  })

  it('reports the API as unreachable instead of throwing when the listing fails', async () => {
    mockMdeFetch(() => ({ status: 500, body: apiError('service unavailable') }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(true)
    expect(find(result.diffs, 'mde')?.severity).toBe('critical')
  })

  it('ignores library files it never declared', async () => {
    mockMdeFetch(listing([live(), { fileName: 'someone-elses.ps1', sha256: 'abc' }]))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(false)
  })
})
