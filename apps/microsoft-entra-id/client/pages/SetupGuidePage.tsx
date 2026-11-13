import React from 'react'
import { Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

import { ENTRA_OPERATIONS } from '../../lib/operationDefinitions'
import { ENTRA_REPORTS } from '../../lib/reportDefinitions'
import { CAPABILITIES } from '../../lib/capabilities'

export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'prerequisites', label: '1. Prerequisites', content: <>
        <p>Start with a test tenant and choose the configuration types you intend to manage.
          You need access to app registrations, an administrator authorized to grant Graph application permissions,
          and access to Veltrix app settings and credentials.</p>
        <p>Use a client secret or a vault certificate credential containing the PEM certificate and matching private key.
          Brokered connections can use the platform identity broker when supplied by the host. Select global, us-gov, us-gov-dod, or china in Microsoft cloud settings.</p>
        <p>Conditional Access requires Entra ID P1; risk-based policies require P2. Confirm separate licensing
          for governance features. <a href="https://learn.microsoft.com/en-us/entra/identity/conditional-access/overview#license-requirements"
          target="_blank" rel="noopener noreferrer">Microsoft licensing requirements</a>.</p>
        <p>Allow outbound HTTPS from the Veltrix handler runtime to the selected cloud authority and Graph host. For the global cloud, these are <code>login.microsoftonline.com</code> and{' '}
          <code>graph.microsoft.com</code>. No server tunnel is required.</p>
      </>,
    },
    {
      key: 'registration', label: '2. Register and consent', content: <>
        <ol>
          <li>Open the <a href="https://entra.microsoft.com" target="_blank" rel="noopener noreferrer">Entra admin center</a>.
            Find <strong>App registrations</strong>, choose <strong>New registration</strong>, and select accounts in this
            organizational directory only. A redirect URI is not required for client credentials.</li>
          <li>Copy the <strong>Application (client) ID</strong> and <strong>Directory (tenant) ID</strong> from Overview.</li>
          <li>Under <strong>API permissions</strong>, choose <strong>Add a permission &gt; Microsoft Graph &gt; Application permissions</strong>.
            Add the permissions for your selected features, then have an authorized administrator grant tenant consent.</li>
          <li>Verify consent shows as granted. Delegated permissions do not authorize this app-only connection.</li>
        </ol>
        <p>Choose only the profiles you need. Add read permissions for referenced objects and live pickers.
          The registry covers every configuration type. Operations and Reports display the additional Graph permission for each action; grant its Veltrix resource permission separately. Check endpoint permissions for the specific operations and references you use.</p>
        <div style={{ overflowX: 'auto' }}><table>
          <caption>Application permission profiles by feature</caption>
          <thead><tr><th scope="col">Feature</th><th scope="col">Permissions</th></tr></thead>
          <tbody>{CAPABILITIES.map(cap => <tr key={cap.id}>
            <th scope="row">{cap.name}</th>
            <td>{cap.appOnly ? <>
              Read: {cap.readPermissions.join(', ')}<br />
              Write: {cap.writePermissions.join(', ')}<br />
              {Object.entries(cap.optionalWritePermissions ?? {}).map(([operation, permissions]) => (
                <React.Fragment key={operation}>{operation}: {permissions.join(', ')}<br /></React.Fragment>
              ))}
              References: {cap.pickerPermissions.join(', ') || 'None'}<br />
              {cap.licensing}<br />{cap.rollbackLimits.join(' ')}
            </> : cap.unsupportedReason}</td>
          </tr>)}</tbody>
        </table></div>
        <p><a href="https://learn.microsoft.com/en-us/graph/permissions-reference" target="_blank" rel="noopener noreferrer">
          Microsoft Graph permission reference</a>. Do not grant every profile just to pass Test.</p>
        <p><strong>Terms of Use limitation:</strong> Graph agreement listing does not support application permissions.
          Agreement management cannot complete its initial listing with this authentication flow.
          Manage agreements in Entra and paste an existing agreement ID into Conditional Access grant controls;
          its Terms of Use picker may be unavailable. More application permissions do not resolve this limitation.{' '}
          <a href="https://learn.microsoft.com/en-us/graph/api/termsofusecontainer-list-agreements?view=graph-rest-1.0"
            target="_blank" rel="noopener noreferrer">Microsoft agreement API requirements</a>.</p>
      </>,
    },
    {
      key: 'credential', label: '3. Secret and settings', content: <>
        <ol>
          <li>In <strong>Certificates &amp; secrets</strong>, create a client secret and copy its <strong>Value</strong>
            immediately. The Secret ID is not the credential.</li>
          <li>Set the Veltrix app&apos;s <strong>Tenant ID</strong> setting (<code>tenant_id</code>) to the Directory ID.
            This is the fallback tenant. To isolate connections, set Per-connection tenant overrides to a JSON object keyed by credential ID with tenantId and optional cloud. The endpoint does not override it.</li>
          <li>Store the Application ID as the credential <strong>Username</strong> and the secret value as its
            <strong> Password / Client secret</strong>.</li>
          <li>Leave <strong>Request Timeout</strong> at 30 seconds initially. This is a per-request timeout,
            rather than an overall deployment deadline.</li>
        </ol>
        <p>Record the secret expiry and assign a rotation owner. Create a replacement secret, update the saved
          credential, test the connection and a selected feature, then remove the old secret.
          Keep secrets in the credential vault, outside canvas fields and logs.</p>
      </>,
    },
    {
      key: 'connect', label: '4. Connect and verify', content: <>
        <ol>
          <li>On <strong>Connections</strong>, save a connection with the app-registration credential.
            Saving registers the <code>entra-tenant</code> deployment target.</li>
          <li>If an endpoint is requested, use <code>https://graph.microsoft.com</code>. It is informational;
            the app uses fixed Graph and login hosts.</li>
          <li>Choose <strong>Test</strong> and confirm the returned tenant name and IDs match the intended directory.</li>
          <li>Open the pickers for your chosen configuration type and validate a test configuration.</li>
        </ol>
        <p>Set <code>readiness_features</code> to selected configuration IDs. For scoped features, supply <code>readiness_targets</code> as a JSON object keyed by configuration ID with parentId and, where required, resourceId. Missing scope IDs are reported as unverified.</p>
        <p><strong>Test scope:</strong> Test exchanges a token and reads <code>/organization</code> using{' '}
          <code>Organization.Read.All</code>. Success confirms that read operation; selected feature probes verify their read endpoints only. Write permissions,
          licensing, and unselected features remain unverified.</p>
      </>,
    },
    {
      key: 'deploy', label: '5. First deployment', content: <>
        <ol>
          <li>Create a configuration in the Configuration Canvas and explicitly select the intended <code>entra-tenant</code> target.</li>
          <li>Deploy referenced groups, locations, and custom strengths before policies that use them.
            Prefer picker-selected IDs; display names can be duplicated.</li>
          <li>For Conditional Access, select a pilot group and explicit applications. Keep the default <strong>report-only</strong>
            state and select tested emergency-access exclusions.</li>
          <li>Validate, review warnings, deploy, then check health, drift, and the resulting objects in Entra.</li>
          <li>Review report-only sign-in results before deliberately enabling a policy. Review Security Defaults
            compatibility before changing either tenant-wide control.</li>
        </ol>
        <p>The default is a starting value: explicitly choosing Enabled enforces the policy on deployment. Tenant-wide enforcement requires the canvas acknowledgement; deployment checks that Security Defaults is readable and disabled.</p>
        <p>The added resource types accept an allowlisted Managed properties JSON object. Supply existing object IDs and parent IDs for nested resources. Omitted fields remain unmanaged; explicit arrays replace the managed collection. Review provisioning schema replacement before enabling a job.</p>
        <p>Open <strong>Operations</strong> for {ENTRA_OPERATIONS.length} one-off administrative actions. Select the saved connection and target, inspect the required permission, then type the action ID to confirm. These actions run immediately and do not have configuration rollback.</p>
        <p>Open <strong>Reports</strong> for {ENTRA_REPORTS.length} read-only views, including licenses, DNS verification, audit logs, risk and provisioning/governance requests. Results stop at 200 records and indicate truncation. Verify asynchronous requests here before retrying. User licensing preserves group-inherited assignments; an explicit empty license list removes direct assignments.</p>
        <p>Review rollback limits: external identity-provider secrets are write-only and cannot be restored from Graph;
          created custom attribute sets cannot be deleted. Preserve an independent recovery path.</p>
      </>,
    },
    {
      key: 'troubleshooting', label: '6. Troubleshooting', content: <dl>
        <dt><strong>Missing credential or token failure</strong></dt>
        <dd>Check Tenant ID, Application ID, secret expiry and secret Value. Status 0 can indicate token or network failure;
          read the accompanying message. Check outbound HTTPS from the runtime.</dd>
        <dt><strong>Graph 401 or 403</strong></dt>
        <dd>Check application permissions and tenant consent for the failing endpoint. Test requires Organization.Read.All;
          deployment may need more permissions. Check licensing and API support before expanding access.</dd>
        <dt><strong>Empty picker or object not found</strong></dt>
        <dd>Check tenant selection, search text, resource existence and read permissions. Cloud-app targets use application IDs;
          service-principal references use object IDs. Use an existing agreement ID for Terms of Use.</dd>
        <dt><strong>Deploy target unavailable</strong></dt>
        <dd>Save the connection, confirm its entra-tenant target and credential, and select it in the canvas.</dd>
        <dt><strong>Throttling or timeout</strong></dt>
        <dd>The client retries HTTP 429 once, waiting at most 20 seconds. Reduce concurrent work and inspect live state before
          retrying a partial deployment. Increase the request timeout only after checking connectivity.</dd>
      </dl>,
    },
  ]

  return <>
    <Card variant="bordered" padding="md"><CardBody>
      <h2>Connect Microsoft Entra ID</h2>
      <h3>Connect using Microsoft OAuth</h3>
      <ol>
        <li>Open Connections and choose <strong>Integrate with Microsoft (OAuth)</strong>.</li>
        <li>Name the connection, select its environment, then continue to Microsoft and sign in with an active Global Administrator or Privileged Role Administrator, then review and approve access.</li>
        <li>Return to Veltrix and choose Test. Each saved connection keeps its own directory binding; no client secret or Tenant ID needs to be entered by the connecting administrator.</li>
      </ol>
      <p>A platform administrator first configures the Entra connector in Platform Admin &gt; Cloud Integrations &gt; Settings. If the connector is unavailable, the dialog explains that prerequisite. Choose Microsoft Entra OAuth / OpenID Connect in Connector apps and configure DirectoryRole claims on the registration. Microsoft shows the permissions configured on that connector registration; adding features can require new consent.</p>
      <p>OpenID Connect verifies the connecting Microsoft administrator; OAuth admin consent authorizes background Graph operations. User sign-in alone does not grant Graph administration permissions. The manual setup steps below remain available for existing registrations.</p>
      <p>Register an application, grant feature-specific permissions, then verify your tenant and first deployment.
        Complete these steps in order.</p>
    </CardBody></Card>
    <Tabs tabs={tabs.map((tab) => ({ ...tab, content:
      <Card variant="bordered" padding="md"><CardBody>{tab.content}</CardBody></Card>,
    }))} />
  </>
}
