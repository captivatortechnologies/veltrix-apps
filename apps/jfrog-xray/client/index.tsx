import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'jfrog-xray',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/jfrog-xray/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/jfrog-xray/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/jfrog-xray/connections', label: 'Connections', icon: 'link' },
  ],
}
