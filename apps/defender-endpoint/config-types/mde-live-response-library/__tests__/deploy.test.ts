// =============================================================================
// Deploy handler tests against a FAKE Defender API.
//
// This is the only handler in the app that sends multipart/form-data. Two things
// there break in production and nowhere else: the upload must NOT carry a
// hand-set Content-Type (the boundary comes from the FormData body itself), and
// OverrideIfExists must be set or a re-deploy fails on an existing name.
// =============================================================================

import deploy from '../deploy'
import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { LibraryFileRollbackEntry } from '../deploy'
import { apiError, deployCtx, mockMdeFetchRaw } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-live-response-library'
const FILE_NAME = 'Get-Logs.ps1'
const CONTENT = 'Get-EventLog -LogName Security -Newest 100\n'

function item(fields: Record<string, unknown> = {}, name = 'Collect security log'): CanvasItemSnapshot {
  return {
    name,
    fields: {
      file_name: FILE_NAME,
      description: 'Collects the last 100 security events',
      has_parameters: false,
      parameters_description: '',
      content: CONTENT,
      ...fields,
    },
  }
}

const emptyLibrary = (method: string) =>
  method === 'GET' ? { status: 200, body: { value: [] } } : { status: 200, body: {} }

const rollbackEntries = (result: { rollbackData?: unknown }): LibraryFileRollbackEntry[] =>
  (result.rollbackData as { previousState?: LibraryFileRollbackEntry[] })?.previousState ?? []

const vendor = (calls: ReturnType<typeof mockMdeFetchRaw>) => calls.filter((c) => !c.url.includes('/oauth2/'))

describe('Defender Live Response Library Deploy Handler', () => {
  it('refuses before touching Defender when no credential is configured', async () => {
    const calls = mockMdeFetchRaw(emptyLibrary)
    const result = await deploy(deployCtx(TYPE, [item()], { credential: null }))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Client ID')
    expect(calls).toHaveLength(0)
  })

  it('lists the library, then uploads the file as multipart with OverrideIfExists set', async () => {
    const calls = mockMdeFetchRaw(emptyLibrary)
    const result = await deploy(deployCtx(TYPE, [item()]))

    const made = vendor(calls)
    expect(made[0].method).toBe('GET')
    expect(made[0].url).toContain('/api/libraryfiles')
    expect(made[1].method).toBe('POST')
    expect(made[1].url).toContain('/api/libraryfiles')

    const form = made[1].init.body as FormData
    expect(form.get('OverrideIfExists')).toBe('true')
    expect(form.get('Description')).toBe('Collects the last 100 security events')
    const file = form.get('File') as unknown as { name: string; text: () => Promise<string> }
    expect(file.name).toBe(FILE_NAME)
    expect(await file.text()).toBe(CONTENT)
    expect(result.success).toBe(true)
    expect(result.message).toContain('Uploaded 1 Live Response library file(s)')
  })

  it('sets no Content-Type of its own, so the multipart boundary is the one the body carries', async () => {
    const calls = mockMdeFetchRaw(emptyLibrary)
    await deploy(deployCtx(TYPE, [item()]))

    const headers = vendor(calls)[1].init.headers ?? {}
    expect(Object.keys(headers).map((k) => k.toLowerCase())).toContain('authorization')
    expect(Object.keys(headers).map((k) => k.toLowerCase()).includes('content-type')).toBe(false)
  })

  it('records a newly created file so rollback can delete it cleanly', async () => {
    mockMdeFetchRaw(emptyLibrary)
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(rollbackEntries(result)).toHaveLength(1)
    expect(rollbackEntries(result)[0].existed).toBe(false)
    expect(rollbackEntries(result)[0].fileName).toBe(FILE_NAME)
  })

  it('records an overwritten file as pre-existing, matching the name case-insensitively', async () => {
    mockMdeFetchRaw((method) =>
      method === 'GET'
        ? { status: 200, body: { value: [{ fileName: FILE_NAME.toUpperCase(), sha256: 'abc' }] } }
        : { status: 200, body: {} },
    )
    const result = await deploy(deployCtx(TYPE, [item()]))

    // Windows file names are not case-sensitive: uploading Get-Logs.ps1 over
    // GET-LOGS.PS1 replaces it, so rollback must not treat it as newly created.
    expect(rollbackEntries(result)[0].existed).toBe(true)
  })

  it('returns a FAILED result instead of throwing when the upload is rejected', async () => {
    mockMdeFetchRaw((method) =>
      method === 'GET' ? { status: 200, body: { value: [] } } : { status: 403, body: apiError('Library.Manage is required') },
    )
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Library.Manage is required')
    expect(result.message).toContain('failed after 0 of 1')
  })

  it('uploads nothing when the library listing cannot be read', async () => {
    const calls = mockMdeFetchRaw(() => ({ status: 500, body: apiError('service unavailable') }))
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Failed to list Live Response library files')
    expect(vendor(calls).filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('keeps the rollback state for what it already uploaded when a later file is rejected', async () => {
    let uploads = 0
    mockMdeFetchRaw((method) => {
      if (method === 'GET') return { status: 200, body: { value: [] } }
      uploads += 1
      return uploads === 1 ? { status: 200, body: {} } : { status: 413, body: apiError('file too large') }
    })
    const result = await deploy(
      deployCtx(TYPE, [item(), item({ file_name: 'Collect-Dump.ps1' }, 'Collect dump')]),
    )

    expect(result.success).toBe(false)
    expect(result.message).toContain('failed after 1 of 2')
    expect(rollbackEntries(result)).toHaveLength(1)
    expect(rollbackEntries(result)[0].fileName).toBe(FILE_NAME)
  })

  it('skips canvas items with no file name or no content', async () => {
    const calls = mockMdeFetchRaw(emptyLibrary)
    const result = await deploy(
      deployCtx(TYPE, [{ name: 'blank', fields: {} }, { name: 'empty', fields: { file_name: 'x.ps1', content: '' } }, item()]),
    )

    expect(vendor(calls).filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(result.success).toBe(true)
  })
})
