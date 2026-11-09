import { readAccountConnection } from '../accountConnection'

const cred = (username: string, apiToken: string) => ({ id: 'c', name: 'n', username, password: '', apiToken, certificate: null }) as any

describe('readAccountConnection', () => {
  it('accepts a matching account id, role ARN and external id', () => {
    const r = readAccountConnection('123456789012', cred('arn:aws:iam::123456789012:role/VeltrixGovernance', 'ext-id-12345'))
    expect(r.errors).toEqual([])
    expect(r.value).toEqual({ accountId: '123456789012', roleArn: 'arn:aws:iam::123456789012:role/VeltrixGovernance', externalId: 'ext-id-12345' })
  })

  it('rejects a role from a different account', () => {
    const r = readAccountConnection('123456789012', cred('arn:aws:iam::999999999999:role/x', 'ext-id-12345'))
    expect(r.value).toBeNull()
    expect(r.errors.join(' ')).toMatch(/belongs to account 999999999999/)
  })

  it('requires an external id of at least 8 characters', () => {
    const r = readAccountConnection('123456789012', cred('arn:aws:iam::123456789012:role/x', 'short'))
    expect(r.value).toBeNull()
    expect(r.errors.join(' ')).toMatch(/External ID is required/)
  })

  it('rejects a non-numeric account id and a malformed ARN', () => {
    const r = readAccountConnection('acme', cred('role/x', 'ext-id-12345'))
    expect(r.errors).toHaveLength(2)
  })

  it('falls back to the password field for the external id', () => {
    const r = readAccountConnection('123456789012', { username: 'arn:aws:iam::123456789012:role/x', password: 'ext-id-12345' } as any)
    expect(r.value?.externalId).toBe('ext-id-12345')
  })
})
