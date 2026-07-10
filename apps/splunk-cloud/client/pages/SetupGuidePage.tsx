import React from 'react'

/**
 * Static setup instructions: how to point this app at a Splunk Cloud stack
 * and authenticate against the Admin Config Service (ACS) API.
 */
export default function SetupGuidePage() {
  return (
    <div>
      <h2>Splunk Cloud Setup Guide</h2>

      <h3>1. Register your stack as a component</h3>
      <p>
        Add a component with type <code>splunk-cloud-stack</code>. Set its hostname to your stack
        name — either the bare name (<code>mystack</code>) or the full domain (
        <code>mystack.splunkcloud.com</code>); the app derives the ACS stack name automatically.
        Your stack name is the subdomain you use to reach Splunk Web.
      </p>

      <h3>2. Create an ACS authentication token</h3>
      <ol>
        <li>
          Sign in to Splunk Web as a user with the <code>sc_admin</code> role.
        </li>
        <li>
          Go to <strong>Settings &gt; Tokens</strong> and create a new authentication token (JWT).
        </li>
        <li>
          Store the token in a Veltrix credential&apos;s <strong>API token</strong> field and
          assign that credential to your stack component.
        </li>
      </ol>
      <p>
        Tokens expire — rotate them before expiry or health checks will start failing with
        authentication errors. For automated rotation, ACS itself exposes a{' '}
        <code>/adminconfig/v2/tokens</code> endpoint.
      </p>

      <h3>3. Check app settings</h3>
      <p>
        The default ACS base URL is <code>https://admin.splunk.com</code>. FedRAMP Moderate (IL2)
        stacks must use <code>https://admin.splunkcloudgc.com</code> instead. Set your Splunk
        Cloud Experience (Victoria or Classic) to match your stack — all configuration types in
        this app work on both.
      </p>

      <h3>4. Author configurations</h3>
      <p>
        Create a Configuration Canvas for indexes, HEC tokens, or IP allow lists and run it
        through the pipeline. Deployments are asynchronous on the Splunk side — new indexes and
        HEC tokens can take a few minutes to finish provisioning.
      </p>

      <p>
        <small>
          Note: the ACS API is rate limited to 600 requests per 10 minutes per stack. Very large
          canvases may approach this limit during deployment.
        </small>
      </p>
    </div>
  )
}
