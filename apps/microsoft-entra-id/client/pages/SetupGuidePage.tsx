import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

// Microsoft Graph APPLICATION permissions the app-registration needs, granted
// admin consent, to cover every configuration type + the connection test.
const GRAPH_PERMISSIONS = [
  'Policy.ReadWrite.ConditionalAccess',
  'Policy.Read.All',
  'Group.ReadWrite.All',
  'User.Read.All',
  'RoleManagement.Read.Directory',
  'Organization.Read.All',
]

/**
 * Step-by-step connection guide for the Microsoft Entra ID app, rendered with
 * the platform design-system components from @veltrixsecops/app-sdk/ui — the
 * same Tabs / Card / Badge the built-in platform screens use, themed to the
 * app's brand color. Entra authenticates as an app registration via OAuth2
 * client credentials.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'app-registration',
      label: '1. App registration',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the <strong>Microsoft Entra admin center</strong>, go to{' '}
              <strong>Identity &gt; Applications &gt; App registrations</strong> and register a new
              application (single tenant). From its <strong>Overview</strong>, copy:
            </p>
            <ul>
              <li>
                <strong>Application (client) ID</strong> — used as the credential username
              </li>
              <li>
                <strong>Directory (tenant) ID</strong> — used for the app's Tenant ID setting
              </li>
            </ul>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'permissions',
      label: '2. Graph permissions',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Under <strong>API permissions</strong>, add these Microsoft Graph{' '}
              <strong>application</strong> permissions (not delegated), then click{' '}
              <strong>Grant admin consent</strong>:
            </p>
            <div>
              {GRAPH_PERMISSIONS.map((perm) => (
                <Badge key={perm} variant="primary" size="sm">
                  {perm}
                </Badge>
              ))}
            </div>
            <p>
              These cover Conditional Access policies, named locations, and authentication
              strengths (<code>Policy.ReadWrite.ConditionalAccess</code>, <code>Policy.Read.All</code>),
              security groups (<code>Group.ReadWrite.All</code>), the Included/Excluded Users
              live picker (<code>User.Read.All</code>), the Included/Excluded Roles live picker
              (<code>RoleManagement.Read.Directory</code>), and the connection test
              (<code>Organization.Read.All</code>). Admin consent is required — without it Graph
              rejects the app with 403.
            </p>
            <p>
              <strong>Terms of Use</strong> is the one exception: Microsoft Graph does not
              support listing terms-of-use agreements with application permissions at all (it's
              delegated-only), so no permission above makes that picker searchable — enter the
              agreement id directly, copied from the Entra admin center (Identity Governance{' '}
              &gt; Terms of use). Writing an agreement id into a policy's grant controls still
              works normally via <code>Policy.ReadWrite.ConditionalAccess</code>.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'secret',
      label: '3. Client secret',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Under <strong>Certificates &amp; secrets</strong>, create a new{' '}
              <strong>client secret</strong> and copy its <strong>Value</strong> immediately — Entra
              shows it only once. Set a rotation reminder for its expiry.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '4. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Store the app registration as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the Application (client) ID
              </li>
              <li>
                <strong>Password</strong> → the client secret value
              </li>
            </ul>
            <p>
              The app exchanges these for a bearer token via OAuth2 client credentials
              (<code>scope=https://graph.microsoft.com/.default</code>) and caches it until just
              before expiry.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connect',
      label: '5. Connect',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Set the app's <strong>Tenant ID</strong> setting to the Directory (tenant) ID, then on
              the <strong>Connections</strong> page create an <strong>entra-tenant</strong>{' '}
              connection and attach the credential. Use <strong>Test</strong> to verify the token
              exchange and Graph access.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the
              pipeline. Conditional Access policies reference security groups by display name and
              deploy as <strong>report-only</strong> by default — review the sign-in impact before
              switching a policy to Enabled, and exclude a break-glass group so an enforced policy
              can't lock every admin out.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
