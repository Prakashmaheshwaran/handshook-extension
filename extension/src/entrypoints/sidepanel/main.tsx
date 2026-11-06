import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/ui/theme.css';
import { App } from '@/ui/App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Side panel root element is missing.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
