import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App';
import './index.css';
import './styles.css';
// runtime.css is loaded after styles.css so its rules can refine
// existing code-block-header styling without editing styles.css.
// See runtime.css for the comment explaining the cascade trick.
import './runtime.css';
// motion-block.css follows the same "additive feature, separate file"
// pattern as runtime.css — keeps the Motion calculator widget styles
// out of the giant styles.css and makes reverting one feature a
// single-file delete + import-line removal.
import './motion-block.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Could not find #root element in index.html.');
}

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
