import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/wght.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import '@xterm/xterm/css/xterm.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/views.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
