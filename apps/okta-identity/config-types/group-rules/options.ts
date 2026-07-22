// Options provider for the Group Rules config type. The logic is shared across
// okta config types (the live Groups picker), so this is a thin re-export of the
// shared provider — keeping the per-config-type handler path the platform and
// validator expect (config-types/<type>/options). Powers the "groups"
// optionsSource on the rule's Target Groups field.
export { default } from '../lib/oktaOptions'
