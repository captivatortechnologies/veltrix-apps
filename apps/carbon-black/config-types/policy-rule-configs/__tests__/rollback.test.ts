import rollback from '../rollback'
import type { RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  arrayBody,
  callsTo,
  cbError,
  cbJson,
  cbNotFound,
  mentionsSecret,
  rollbackContext,
  withFetch,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'policy-rule-configs'
const POLICIES = `/policyservice/v1/orgs/${ORG_KEY}/policies`
const CORE = `${POLICIES}/7/rule_configs/core_prevention`

const PRIOR_CONFIGS = [
  { id: 'rc-a', WindowsAssignmentMode: 'BLOCK', exclusions: { windows: [{ criteria: ['tools'] }] } },
  { id: 'rc-b', WindowsAssignmentMode: 'REPORT' },
]

function ctx(entries: RollbackEntry[] | undefined, opts: Record<string, unknown> = {}) {
  return rollbackContext(entries === undefined ? undefined : { entries }, { configTypeId: CONFIG_TYPE, ...opts })
}

function entry(overrides: Partial<RollbackEntry> = {}): RollbackEntry {
  return { itemId: 'item-1', policyName: 'Standard', policyId: '7', existed: true, ...overrides }
}

describe('carbon-black policy-rule-configs rollback handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([entry({ prior: { configs: PRIOR_CONFIGS } })], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        ctx([entry({ prior: { configs: PRIOR_CONFIGS } })], { settings: NO_ORG_KEY_SETTINGS }),
      )

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('PUTs the exact prior configs back onto the core-prevention category', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([entry({ prior: { configs: PRIOR_CONFIGS } })]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('PUT')
      expect(calls[0].path).toBe(CORE)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
      // The pre-deploy snapshot goes back verbatim — that is the whole point.
      expect(arrayBody(calls[0])).toEqual([
        { id: 'rc-a', parameters: { WindowsAssignmentMode: 'BLOCK' }, exclusions: { windows: [{ criteria: ['tools'] }] } },
        { id: 'rc-b', parameters: { WindowsAssignmentMode: 'REPORT' } },
      ])
      expect(result.message).toContain('1 restored')
    })
  })

  it('resets the category to the vendor default when no prior configs were captured', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([entry({ prior: { configs: [] } })]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(CORE)
      expect(result.message).toContain('1 reset to default')
    })
  })

  it('never issues a DELETE against the bare policy path', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([entry()]))

      // Deleting the policy itself would orphan every device assigned to it.
      expect(result.success).toBe(true)
      for (const call of calls) {
        if (call.method === 'DELETE') expect(call.path).toBe(CORE)
      }
      expect(callsTo(calls, `${POLICIES}/7`)).toHaveLength(0)
    })
  })

  it('falls back to BLOCK for a config whose prior mode was never recorded', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([entry({ prior: { configs: [{ id: 'rc-a' }] } })]))

      expect(result.success).toBe(true)
      expect(arrayBody(calls[0])).toEqual([{ id: 'rc-a', parameters: { WindowsAssignmentMode: 'BLOCK' } }])
    })
  })

  it('does nothing when there is no rollback state at all', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx(undefined))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('does nothing for an empty entry list', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('skips an entry whose policy id was never recorded', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([entry({ policyId: undefined, prior: { configs: PRIOR_CONFIGS } })]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('treats an already-reset category as rolled back, not as a failure', async () => {
    await withFetch([cbNotFound()], async () => {
      const result = await rollback(ctx([entry({ prior: { configs: [] } })]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 reset to default')
    })
  })

  it('treats a restore onto a policy that is gone as rolled back', async () => {
    await withFetch([cbNotFound()], async () => {
      const result = await rollback(ctx([entry({ prior: { configs: PRIOR_CONFIGS } })]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 restored')
    })
  })

  it('reports failure rather than throwing when the vendor rejects a restore', async () => {
    await withFetch([cbError('rule config is locked by a managed policy', 409)], async () => {
      const result = await rollback(ctx([entry({ prior: { configs: PRIOR_CONFIGS } })]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('rule config is locked by a managed policy')
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('keeps going after one entry fails so the rest still roll back', async () => {
    await withFetch([cbError('boom', 500), cbJson({})], async (calls) => {
      const result = await rollback(
        ctx([
          entry({ policyName: 'First', policyId: '7', prior: { configs: PRIOR_CONFIGS } }),
          entry({ policyName: 'Second', policyId: '8', prior: { configs: PRIOR_CONFIGS } }),
        ]),
      )

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(2)
      expect(calls[1].path).toBe(`${POLICIES}/8/rule_configs/core_prevention`)
    })
  })

  it('keeps the API secret in the auth header — never in a URL, a body or a message', async () => {
    await withFetch([cbError('unauthorized', 401)], async (calls) => {
      const result = await rollback(ctx([entry({ prior: { configs: PRIOR_CONFIGS } })]))

      expect(result.success).toBe(false)
      expect(mentionsSecret(result.message)).toBe(false)
      for (const call of calls) {
        expect(mentionsSecret(call.url)).toBe(false)
        expect(mentionsSecret(call.body)).toBe(false)
      }
    })
  })
})
