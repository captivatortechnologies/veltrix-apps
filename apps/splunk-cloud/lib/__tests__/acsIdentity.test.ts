import {
  createAcsIdentityEntity,
  deleteAcsIdentityEntity,
  describeTarget,
  FEDERATED_SEARCH_MANAGE_ACK_HEADER,
  getAcsIdentityEntity,
  isValidSearchHeadTarget,
  resolveTargets,
  targetedStackPath,
  updateAcsIdentityEntity,
  withTarget,
} from '../acsIdentity'
import type { AcsRequestOptions } from '../acs'

/**
 * The app test harness maps a Jest-shaped `expect` onto node:assert (see
 * scripts/test-globals.mjs) — it has no `.rejects`/`.resolves`. Await the
 * promise directly and assert on the caught error instead.
 */
async function expectRejects(promise: Promise<unknown>, matcher: RegExp): Promise<void> {
  let threw = false
  try {
    await promise
  } catch (error) {
    threw = true
    expect(error instanceof Error ? error.message : String(error)).toMatch(matcher)
  }
  expect(threw).toBe(true)
}

const acs: AcsRequestOptions = {
  baseUrl: 'https://admin.splunk.com',
  stack: 'acme',
  token: 'STACK_JWT',
  timeoutMs: 5_000,
}

describe('isValidSearchHeadTarget', () => {
  it('accepts Splunk-style instance ids', () => {
    expect(isValidSearchHeadTarget('sh-i-0910d0dfdb9ed913a')).toBe(true)
    expect(isValidSearchHeadTarget('sh1')).toBe(true)
  })

  it('rejects uppercase, spaces, dots and empty strings', () => {
    expect(isValidSearchHeadTarget('SH-I-AAA')).toBe(false)
    expect(isValidSearchHeadTarget('sh i aaa')).toBe(false)
    expect(isValidSearchHeadTarget('sh.i.aaa')).toBe(false)
    expect(isValidSearchHeadTarget('')).toBe(false)
  })

  it('rejects a target longer than the max length', () => {
    expect(isValidSearchHeadTarget('a'.repeat(101))).toBe(false)
  })
})

describe('resolveTargets', () => {
  it('resolves to a single untargeted entry when no targets are declared', () => {
    expect(resolveTargets(undefined)).toEqual([undefined])
    expect(resolveTargets([])).toEqual([undefined])
  })

  it('passes explicit targets through unchanged', () => {
    expect(resolveTargets(['sh-i-aaa', 'sh-i-bbb'])).toEqual(['sh-i-aaa', 'sh-i-bbb'])
  })
})

describe('targetedStackPath / withTarget', () => {
  it('returns the bare stack when untargeted', () => {
    expect(targetedStackPath('acme', undefined)).toBe('acme')
    expect(withTarget(acs, 'acme', undefined)).toEqual(acs)
  })

  it('prefixes the stack with "<target>." when targeted — matching Splunk\'s own ACS URL convention', () => {
    expect(targetedStackPath('acme', 'sh-i-0910d0dfdb9ed913a')).toBe('sh-i-0910d0dfdb9ed913a.acme')
    expect(withTarget(acs, 'acme', 'sh-i-aaa').stack).toBe('sh-i-aaa.acme')
  })
})

describe('describeTarget', () => {
  it('describes the untargeted case and a specific target', () => {
    expect(describeTarget(undefined)).toBe('the default search head')
    expect(describeTarget('sh-i-aaa')).toContain('sh-i-aaa')
  })
})

describe('FEDERATED_SEARCH_MANAGE_ACK_HEADER', () => {
  it('is the exact header ACS documents', () => {
    expect(FEDERATED_SEARCH_MANAGE_ACK_HEADER).toEqual({ 'Federated-Search-Manage-Ack': 'Y' })
  })
})

function captureFetch(status: number, body: unknown): { restore: () => void; calls: { headers: Record<string, string> }[] } {
  const original = globalThis.fetch
  const calls: { headers: Record<string, string> }[] = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push({ headers: (init?.headers as Record<string, string>) ?? {} })
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) }
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

describe('getAcsIdentityEntity', () => {
  it('returns null on 404', async () => {
    const { restore } = captureFetch(404, { code: '404-role-not-found', message: 'not found' })
    try {
      expect(await getAcsIdentityEntity(acs, '/roles/ghost')).toBeNull()
    } finally {
      restore()
    }
  })

  it('parses the JSON body on 200', async () => {
    const { restore } = captureFetch(200, { name: 'soc-analyst' })
    try {
      expect(await getAcsIdentityEntity(acs, '/roles/soc-analyst')).toEqual({ name: 'soc-analyst' })
    } finally {
      restore()
    }
  })

  it('throws (surfacing the ACS error) on any other non-200 status', async () => {
    const { restore } = captureFetch(500, { code: '500-internal', message: 'boom' })
    try {
      await expectRejects(getAcsIdentityEntity(acs, '/roles/soc-analyst'), /boom/)
    } finally {
      restore()
    }
  })
})

describe('createAcsIdentityEntity / updateAcsIdentityEntity — headers', () => {
  it('sends extra headers (e.g. Federated-Search-Manage-Ack) on create', async () => {
    const { calls, restore } = captureFetch(200, { name: 'soc-analyst' })
    try {
      await createAcsIdentityEntity(acs, '/roles', { name: 'soc-analyst' }, FEDERATED_SEARCH_MANAGE_ACK_HEADER)
      expect(calls[0].headers['Federated-Search-Manage-Ack']).toBe('Y')
    } finally {
      restore()
    }
  })

  it('sends extra headers on update', async () => {
    const { calls, restore } = captureFetch(200, { name: 'soc-analyst' })
    try {
      await updateAcsIdentityEntity(acs, '/roles/soc-analyst', { capabilities: ['search'] }, FEDERATED_SEARCH_MANAGE_ACK_HEADER)
      expect(calls[0].headers['Federated-Search-Manage-Ack']).toBe('Y')
    } finally {
      restore()
    }
  })

  it('throws on a failed create', async () => {
    const { restore } = captureFetch(409, { code: '409-conflict', message: 'already exists' })
    try {
      await expectRejects(createAcsIdentityEntity(acs, '/roles', { name: 'dup' }), /already exists/)
    } finally {
      restore()
    }
  })
})

describe('deleteAcsIdentityEntity', () => {
  it('resolves (returns undefined) on success', async () => {
    const { restore } = captureFetch(200, {})
    try {
      const result = await deleteAcsIdentityEntity(acs, '/roles/soc-analyst')
      expect(result).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('throws on failure', async () => {
    const { restore } = captureFetch(403, { code: '403-forbidden', message: 'no capability' })
    try {
      await expectRejects(deleteAcsIdentityEntity(acs, '/roles/soc-analyst'), /no capability/)
    } finally {
      restore()
    }
  })
})
