import React from 'react'
import { Button, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'
import { CONFIGURATION_AREAS } from '../lib/capabilities'

const REST_DOCS_URL = 'https://help.splunk.com/en/splunk-enterprise/rest-api-reference/10.4/introduction/using-the-rest-api-reference'
const CAPABILITIES_URL = 'https://help.splunk.com/en/splunk-enterprise/administer/manage-users-and-security/10.4/manage-splunk-platform-users-and-roles/define-roles-on-the-splunk-platform-with-capabilities'

export default function SetupGuidePage() {
  const card = (children: React.ReactNode) => <Card variant="bordered" padding="md"><CardBody>{children}</CardBody></Card>
  const tabs = [
    { key: 'scope', label: '1. Scope & targets', content: card(<>
      <p>Start with a sandbox Splunk instance and a backup. Choose the server role that owns the change; a local install does not automatically distribute an app to cluster peers.</p>
      <table><thead><tr><th>Configuration type</th><th>Target server roles</th><th>What it manages</th></tr></thead><tbody>{CONFIGURATION_AREAS.map(area => <tr key={area.id}><td>{area.name}</td><td>{area.componentTypes.join(', ')}</td><td>{area.description}</td></tr>)}</tbody></table>
      <p>Indexes, roles, saved searches and other portable settings belong in a Splunk App as .conf files. They are not separate canvas configuration types. Use the License page to record license XML and inspect live status; recording a license does not install it on Splunk.</p>
      <p>Infrastructure provisions BYOL deployments through configured platform workers. Upgrades tracks plans and versions; a recorded plan alone does not run a Splunk upgrade. Confirm installer, topology, backup and worker prerequisites separately.</p>
    </>) },
    { key: 'credential', label: '2. Credentials & permissions', content: card(<>
      <p>Create a dedicated Splunk service account. In Connections, attach either a Splunk authentication token in the API token field (sent as Bearer), or the account username and password (Basic authentication).</p>
      <p><strong>A HEC ingestion token cannot authenticate to the management API.</strong> Create an authentication token in Splunk Settings &gt; Tokens after enabling Token Authentication. Check its expiry and audience, and set a rotation owner. SSO browser cookies are not connection credentials.</p>
      <p>Test reads server information, typically requiring <code>list_settings</code>. Add only capabilities for the features you will manage; endpoint ACLs and Splunk version also apply.</p>
      <table><thead><tr><th>Feature</th><th>Splunk capabilities to review</th></tr></thead><tbody>{CONFIGURATION_AREAS.map(area => <tr key={area.id}><td>{area.name}</td><td>{area.capabilities}</td></tr>)}</tbody></table>
      <p>Veltrix permissions are separate: grant read/write/delete on the relevant app resource. Optional drift attribution needs search permission and access to the _audit index; a missing actor does not mean the drift check failed.</p>
      <a href={CAPABILITIES_URL} target="_blank" rel="noopener noreferrer">Splunk capability reference</a>
    </>) },
    { key: 'connection', label: '3. Connect & test', content: card(<>
      <ol><li>Open Connections and save the management endpoint, credential and environment. Use <code>https://splunk.internal:8089</code>, not Splunk Web on 8000 or HEC ingestion on 8088.</li>
      <li>Register or select the matching inventory component, attach the saved credential and set its actual server role, hostname and management port. A bare host defaults to 8089; a full HTTP(S) URL uses its declared port and path.</li>
      <li>For private instances, configure Access Servers and managed ZTNA, or another approved route. A directly reachable management host also works without a connectivity record. The runtime must have a real network path; a saved connection alone does not create a tunnel.</li>
      <li>Run Test and confirm the returned Splunk version. A successful test proves management read access, not write access, HEC event delivery, licensing or cluster bundle readiness.</li></ol>
      <p>Managed connectivity takes precedence over the component hostname. Connections currently accept self-signed server certificates; certificate-based server identity validation is not enforced. Use a trusted private route for management traffic.</p>
    </>) },
    { key: 'deploy', label: '4. Pilot deployment', content: card(<>
      <ol><li>Create a Splunk Apps canvas configuration in the sandbox. Choose Author files inline and a unique App ID; if omitted, the configuration name is used as the app ID.</li>
      <li>Add a small <code>default/</code> .conf file. Keep credentials out of app contents. App packages replace managed default files; local overrides can still change effective behavior.</li>
      <li>Select Target Server Types per item and the exact deployment component. Validate, review the package, deploy and inspect the health and drift results.</li>
      <li>Test rollback on a newly created disposable app, then inspect Splunk directly. Before updating an existing package or staged bundle, save its original bytes: metadata snapshots are not package backups.</li></ol>
      <p>HEC deployment can enable the global collector; API token deployment can enable Token Authentication. These instance-wide changes are not automatically disabled by rollback. Confirm approval for them before deployment.</p>
      <Button variant="secondary" size="sm" onClick={() => window.open(REST_DOCS_URL, '_blank', 'noopener')}>Splunk REST API reference</Button>
    </>) },
    { key: 'cluster', label: '5. Clusters & recovery', content: card(<>
      <p>For clustered content, target the distribution role and choose its staging directory. Managed ZTNA remote execution is required for placement and bundle commands:</p>
      <ul><li>Cluster manager: <code>etc/manager-apps</code>, then apply the indexer-cluster bundle.</li><li>Deployment server: <code>etc/deployment-apps</code>, then reload the deployment server. Client assignment still depends on server classes.</li><li>Search-head deployer: <code>etc/shcluster/apps</code>, then apply the search-head-cluster bundle to a registered member.</li></ul>
      <p>Selected staging placements require managed remote access and fail before installation if it is unavailable. Select only <code>etc/apps</code> for a local REST install, then confirm peer/member rollout separately in Splunk. Do not overwrite cluster-managed peer apps directly.</p>
      <p>Rollback restores captured settings and deletes newly created objects. Package upgrades need the original package backup; existing staging content is preserved when its previous bytes were not captured. An incomplete cleanup or failed bundle command is reported as failure, requiring operator recovery.</p>
      <p>Replacing an API token cannot restore the revoked token secret. Keep a separate recovery account and distribute replacement secrets before retiring old credentials.</p>
    </>) },
    { key: 'troubleshoot', label: '6. Troubleshooting', content: card(<>
      <dl><dt>401 authentication failed</dt><dd>Check token type, expiry, Token Authentication setting or password. A HEC ingestion token is the wrong credential.</dd>
      <dt>403 access denied</dt><dd>Check the service account capabilities and endpoint ACLs in Splunk, plus Veltrix app permissions for the action.</dd>
      <dt>Redirect, HTML or no server version</dt><dd>Use the direct management endpoint. A Web/SSO page returning 200 does not prove a Splunk API connection.</dd>
      <dt>DNS, connection refused or timeout</dt><dd>Check host, management port, runtime routing, access-server enrollment and firewall rules. Test and deployment use the same management transport.</dd>
      <dt>HEC token health fails</dt><dd>Check global HEC enablement, the desired token state and index routing. Send a separate test event to verify actual ingestion.</dd>
      <dt>Drift reports HTTP failure</dt><dd>Restore read access before concluding that the configuration is in sync. A denied read is not a clean result.</dd>
      <dt>Bundle or rollback incomplete</dt><dd>Inspect partial artifacts and affected targets. Restore saved package/staging backups and re-apply the bundle; avoid blindly rerunning uncertain writes.</dd></dl>
    </>) },
  ]
  return <div><h2>Splunk Enterprise - Setup Guide</h2><Tabs tabs={tabs} /></div>
}
