import {
  OnePasswordClient,
  buildOnePasswordClient,
  buildPatchOp,
  parseJson,
  resolveOnePasswordToken,
  scimErrorMessage,
} from '../onePassword'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

const cred = (over: Partial<CredentialRef>): CredentialRef => ({
  id: 'c1',
  name: 'cred',
  username: '',
  password: '',
  apiToken: null,
  certificate: null,
  ...over,
})

describe('resolveOnePasswordToken', () => {
  it('prefers apiToken over password', () => {
    expect(resolveOnePasswordToken(cred({ apiToken: 'tok-1', password: 'tok-2' }))).toBe('tok-1')
  })
  it('falls back to password when apiToken is absent', () => {
    expect(resolveOnePasswordToken(cred({ apiToken: null, password: 'tok-2' }))).toBe('tok-2')
  })
  it('returns null when neither is set', () => {
    expect(resolveOnePasswordToken(cred({ apiToken: null, password: '' }))).toBeNull()
  })
  it('returns null for a null credential', () => {
    expect(resolveOnePasswordToken(null)).toBeNull()
  })
})

describe('buildOnePasswordClient', () => {
  it('errors when no token is available', () => {
    const result = buildOnePasswordClient('scim.example.com', cred({}), {})
    expect('error' in result).toBe(true)
  })
  it('errors when no hostname/endpoint is available', () => {
    const result = buildOnePasswordClient(undefined, cred({ apiToken: 'tok' }), {})
    expect('error' in result).toBe(true)
  })
  it('adds an https scheme to a bare hostname', () => {
    const result = buildOnePasswordClient('scim.example.com', cred({ apiToken: 'tok' }), {})
    expect('error' in result).toBe(false)
    if (!('error' in result)) expect(result.baseUrl).toBe('https://scim.example.com')
  })
  it('preserves an explicit scheme and strips a trailing slash', () => {
    const result = buildOnePasswordClient('https://scim.example.com/', cred({ apiToken: 'tok' }), {})
    if (!('error' in result)) expect(result.baseUrl).toBe('https://scim.example.com')
  })
})

describe('parseJson', () => {
  it('parses valid JSON', () => {
    expect(parseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })
  it('returns null for invalid JSON', () => {
    expect(parseJson('not json')).toBeNull()
  })
  it('returns null for an empty body', () => {
    expect(parseJson('')).toBeNull()
  })
})

describe('scimErrorMessage', () => {
  it('prefers the SCIM error envelope detail field (RFC 7644 3.12)', () => {
    const message = scimErrorMessage({ status: 404, ok: false, body: JSON.stringify({ detail: 'User not found' }) })
    expect(message).toBe('User not found')
  })
  it('falls back to a plain message field', () => {
    const message = scimErrorMessage({ status: 502, ok: false, body: JSON.stringify({ message: 'Bad gateway' }) })
    expect(message).toBe('Bad gateway')
  })
  it('falls back to the raw body when nothing parses', () => {
    const message = scimErrorMessage({ status: 500, ok: false, body: 'boom' })
    expect(message).toBe('boom')
  })
})

describe('buildPatchOp', () => {
  it('wraps operations in the PatchOp message schema', () => {
    const body = buildPatchOp([{ op: 'replace', path: 'active', value: false }])
    expect(body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:PatchOp'])
    expect(body.Operations).toEqual([{ op: 'replace', path: 'active', value: false }])
  })
})

describe('OnePasswordClient', () => {
  async function withMockFetch(handler: (url: string) => { status: number; body: string }, run: () => Promise<void>): Promise<void> {
    const original = global.fetch
    global.fetch = (async (input: RequestInfo | URL) => {
      const next = handler(String(input))
      return { status: next.status, text: async () => next.body } as Response
    }) as typeof fetch
    try {
      await run()
    } finally {
      global.fetch = original
    }
  }

  it('sends the bearer token and application/scim+json headers', async () => {
    let capturedInit: RequestInit | undefined
    const original = global.fetch
    global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init
      return { status: 200, text: async () => '{}' } as Response
    }) as typeof fetch
    try {
      const client = new OnePasswordClient({ baseUrl: 'https://scim.example.com', token: 'tok-123', timeoutMs: 5000 })
      await client.request('GET', '/health')
      const headers = capturedInit?.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer tok-123')
      expect(headers['Content-Type']).toBe('application/scim+json')
      expect(headers.Accept).toBe('application/scim+json')
    } finally {
      global.fetch = original
    }
  })

  it('walks a ListResponse across multiple pages via listAll', async () => {
    await withMockFetch(
      (url) => {
        const startIndex = new URL(url).searchParams.get('startIndex')
        if (startIndex === '1') {
          return { status: 200, body: JSON.stringify({ totalResults: 3, Resources: [{ id: '1' }, { id: '2' }] }) }
        }
        return { status: 200, body: JSON.stringify({ totalResults: 3, Resources: [{ id: '3' }] }) }
      },
      async () => {
        const client = new OnePasswordClient({ baseUrl: 'https://scim.example.com', token: 'tok', timeoutMs: 5000 })
        const result = await client.listAll<{ id: string }>('/Users')
        expect(result.ok).toBe(true)
        expect(result.items.map((i) => i.id)).toEqual(['1', '2', '3'])
      },
    )
  })

  it('stops and reports failure on a non-2xx page', async () => {
    await withMockFetch(
      () => ({ status: 401, body: JSON.stringify({ detail: 'unauthorized' }) }),
      async () => {
        const client = new OnePasswordClient({ baseUrl: 'https://scim.example.com', token: 'tok', timeoutMs: 5000 })
        const result = await client.listAll('/Users')
        expect(result.ok).toBe(false)
        expect(result.status).toBe(401)
      },
    )
  })
})
