// Options provider for the Conditional Access Policies config type. The live
// picker logic is shared across every Entra config type (config-types/lib/entraOptions),
// so this is a thin re-export — keeping the per-config-type handler path the
// platform and validator expect (config-types/<type>/options). Powers the
// "groups" optionsSource on Included/Excluded Groups and the "applications"
// optionsSource on Included Apps.
export { default } from '../lib/entraOptions'
