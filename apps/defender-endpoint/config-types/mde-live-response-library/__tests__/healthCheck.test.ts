// =============================================================================
// Health-check handler tests against a FAKE Defender API.
// =============================================================================

import healthCheck from '../healthCheck'
import { contentSha256 } from '../driftDetect'
import type { CanvasItemSnapshot, HealthCheck } from '@veltrixsecops/app-sdk'
import { API_HOST, apiError, healthCtx, mockMdeFetch } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-live-response-library'
const FILE_NAME = 'Get-Logs.ps1'
const CONTENT = 'Get-EventLog -LogName Security -Newest 100\n'

function item(fields: Record<string, unknown> = {}): CanvasItemSnapshot {
  return {
    name: 'Collect security log',
    fields: { file_name: FILE_NAME, description: 'Collects events', content: CONTENT, ...fields },
  }
}

const listing = (files: unknown[]) => () => ({ status: 200, body: { value: files } })
const named = (checks: HealthCheck[], name: string): HealthCheck | undefined => checks.find((c) => c.name === name)

describe('Defender Live Response Library Health Handler', () => {
  it('fails closed without calling Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(listing([]))
    const result = await healthCheck(healthCtx(TYPE, [item()], { credential: null }))

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks[0].name).toBe('mde_credential')
    expect(calls).toHaveLength(0)
  })

  it('scores 100 when the file is present with the declared content', async () => {
    mockMdeFetch(listing([{ fileName: FILE_NAME, sha256: contentSha256(CONTENT) }]))
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(named(result.checks, 'mde_reachable')?.message).toContain(API_HOST)
    expect(named(result.checks, `file:${FILE_NAME}`)?.message).toBe('Present with matching content')
  })

  it('fails the file check when the content has drifted', async () => {
    mockMdeFetch(listing([{ fileName: FILE_NAME, sha256: 'f'.repeat(64) }]))
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(false)
    expect(named(result.checks, `file:${FILE_NAME}`)?.passed).toBe(false)
    expect(named(result.checks, `file:${FILE_NAME}`)?.message).toBe('Present but content has drifted')
  })

  it('fails the file check when the file is gone', async () => {
    mockMdeFetch(listing([]))
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(named(result.checks, `file:${FILE_NAME}`)?.passed).toBe(false)
    expect(named(result.checks, `file:${FILE_NAME}`)?.message).toBe('File is missing')
    expect(result.score).toBe(50)
  })

  it('reports unreachable rather than throwing, and claims no per-file result it could not check', async () => {
    mockMdeFetch(() => ({ status: 503, body: apiError('service unavailable') }))
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(1)
  })
})
