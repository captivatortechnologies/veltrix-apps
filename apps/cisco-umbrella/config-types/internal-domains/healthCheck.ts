import { DEPLOYMENTS_INTERNAL_DOMAINS_PATH, deploymentHealthCheck } from '../../lib/deployments'

/** Health = Umbrella authenticates and answers the internal domains collection. */
export default deploymentHealthCheck(DEPLOYMENTS_INTERNAL_DOMAINS_PATH, 'umbrella-internal-domains')
