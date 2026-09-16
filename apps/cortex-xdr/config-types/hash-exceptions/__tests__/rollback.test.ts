import rollback from '../rollback'
import { mentionsApiKey, rollbackContext, withFetch } from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'hash-exceptions'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function ctx(rollbackData: unknown, opts: Record<string, unknown> = {}) {
  return rollbackContext(rollbackData, { configTypeId: CONFIG_TYPE, ...opts })
}

/**
 * Rollback here is a DELIBERATE no-op against the vendor: Cortex XDR documents
 * only ADD endpoints for the allow / block lists, with nothing to read or remove.
 * The handler's job is therefore to make no call, report exactly what it could
 * not undo, and still return success so one vendor limitation does not wedge the
 * pipeline. These tests assert that as the intended behaviour.
 */
describe('cortex-xdr hash-exceptions rollback handler', () => {
  it('does nothing when the deploy added nothing', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx({ added: [] }))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/Nothing to roll back/)
      expect(calls).toHaveLength(0)
    })
  })

  it('does nothing when there is no rollback data at all', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx(undefined))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('makes no vendor call, because the API exposes no way to remove a hash', async () => {
    await withFetch([], async (calls) => {
      await rollback(ctx({ added: [{ hash: HASH_A, listType: 'allowlist' }] }))

      expect(calls).toHaveLength(0)
    })
  })

  it('names every hash it could not remove so the operator can do it by hand', async () => {
    await withFetch([], async () => {
      const result = await rollback(
        ctx({
          added: [
            { hash: HASH_A, listType: 'allowlist' },
            { hash: HASH_B, listType: 'blocklist' },
          ],
        }),
      )

      expect(result.message).toMatch(/Cannot auto-remove 2 hash exception/)
      expect(result.message).toContain(`allowlist:${HASH_A}`)
      expect(result.message).toContain(`blocklist:${HASH_B}`)
      expect(result.message).toMatch(/add-only/)
    })
  })

  it('still reports success, so a vendor limitation does not wedge the pipeline', async () => {
    await withFetch([], async () => {
      const result = await rollback(ctx({ added: [{ hash: HASH_A, listType: 'allowlist' }] }))

      expect(result.success).toBe(true)
    })
  })

  it('needs no credential, precisely because it never reaches the tenant', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        ctx({ added: [{ hash: HASH_A, listType: 'allowlist' }] }, { credential: null }),
      )

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/Cannot auto-remove/)
      expect(calls).toHaveLength(0)
    })
  })

  it('keeps the API key out of its message', async () => {
    await withFetch([], async () => {
      const result = await rollback(ctx({ added: [{ hash: HASH_A, listType: 'allowlist' }] }))

      expect(mentionsApiKey(result.message)).toBe(false)
    })
  })
})
