import getStatus from '../getStatus'
import { getStatusSuite } from '../../../lib/__tests__/sharedHandlerSuites'

// Platform-records-only status; the shared suite drives THIS module.
getStatusSuite('prevention-profiles', getStatus)
