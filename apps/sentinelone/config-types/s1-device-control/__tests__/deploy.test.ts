import deploy, { type DeviceRuleRollbackEntry } from '../deploy'
import {
  API_TOKEN,
  SCOPELESS_SETTINGS,
  apiError,
  callsTo,
  dataOf,
  deployContext,
  envelope,
  filterOf,
  withFetch,
  type CanvasItemInput,
  type RecordedCall,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-device-control'
const DEVICE = '/device-control'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return deployContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

function deviceRule(fields: Record<string, unknown>): CanvasItemInput {
  return { name: `Rule ${String(fields.rule_name ?? '')}`, fields }
}

const blockUsb = deviceRule({
  rule_name: 'Block mass storage',
  interface: 'USB',
  action: 'Block',
  device_class: '08',
  vendor_id: '0781',
})

function previousState(result: { rollbackData?: unknown }): DeviceRuleRollbackEntry[] {
  return (
    (result.rollbackData as { previousState?: DeviceRuleRollbackEntry[] } | undefined)?.previousState ?? []
  )
}

function createdIds(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdIds?: string[] } | undefined)?.createdIds ?? []
}

function writes(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method !== 'GET')
}

describe('SentinelOne Device Control Deploy Handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ configTypeId: CONFIG_TYPE, credential: null }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([blockUsb], SCOPELESS_SETTINGS))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Scope ID/)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API token and lists at the configured scope', async () => {
    await withFetch([envelope([])], async (calls) => {
      await deploy(ctx([]))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe(DEVICE)
      expect(calls[0].authorization).toBe(`ApiToken ${API_TOKEN}`)
      expect(calls[0].url).toContain('accountIds=act-1')
    })
  })

  it('creates a rule that does not exist yet, mapping the serial id onto `uid`', async () => {
    await withFetch([envelope([]), envelope({ id: 'dc-new' })], async (calls) => {
      const result = await deploy(
        ctx([deviceRule({ rule_name: 'Block one stick', serial_id: 'SN-123', interface: 'USB' })]),
      )

      expect(result.success).toBe(true)
      const posts = callsTo(calls, DEVICE).filter((call) => call.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(filterOf(posts[0])).toEqual({ accountIds: ['act-1'] })
      expect(dataOf(posts[0])).toEqual({
        ruleName: 'Block one stick',
        interface: 'USB',
        action: 'Block',
        accessPermission: 'Not-Applicable',
        deviceClass: '',
        vendorId: '',
        productId: '',
        uid: 'SN-123',
        bluetoothAddress: '',
        status: 'Enabled',
      })
      expect(createdIds(result)).toEqual(['dc-new'])
      expect(previousState(result)[0].existed).toBe(false)
    })
  })

  it('updates a rule matched on its name and records its prior body', async () => {
    const live = {
      id: 'dc-1',
      ruleName: 'Block mass storage',
      interface: 'USB',
      action: 'Allow',
      accessPermission: 'Read-Write',
      status: 'Enabled',
    }
    await withFetch([envelope([live]), envelope({})], async (calls) => {
      const result = await deploy(ctx([blockUsb]))

      expect(result.success).toBe(true)
      const puts = callsTo(calls, DEVICE).filter((call) => call.method === 'PUT')
      expect(puts).toHaveLength(1)
      expect(dataOf(puts[0]).id).toBe('dc-1')
      expect(dataOf(puts[0]).action).toBe('Block')
      expect(previousState(result)[0].prior).toEqual(live)
      expect(createdIds(result)).toEqual([])
    })
  })

  it('matches an existing rule whose name differs only by case', async () => {
    await withFetch([envelope([{ id: 'dc-1', ruleName: 'BLOCK MASS STORAGE' }]), envelope({})], async (calls) => {
      await deploy(ctx([blockUsb]))

      expect(callsTo(calls, DEVICE).filter((call) => call.method === 'PUT')).toHaveLength(1)
      expect(callsTo(calls, DEVICE).filter((call) => call.method === 'POST')).toHaveLength(0)
    })
  })

  it('reports failure rather than throwing when the vendor rejects a create', async () => {
    await withFetch([envelope([]), apiError('Device Control is not licensed', 403)], async () => {
      const result = await deploy(ctx([blockUsb]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/not licensed/)
      expect(createdIds(result)).toEqual([])
    })
  })

  it('reports failure when a create returns no id rather than recording a phantom rule', async () => {
    await withFetch([envelope([]), envelope({})], async () => {
      const result = await deploy(ctx([blockUsb]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/returned no id/)
      expect(previousState(result)).toEqual([])
    })
  })

  it('reports failure when the scoped list itself is rejected', async () => {
    await withFetch([apiError('token lacks scope', 401)], async (calls) => {
      const result = await deploy(ctx([blockUsb]))

      expect(result.success).toBe(false)
      expect(writes(calls)).toHaveLength(0)
    })
  })
})
