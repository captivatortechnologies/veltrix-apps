// =============================================================================
// Drift-detection and health handler tests against a FAKE Defender API.
//
// Device tags are shared state, so drift here means "a tag we declared is gone",
// never "a tag we did not declare is present".
// =============================================================================

import driftDetect from '../driftDetect'
import healthCheck from '../healthCheck'
import type { CanvasItemSnapshot, DriftDiff, HealthCheck } from '@veltrixsecops/app-sdk'
import { MACHINE_ID, apiError, driftCtx, healthCtx, mockMdeFetch } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-machine-tags'

/** The reachability probe is the only GET that carries a $top query. */
const isProbe = (url: string): boolean => url.includes('%24top')

function item(fields: Record<string, unknown> = {}): CanvasItemSnapshot {
  return {
    name: 'Domain controller',
    fields: { device_type: 'id', device_value: MACHINE_ID, tags: 'crown-jewel, pci', ...fields },
  }
}

const machine = (tags: string[]) => ({ id: MACHINE_ID, computerDnsName: 'dc01.contoso.com', machineTags: tags })
const find = (diffs: DriftDiff[], field: string): DriftDiff | undefined => diffs.find((d) => d.field === field)
const named = (checks: HealthCheck[], name: string): HealthCheck | undefined => checks.find((c) => c.name === name)

describe('Defender Machine Tags Drift Handler', () => {
  it('makes no call and raises no diff when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await driftDetect(driftCtx(TYPE, [item()], { credential: null }))

    expect(result.hasDrift).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('reports no drift when every declared tag is still on the device', async () => {
    mockMdeFetch(() => ({ status: 200, body: machine(['Crown-Jewel', 'pci', 'someone-elses-tag']) }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('reports a tag that was stripped by hand as a warning', async () => {
    mockMdeFetch(() => ({ status: 200, body: machine(['crown-jewel']) }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    const diff = find(result.diffs, 'dc01.contoso.com.tag:pci')
    expect(diff?.expected).toBe('present')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('warning')
  })

  it('reports a device that no longer resolves as critical drift', async () => {
    mockMdeFetch(() => ({ status: 404, body: apiError('ResourceNotFound') }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(find(result.diffs, `device:${MACHINE_ID}`)?.actual).toBe('not found')
    expect(find(result.diffs, `device:${MACHINE_ID}`)?.severity).toBe('critical')
  })

  it('separates an unreachable API from a missing device', async () => {
    mockMdeFetch(() => ({ status: 500, body: apiError('service unavailable') }))
    const result = await driftDetect(driftCtx(TYPE, [item()]))

    expect(String(find(result.diffs, `device:${MACHINE_ID}`)?.actual)).toContain('unreachable')
  })
})

describe('Defender Machine Tags Health Handler', () => {
  it('fails closed without calling Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await healthCheck(healthCtx(TYPE, [item()], { credential: null }))

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('scores 100 when the API is reachable and every declared tag is present', async () => {
    mockMdeFetch((_method, url) =>
      isProbe(url) ? { status: 200, body: { value: [] } } : { status: 200, body: machine(['crown-jewel', 'pci']) },
    )
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(named(result.checks, 'tag:pci on dc01.contoso.com')?.passed).toBe(true)
  })

  it('fails the check for a tag that has been stripped', async () => {
    mockMdeFetch((_method, url) =>
      isProbe(url) ? { status: 200, body: { value: [] } } : { status: 200, body: machine(['crown-jewel']) },
    )
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(false)
    expect(named(result.checks, 'tag:pci on dc01.contoso.com')?.passed).toBe(false)
    expect(named(result.checks, 'tag:pci on dc01.contoso.com')?.message).toBe('Tag is missing')
  })

  it('reports an outage without probing any device', async () => {
    const calls = mockMdeFetch(() => ({ status: 503, body: apiError('service unavailable') }))
    const result = await healthCheck(healthCtx(TYPE, [item()]))

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(1)
    expect(named(result.checks, 'mde_reachable')?.message).toContain('HTTP 503')
    expect(calls.filter((c) => c.url.includes(MACHINE_ID))).toHaveLength(0)
  })
})
