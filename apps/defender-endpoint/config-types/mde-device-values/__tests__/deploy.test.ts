// =============================================================================
// Deploy handler tests against a FAKE Defender API.
//
// `deviceValue` is SINGLE-VALUED on a machine, so every deploy here overwrites
// whatever criticality the device carried. The properties that matter in
// production are that it reads the prior value before overwriting it, that it
// writes nothing when the device already matches, and that a device that no
// longer exists does not fail the whole deploy.
// =============================================================================

import deploy from '../deploy'
import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { DeviceValueRollbackEntry } from '../deploy'
import { MACHINE_ID, apiError, deployCtx, mockMdeFetch, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-device-values'
const OTHER_MACHINE_ID = 'e'.repeat(40)

/** A single-machine GET; the $filter listing carries a query string instead. */
const isSingleGet = (url: string): boolean => /\/api\/machines\/[^/?]+$/.test(url)

function item(fields: Record<string, unknown> = {}, name = 'Domain controller'): CanvasItemSnapshot {
  return {
    name,
    fields: { device_type: 'id', device: MACHINE_ID, criticality: 'High', ...fields },
  }
}

const rollbackEntries = (result: { rollbackData?: unknown }): DeviceValueRollbackEntry[] =>
  (result.rollbackData as { previousState?: DeviceValueRollbackEntry[] })?.previousState ?? []

describe('Defender Device Values Deploy Handler', () => {
  it('refuses before touching Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await deploy(deployCtx(TYPE, [item()], { credential: null }))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Client ID')
    expect(calls).toHaveLength(0)
  })

  it('reads the device before overwriting its criticality', async () => {
    const calls = mockMdeFetch((method) =>
      method === 'GET'
        ? { status: 200, body: { id: MACHINE_ID, computerDnsName: 'dc01.contoso.com', deviceValue: 'Normal' } }
        : { status: 200, body: {} },
    )
    const result = await deploy(deployCtx(TYPE, [item()]))

    const vendor = vendorCalls(calls)
    expect(vendor[0].method).toBe('GET')
    expect(vendor[0].url).toContain(`/api/machines/${MACHINE_ID}`)
    expect(vendor[1].method).toBe('PATCH')
    expect(vendor[1].url).toContain(`/api/machines/${MACHINE_ID}`)
    expect(vendor[1].body).toEqual({ deviceValue: 'High' })
    expect(result.success).toBe(true)
    expect(result.artifacts?.applied).toEqual(['High on dc01.contoso.com'])
  })

  it('records the prior criticality so rollback can put it back', async () => {
    mockMdeFetch((method) =>
      method === 'GET'
        ? { status: 200, body: { id: MACHINE_ID, computerDnsName: 'dc01.contoso.com', deviceValue: 'Low' } }
        : { status: 200, body: {} },
    )
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(rollbackEntries(result)).toHaveLength(1)
    expect(rollbackEntries(result)[0].previousValue).toBe('Low')
    expect(rollbackEntries(result)[0].machineId).toBe(MACHINE_ID)
  })

  it('treats a device with no criticality set as Normal', async () => {
    mockMdeFetch((method) =>
      method === 'GET' ? { status: 200, body: { id: MACHINE_ID } } : { status: 200, body: {} },
    )
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(rollbackEntries(result)[0].previousValue).toBe('Normal')
  })

  it('writes nothing when the device already carries the declared criticality', async () => {
    const calls = mockMdeFetch(() => ({
      status: 200,
      body: { id: MACHINE_ID, computerDnsName: 'dc01.contoso.com', deviceValue: 'High' },
    }))
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(vendorCalls(calls).filter((c) => c.method === 'PATCH')).toHaveLength(0)
    // Nothing changed, so rollback has nothing to undo — but the device still counts as applied.
    expect(rollbackEntries(result)).toHaveLength(0)
    expect(result.artifacts?.applied).toEqual(['High on dc01.contoso.com'])
    expect(result.success).toBe(true)
  })

  it('skips a device that no longer exists instead of failing the deploy', async () => {
    const calls = mockMdeFetch(() => ({ status: 404, body: apiError('ResourceNotFound') }))
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(true)
    expect(result.message).toContain('1 device(s) not found and skipped')
    expect(result.artifacts?.missingDevices).toEqual([MACHINE_ID])
    expect(vendorCalls(calls).filter((c) => c.method === 'PATCH')).toHaveLength(0)
  })

  it('resolves a device by computer name and applies the value to every match', async () => {
    const calls = mockMdeFetch((method) =>
      method === 'GET'
        ? {
            status: 200,
            body: {
              value: [
                { id: MACHINE_ID, computerDnsName: 'web01.contoso.com', deviceValue: 'Normal' },
                { id: OTHER_MACHINE_ID, computerDnsName: 'web01.contoso.com', deviceValue: 'Normal' },
              ],
            },
          }
        : { status: 200, body: {} },
    )
    const result = await deploy(deployCtx(TYPE, [item({ device_type: 'name', device: 'web01.contoso.com' })]))

    const listCall = vendorCalls(calls).find((c) => c.method === 'GET')
    expect(listCall?.url).toContain('computerDnsName')
    expect(vendorCalls(calls).filter((c) => c.method === 'PATCH')).toHaveLength(2)
    expect(rollbackEntries(result)).toHaveLength(2)
    expect(result.success).toBe(true)
  })

  it('returns a FAILED result instead of throwing when Defender rejects the write', async () => {
    mockMdeFetch((method) =>
      method === 'GET'
        ? { status: 200, body: { id: MACHINE_ID, deviceValue: 'Normal' } }
        : { status: 403, body: apiError('Machine.ReadWrite.All is required') },
    )
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Machine.ReadWrite.All is required')
    expect(result.message).toContain('failed after 0 device(s)')
  })

  it('returns a FAILED result instead of throwing when the device lookup itself errors', async () => {
    const calls = mockMdeFetch(() => ({ status: 500, body: apiError('service unavailable') }))
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Failed to resolve device')
    expect(vendorCalls(calls).filter((c) => c.method === 'PATCH')).toHaveLength(0)
  })

  it('keeps what it already applied when a later device is rejected', async () => {
    mockMdeFetch((method, url) => {
      if (method === 'GET') {
        return { status: 200, body: { id: isSingleGet(url) ? url.split('/').pop() : MACHINE_ID, deviceValue: 'Normal' } }
      }
      return url.includes(OTHER_MACHINE_ID) ? { status: 500, body: apiError('boom') } : { status: 200, body: {} }
    })
    const result = await deploy(
      deployCtx(TYPE, [item({}, 'first'), item({ device: OTHER_MACHINE_ID }, 'second')]),
    )

    expect(result.success).toBe(false)
    expect(result.message).toContain('failed after 1 device(s)')
    expect(rollbackEntries(result)).toHaveLength(1)
    expect(rollbackEntries(result)[0].machineId).toBe(MACHINE_ID)
  })

  it('skips canvas items with no device or no criticality', async () => {
    const calls = mockMdeFetch((method) =>
      method === 'GET' ? { status: 200, body: { id: MACHINE_ID, deviceValue: 'Normal' } } : { status: 200, body: {} },
    )
    const result = await deploy(
      deployCtx(TYPE, [{ name: 'blank', fields: {} }, { name: 'no criticality', fields: { device: MACHINE_ID } }, item()]),
    )

    expect(vendorCalls(calls).filter((c) => c.method === 'PATCH')).toHaveLength(1)
    expect(result.success).toBe(true)
  })
})
