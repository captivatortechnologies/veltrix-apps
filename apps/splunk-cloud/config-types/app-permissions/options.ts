// Options provider for the App Permissions config type. The live-picker logic
// is shared across splunk-cloud config types, so this is a thin re-export of the
// shared provider — keeping the per-config-type handler path the platform and
// validator expect (config-types/<type>/options). Powers the "apps"
// optionsSource on the App Name field.
export { default } from '../lib/splunkOptions'
