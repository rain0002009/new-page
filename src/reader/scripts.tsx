import ReactDOM from 'react-dom/client'
import ReaderApp from './ReaderApp'
import { ToastProvider } from '../shared/Toast'
import '../newtab/styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <ReaderApp />
  </ToastProvider>,
)
