import { readLicenseInput } from '../licenseInput'

describe('readLicenseInput', () => {
  it('requires xml', () => {
    expect(readLicenseInput({}).error).toBe('License XML is required')
    expect(readLicenseInput({ xml: '   ' }).error).toBe('License XML is required')
    expect(readLicenseInput(null).error).toBe('License XML is required')
  })

  it('rejects a non-string xml', () => {
    expect(readLicenseInput({ xml: 123 }).error).toBe('License XML is required')
  })

  it('trims and returns valid xml', () => {
    const { xml, error } = readLicenseInput({ xml: '  <license/>  ' })
    expect(error).toBeUndefined()
    expect(xml).toBe('<license/>')
  })

  it('rejects an oversized payload', () => {
    const huge = '<license>' + 'x'.repeat(600 * 1024) + '</license>'
    expect(readLicenseInput({ xml: huge }).error).toBe('License XML is too large')
  })
})
