import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'cortex-xdr',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/cortex-xdr/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/cortex-xdr/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/cortex-xdr/connections', label: 'Connections', icon: 'link' },
  ],
}
