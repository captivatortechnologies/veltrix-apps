import type { DriftResult } from '@veltrixsecops/app-sdk'
import driftDetect from '../driftDetect'
import { driftContext, withFetch } from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'hash-exceptions'
const HASH_A = 'a'.repeat(64)

function ctx(items: Array<{ fields: Record<string, unknown> }> = [], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

/**
 * `checked` is not on the DriftResult the vendored SDK build declares (it was
 * added by a later SDK commit than the dist in node_modules), so read it through
 * a cast rather than weakening the assertion.
 */
function checkedOf(result: DriftResult): boolean | undefined {
  return (result as DriftResult & { checked?: boolean }).checked
}

/**
 * Drift here is a DELIBERATE no-op: Cortex XDR exposes no endpoint that lists or
 * reads hash exceptions, so this handler cannot compare declared state to live
 * state. It says so with `checked: false` — which means "could not determine",
 * NOT "in sync". Without it the platform reads `hasDrift: false` as a positive
 * assurance and clears real drift on every scheduled run.
 */
describe('cortex-xdr hash-exceptions driftDetect handler', () => {
  it('reports that it could not check, rather than claiming the tenant is in sync', async () => {
    await withFetch([], async () => {
      const result = await driftDetect(ctx([{ fields: { hash: HASH_A, list_type: 'allowlist' } }]))

      expect(checkedOf(result)).toBe(false)
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('makes no vendor call, because there is nothing readable to compare against', async () => {
    await withFetch([], async (calls) => {
      await driftDetect(ctx([{ fields: { hash: HASH_A, list_type: 'blocklist' } }]))

      expect(calls).toHaveLength(0)
    })
  })

  it('says the same thing for an empty canvas', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([]))

      expect(checkedOf(result)).toBe(false)
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('says the same thing with no credential, without throwing', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        ctx([{ fields: { hash: HASH_A, list_type: 'allowlist' } }], { credential: null }),
      )

      expect(checkedOf(result)).toBe(false)
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })
})
