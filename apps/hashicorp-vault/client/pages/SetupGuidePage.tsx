import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['ACL policies', 'Auth methods', 'Secret engines', 'Audit devices']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'token',
      label: '1. Vault token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Create a Vault token with a policy that grants <code>sudo</code> on the{' '}
              <code>sys/</code> paths this app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Concretely, the token's policy needs <code>create</code>/<code>update</code>/
              <code>delete</code> plus <code>sudo</code> on <code>sys/policies/acl/*</code>,{' '}
              <code>sys/auth/*</code>, <code>sys/mounts/*</code> and <code>sys/audit/*</code>. Prefer
              a periodic or renewable token scoped to exactly these paths — not a root token.
            </p>
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
            <p>Store the token as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>API token</strong> → the Vault token
              </li>
            </ul>
            <p>
              Every request is sent with <code>X-Vault-Token</code>. For Vault Enterprise or HCP, set
              the namespace in the app settings (sent as <code>X-Vault-Namespace</code>).
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
              Register a <strong>vault-cluster</strong> component whose hostname is the Vault URL
              (e.g. <code>https://vault.example.com:8200</code>) and attach the credential.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the
              pipeline. Two cautions Vault imposes: disabling a secret engine or auth method{' '}
              <strong>destroys its data/leases</strong>, and an audit device pointed at an
              unreachable target can <strong>block Vault</strong> — so rollbacks that delete a mount,
              and audit changes, ask for confirmation.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
