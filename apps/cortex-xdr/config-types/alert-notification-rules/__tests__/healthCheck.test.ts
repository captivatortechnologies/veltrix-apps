import healthCheck from '../healthCheck'
import { healthCheckSuite } from '../../../lib/__tests__/sharedHandlerSuites'

// Every config type in this app compiles the same reachability probe; the
// assertions live once in sharedHandlerSuites and run against THIS module.
healthCheckSuite('alert-notification-rules', healthCheck)
