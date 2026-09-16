import driftDetect from '../driftDetect'
import {
  AUTH_TOKEN,
  EMPTY_LIST,
  NO_BASE_URL_SETTINGS,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  driftContext,
  withFetch,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'device-control-blocks'
const BLOCKS = `/device_control/v3/orgs/${ORG_KEY}/blocks`
const POLICY_SUMMARY = `/policyservice/v1/orgs/${ORG_KEY}/policies/summary`

/** The policy-name -> id lookup drift needs before it can find the block. */
const POLICIES = cbJson({
  policies: [
    { id: 101, name: 'Standard' },
    { id: 202, name: 'Restricted' },
  ],
})

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function block(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.policyName ?? ''), fields }
}

const DEPLOYED = block({ policyName: 'Standard', allowWrite: true, allowExecute: false })

const IN_SYNC = {
  id: 'blk-1',
  policy_id: 101,
  windows: { approved_devices: { allow_write: true, allow_execute: false } },
}

function fields(result: { diffs: Array<{ field: string }> }): string[] {
  return result.diffs.map((d) => d.field)
}

describe('carbon-black device-control-blocks driftDetect handler', () => {
  it('reports no drift without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift when the Org Key setting is blank', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift when the region base URL is blank', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { settings: NO_BASE_URL_SETTINGS }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('finds no drift when the live block matches what was deployed', async () => {
    await withFetch([POLICIES, cbJson({ results: [IN_SYNC] })], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(2)
      expect(calls[0].path).toBe(POLICY_SUMMARY)
      expect(calls[1].path).toBe(BLOCKS)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
    })
  })

  it('flags a deleted block as critical — that policy no longer enforces device control', async () => {
    await withFetch([POLICIES, EMPTY_LIST], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Standard')
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('absent')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('flags a policy that no longer exists as critical too', async () => {
    await withFetch([cbJson({ policies: [{ id: 202, name: 'Restricted' }] }), cbJson({ results: [IN_SYNC] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // The name no longer resolves, so the block cannot be found at all.
      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Standard')
      expect(result.diffs[0].actual).toBe('absent')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('flags write access granted to approved devices out of band', async () => {
    const live = { ...IN_SYNC, windows: { approved_devices: { allow_write: false, allow_execute: false } } }
    await withFetch([POLICIES, cbJson({ results: [live] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Standard.allow_write')!
      expect(diff.expected).toBe(true)
      expect(diff.actual).toBe(false)
      expect(diff.severity).toBe('warning')
    })
  })

  it('flags execution enabled on approved devices out of band', async () => {
    const live = { ...IN_SYNC, windows: { approved_devices: { allow_write: true, allow_execute: true } } }
    await withFetch([POLICIES, cbJson({ results: [live] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Standard.allow_execute')!
      expect(diff.expected).toBe(false)
      expect(diff.actual).toBe(true)
    })
  })

  it('flags both approved-device permissions when both moved', async () => {
    const live = { ...IN_SYNC, windows: { approved_devices: { allow_write: false, allow_execute: true } } }
    await withFetch([POLICIES, cbJson({ results: [live] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(2)
      expect(fields(result)).toContain('Standard.allow_write')
      expect(fields(result)).toContain('Standard.allow_execute')
    })
  })

  it('reads a block with no approved-devices section as both permissions off', async () => {
    await withFetch([POLICIES, cbJson({ results: [{ id: 'blk-1', policy_id: 101 }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Standard.allow_write')!
      expect(diff.expected).toBe(true)
      expect(diff.actual).toBe(false)
    })
  })

  it('matches the policy name case-insensitively', async () => {
    await withFetch([POLICIES, cbJson({ results: [IN_SYNC] })], async () => {
      const result = await driftDetect(ctx([block({ policyName: 'standard', allowWrite: true, allowExecute: false })]))

      expect(result.hasDrift).toBe(false)
    })
  })

  it('reports no drift when the policy lookup fails, and never reads the blocks', async () => {
    await withFetch([cbError('forbidden', 403)], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // A handler that cannot resolve policies must not claim every block is gone.
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(1)
    })
  })

  it('reports no drift when the block listing fails, rather than inventing absences', async () => {
    await withFetch([POLICIES, cbError('service unavailable', 503)], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(2)
    })
  })
})
