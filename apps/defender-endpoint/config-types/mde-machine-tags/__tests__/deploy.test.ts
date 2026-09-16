// =============================================================================
// Deploy handler tests against a FAKE Defender API.
//
// Tagging is additive and shared: the portal, other tools and this app all write
// to the same `machineTags` collection. So the properties that matter are that a
// deploy adds only what is missing, never removes anything it did not declare,
// and records which tags were already there so rollback leaves those alone.
// =============================================================================

import deploy from '../deploy'
import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { MachineTagRollbackEntry } from '../deploy'
import { MACHINE_ID, apiError, deployCtx, mockMdeFetch, vendorCalls } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-machine-tags'
const OTHER_MACHINE_ID = 'e'.repeat(40)

function item(fields: Record<string, unknown> = {}, name = 'Domain controller'): CanvasItemSnapshot {
  return {
    name,
    fields: { device_type: 'id', device_value: MACHINE_ID, tags: 'crown-jewel, pci', ...fields },
  }
}

const rollbackEntries = (result: { rollbackData?: unknown }): MachineTagRollbackEntry[] =>
  (result.rollbackData as { previousState?: MachineTagRollbackEntry[] })?.previousState ?? []

const tagWrites = (calls: ReturnType<typeof vendorCalls>) => calls.filter((c) => c.method === 'POST')

describe('Defender Machine Tags Deploy Handler', () => {
  it('refuses before touching Defender when no credential is configured', async () => {
    const calls = mockMdeFetch(() => ({ status: 200, body: {} }))
    const result = await deploy(deployCtx(TYPE, [item()], { credential: null }))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Client ID')
    expect(calls).toHaveLength(0)
  })

  it('reads the device tags, then adds each declared tag that is missing', async () => {
    const calls = mockMdeFetch((method) =>
      method === 'GET'
        ? { status: 200, body: { id: MACHINE_ID, computerDnsName: 'dc01.contoso.com', machineTags: [] } }
        : { status: 200, body: {} },
    )
    const result = await deploy(deployCtx(TYPE, [item()]))

    const vendor = vendorCalls(calls)
    expect(vendor[0].method).toBe('GET')
    expect(vendor[0].url).toContain(`/api/machines/${MACHINE_ID}`)
    expect(tagWrites(vendor)).toHaveLength(2)
    expect(tagWrites(vendor)[0].url).toContain(`/api/machines/${MACHINE_ID}/tags`)
    expect(tagWrites(vendor)[0].body).toEqual({ Value: 'crown-jewel', Action: 'Add' })
    expect(tagWrites(vendor)[1].body).toEqual({ Value: 'pci', Action: 'Add' })
    expect(result.success).toBe(true)
    expect(result.message).toContain('Applied 2 device tag(s)')
  })

  it('does not re-add a tag that is already on the device, and records it as pre-existing', async () => {
    const calls = mockMdeFetch((method) =>
      method === 'GET'
        ? { status: 200, body: { id: MACHINE_ID, computerDnsName: 'dc01.contoso.com', machineTags: ['Crown-Jewel'] } }
        : { status: 200, body: {} },
    )
    const result = await deploy(deployCtx(TYPE, [item()]))

    // Defender tag comparison is case-insensitive: "Crown-Jewel" IS "crown-jewel".
    expect(tagWrites(vendorCalls(calls))).toHaveLength(1)
    expect(tagWrites(vendorCalls(calls))[0].body).toEqual({ Value: 'pci', Action: 'Add' })

    const entries = rollbackEntries(result)
    expect(entries).toHaveLength(2)
    expect(entries[0].tag).toBe('crown-jewel')
    expect(entries[0].existed).toBe(true)
    expect(entries[1].tag).toBe('pci')
    expect(entries[1].existed).toBe(false)
  })

  it('never removes a tag it did not declare', async () => {
    const calls = mockMdeFetch((method) =>
      method === 'GET'
        ? { status: 200, body: { id: MACHINE_ID, machineTags: ['owned-by-another-tool'] } }
        : { status: 200, body: {} },
    )
    await deploy(deployCtx(TYPE, [item()]))

    for (const write of tagWrites(vendorCalls(calls))) {
      expect((write.body as Record<string, unknown>).Action).toBe('Add')
    }
    expect(vendorCalls(calls).filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })

  it('skips a device that no longer exists instead of failing the deploy', async () => {
    const calls = mockMdeFetch(() => ({ status: 404, body: apiError('ResourceNotFound') }))
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(true)
    expect(result.message).toContain('1 device(s) not found and skipped')
    expect(result.artifacts?.missingDevices).toEqual([MACHINE_ID])
    expect(tagWrites(vendorCalls(calls))).toHaveLength(0)
  })

  it('resolves a device by computer name and tags every match', async () => {
    const calls = mockMdeFetch((method) =>
      method === 'GET'
        ? {
            status: 200,
            body: {
              value: [
                { id: MACHINE_ID, computerDnsName: 'web01.contoso.com', machineTags: [] },
                { id: OTHER_MACHINE_ID, computerDnsName: 'web01.contoso.com', machineTags: ['pci'] },
              ],
            },
          }
        : { status: 200, body: {} },
    )
    const result = await deploy(
      deployCtx(TYPE, [item({ device_type: 'name', device_value: 'web01.contoso.com' })]),
    )

    expect(vendorCalls(calls).find((c) => c.method === 'GET')?.url).toContain('computerDnsName')
    expect(tagWrites(vendorCalls(calls))).toHaveLength(3)
    expect(rollbackEntries(result)).toHaveLength(4)
    expect(result.success).toBe(true)
  })

  it('returns a FAILED result instead of throwing when Defender rejects a tag write', async () => {
    mockMdeFetch((method) =>
      method === 'GET'
        ? { status: 200, body: { id: MACHINE_ID, computerDnsName: 'dc01.contoso.com', machineTags: [] } }
        : { status: 403, body: apiError('Machine.ReadWrite.All is required') },
    )
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Machine.ReadWrite.All is required')
    expect(result.message).toContain('failed after 0 tag(s)')
  })

  it('keeps the rollback state for the tags it already added when a later one is rejected', async () => {
    let writes = 0
    mockMdeFetch((method) => {
      if (method === 'GET') return { status: 200, body: { id: MACHINE_ID, machineTags: [] } }
      writes += 1
      return writes === 1 ? { status: 200, body: {} } : { status: 500, body: apiError('boom') }
    })
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(false)
    expect(result.message).toContain('failed after 1 tag(s)')
    expect(rollbackEntries(result)).toHaveLength(1)
    expect(rollbackEntries(result)[0].tag).toBe('crown-jewel')
  })

  it('returns a FAILED result instead of throwing when the device lookup itself errors', async () => {
    const calls = mockMdeFetch(() => ({ status: 500, body: apiError('service unavailable') }))
    const result = await deploy(deployCtx(TYPE, [item()]))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Failed to resolve device')
    expect(tagWrites(vendorCalls(calls))).toHaveLength(0)
  })

  it('skips canvas items with no device or no tags', async () => {
    const calls = mockMdeFetch((method) =>
      method === 'GET' ? { status: 200, body: { id: MACHINE_ID, machineTags: [] } } : { status: 200, body: {} },
    )
    const result = await deploy(
      deployCtx(TYPE, [
        { name: 'blank', fields: {} },
        { name: 'no tags', fields: { device_value: MACHINE_ID } },
        item({ tags: 'crown-jewel' }),
      ]),
    )

    expect(tagWrites(vendorCalls(calls))).toHaveLength(1)
    expect(result.success).toBe(true)
  })
})
