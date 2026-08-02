import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = [
  'MX L3 (outbound) firewall rules',
  'MX L7 (application-layer) firewall rules',
  'Group policies',
  'Appliance VLANs',
]

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'api-key',
      label: '1. Dashboard API key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Meraki dashboard, go to <strong>Organization &gt; Settings</strong> and enable{' '}
              <strong>Dashboard API access</strong>. Then, from your admin profile page, click{' '}
              <strong>Generate new API key</strong> and copy it — Meraki shows it only once. The key
              inherits the permissions of the admin who generated it, so grants for this app should manage:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '2. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Store the Dashboard API key as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>API token</strong> → the Meraki Dashboard API key
              </li>
            </ul>
            <p>
              The app sends it as <code>Authorization: Bearer &lt;key&gt;</code> to{' '}
              <code>https://api.meraki.com/api/v1</code> on every request.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register a <strong>meraki-organization</strong> component and attach the credential. Meraki's
              API base is fixed for every organization, so the component's hostname is only a human label
              (e.g. your organization's name) — it is never used as a network address.
            </p>
            <p>
              Every config type's canvas item targets one Meraki <strong>network</strong> by its{' '}
              <code>network_id</code> (e.g. <code>L_646829496481099008</code>) — find it in the dashboard URL
              for that network, or via <code>GET /organizations/&#123;organizationId&#125;/networks</code>.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'per-type-notes',
      label: '4. Per-type notes',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              <strong>Group Policies</strong> reconcile by name (Meraki assigns the id); the schema beyond
              name is authored as one JSON block.
            </p>
            <p>
              <strong>Appliance VLANs</strong> reconcile by a VLAN id you choose (1-4094), and require VLANs
              to already be <strong>enabled</strong> on the network (Security &amp; SD-WAN &gt; Addressing
              &amp; VLANs) — this app checks that but does not enable it for you.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
