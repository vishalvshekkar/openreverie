import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { ApiClient } from './api.js'
import { appConfig } from './config.js'
import './styles.css'

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <App api={new ApiClient(appConfig.apiBaseUrl)} preAuthenticated={appConfig.preAuthenticated} />,
  )
}
