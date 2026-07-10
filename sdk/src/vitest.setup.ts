import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Global setupFiles run OUTSIDE `globals: true`, so @testing-library/react's own
// auto-cleanup (which detects a global `afterEach`) never registers. Do it explicitly
// so each test starts from an empty document instead of accumulating DOM across tests.
afterEach(() => {
  cleanup()
})
