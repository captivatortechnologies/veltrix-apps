// Options provider for the Groups config type. The logic is shared across okta
// config types (the live Groups/Users pickers), so this is a thin re-export of
// the shared provider — keeping the per-config-type handler path the platform
// and validator expect (config-types/<type>/options). Powers the "users"
// optionsSource on a group's Members field.
export { default } from '../lib/oktaOptions'
