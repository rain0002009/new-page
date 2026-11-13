import ReactDOM from 'react-dom/client'
import DocumentApp from './DocumentApp'
import ExternalDocumentApp from './ExternalDocumentApp'
import '../newtab/styles.css'
import './editor.css'

ReactDOM.createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('note') ? <DocumentApp /> : <ExternalDocumentApp />)
