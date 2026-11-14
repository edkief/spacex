import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@client/App';
import { getDriftCanvas } from '@client/canvas';
import './styles.css';

getDriftCanvas();

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root in index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
