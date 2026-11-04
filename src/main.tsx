import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

/**
 * 应用挂载点：把 {@link App} 挂到 `#root`。
 * 此处只负责 React 入口，雨夜各系统由 App 内按需装配。
 */
const rootEl = document.getElementById( 'root' )
if ( ! rootEl ) {
	throw new Error( '[rainy-night-webgpu] #root element missing' )
}

createRoot( rootEl ).render( <App /> )
