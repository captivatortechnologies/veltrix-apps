import type { DeployResult } from '@veltrixsecops/app-sdk'
import deploy from '../deploy'
import { HASH_EXCEPTION_ENDPOINTS } from '../_shared'
import {
  API_KEY,
  API_KEY_ID,
  type ItemInput,
  callsTo,
  cortexError,
  cortexReply,
  deployContext,
  mentionsApiKey,
  requestData,
  withFailingFetch,
  withFetch,
} from '../../../lib/__tests__/fakeCortex'

const CONFIG_TYPE = 'hash-exceptions'
const ALLOW = HASH_EXCEPTION_ENDPOINTS.allowlist
const BLOCK = HASH_EXCEPTION_ENDPOINTS.blocklist

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function addedOf(result: DeployResult): Array<{ hash: string; listType: string }> {
  const data = result.rollbackData as { added?: Array<{ hash: string; listType: string }> } | undefined
  return data?.added ?? []
}

describe('cortex-xdr hash-exceptions deploy handler', () => {
  it('refuses without a credential instead of calling the tenant', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([{ fields: { hash: HASH_A, list_type: 'allowlist' } }], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the connection carries no tenant API FQDN', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([{ fields: { hash: HASH_A, list_type: 'allowlist' } }], { noHostname: true }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/FQDN/)
      expect(calls).toHaveLength(0)
    })
  })

  it('carries the API key headers on its very first call, which is already a write', async () => {
    // These endpoints are add-only: there is no list to read first, so the first
    // request this handler ever makes changes the tenant.
    await withFetch([cortexReply({})], async (calls) => {
      await deploy(ctx([{ fields: { hash: HASH_A, list_type: 'allowlist' } }]))

      expect(calls).toHaveLength(1)
      expect(calls[0].apiPath).toBe(ALLOW)
      expect(calls[0].method).toBe('POST')
      expect(calls[0].authId).toBe(API_KEY_ID)
      expect(calls[0].authorization).toBe(API_KEY)
    })
  })

  it('batches hashes that share a list and comment into one call', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await deploy(
        ctx([
          { fields: { hash: HASH_A, list_type: 'allowlist', comment: 'signed by vendor' } },
          { fields: { hash: HASH_B, list_type: 'allowlist', comment: 'signed by vendor' } },
        ]),
      )

      expect(calls).toHaveLength(1)
      expect(requestData(calls[0])).toEqual({
        hash_list: [HASH_A, HASH_B],
        comment: 'signed by vendor',
      })
      expect(result.success).toBe(true)
      expect(result.artifacts?.applied).toEqual([`allowlist:${HASH_A}`, `allowlist:${HASH_B}`])
    })
  })

  it('sends the allow list and the block list to their own endpoints', async () => {
    await withFetch([cortexReply({}), cortexReply({})], async (calls) => {
      await deploy(
        ctx([
          { fields: { hash: HASH_A, list_type: 'allowlist' } },
          { fields: { hash: HASH_B, list_type: 'blocklist' } },
        ]),
      )

      expect(requestData(callsTo(calls, ALLOW)[0])).toEqual({ hash_list: [HASH_A] })
      expect(requestData(callsTo(calls, BLOCK)[0])).toEqual({ hash_list: [HASH_B] })
    })
  })

  it('keeps distinct comments in separate calls, since the endpoint takes one per request', async () => {
    await withFetch([cortexReply({}), cortexReply({})], async (calls) => {
      await deploy(
        ctx([
          { fields: { hash: HASH_A, list_type: 'allowlist', comment: 'first reason' } },
          { fields: { hash: HASH_B, list_type: 'allowlist', comment: 'second reason' } },
        ]),
      )

      const allow = callsTo(calls, ALLOW)
      expect(allow).toHaveLength(2)
      expect(requestData(allow[0])).toEqual({ hash_list: [HASH_A], comment: 'first reason' })
      expect(requestData(allow[1])).toEqual({ hash_list: [HASH_B], comment: 'second reason' })
    })
  })

  it('omits the comment field entirely when none was authored', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      await deploy(ctx([{ fields: { hash: HASH_A, list_type: 'allowlist', comment: '  ' } }]))

      expect(requestData(calls[0])).toEqual({ hash_list: [HASH_A] })
    })
  })

  it('normalizes a hash to lowercase so the same digest is not added twice', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      await deploy(
        ctx([
          { fields: { hash: HASH_A.toUpperCase(), list_type: 'ALLOWLIST' } },
          { fields: { hash: HASH_A, list_type: 'allowlist' } },
        ]),
      )

      expect(calls).toHaveLength(1)
      expect(requestData(calls[0])).toEqual({ hash_list: [HASH_A] })
    })
  })

  it('skips a canvas item with no hash or no list type', async () => {
    await withFetch([cortexReply({})], async (calls) => {
      const result = await deploy(
        ctx([
          { fields: { hash: '', list_type: 'allowlist' } },
          { fields: { hash: HASH_C, list_type: '' } },
          { fields: { hash: HASH_A, list_type: 'allowlist' } },
        ]),
      )

      expect(calls).toHaveLength(1)
      expect(requestData(calls[0])).toEqual({ hash_list: [HASH_A] })
      expect(addedOf(result)).toEqual([{ hash: HASH_A, listType: 'allowlist' }])
    })
  })

  it('records everything it added, which is the only audit trail rollback has', async () => {
    await withFetch([cortexReply({}), cortexReply({})], async () => {
      const result = await deploy(
        ctx([
          { fields: { hash: HASH_A, list_type: 'allowlist' } },
          { fields: { hash: HASH_B, list_type: 'blocklist' } },
        ]),
      )

      expect(addedOf(result)).toEqual([
        { hash: HASH_A, listType: 'allowlist' },
        { hash: HASH_B, listType: 'blocklist' },
      ])
    })
  })

  it('makes no call at all when the canvas declares nothing to apply', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([]))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/No hash exceptions to apply/)
      expect(calls).toHaveLength(0)
      expect(addedOf(result)).toHaveLength(0)
    })
  })

  it('reports the vendor reason and what had already landed when a batch is rejected', async () => {
    await withFetch([cortexReply({}), cortexError('hash already on the block list', 400)], async () => {
      const result = await deploy(
        ctx([
          { fields: { hash: HASH_A, list_type: 'allowlist' } },
          { fields: { hash: HASH_B, list_type: 'blocklist' } },
        ]),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/blocklist/)
      expect(result.message).toMatch(/hash already on the block list/)
      expect(result.artifacts?.applied).toEqual([`allowlist:${HASH_A}`])
      // Both hashes stay in `added` — one landed, and the operator is told so.
      expect(addedOf(result)).toHaveLength(2)
    })
  })

  it('returns a failed result rather than throwing when the tenant is unreachable', async () => {
    await withFailingFetch('ETIMEDOUT', async () => {
      const result = await deploy(ctx([{ fields: { hash: HASH_A, list_type: 'allowlist' } }]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/ETIMEDOUT/)
    })
  })

  it('keeps the API key out of the message, artifacts and rollback state', async () => {
    await withFetch([cortexError('invalid API key', 401)], async () => {
      const result = await deploy(ctx([{ fields: { hash: HASH_A, list_type: 'allowlist' } }]))

      expect(result.success).toBe(false)
      expect(mentionsApiKey(result.message)).toBe(false)
      expect(mentionsApiKey(result.artifacts)).toBe(false)
      expect(mentionsApiKey(result.rollbackData)).toBe(false)
    })
  })
})
