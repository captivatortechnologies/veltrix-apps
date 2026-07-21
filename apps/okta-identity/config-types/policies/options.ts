// Options provider for the Policies config type. The logic is shared across
// okta config types (groups picker etc.), so this is a thin re-export of the
// shared provider — keeping the per-config-type handler path the platform and
// validator expect (config-types/<type>/options).
export { default } from '../lib/oktaOptions'
