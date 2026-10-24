import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const loadApp = import.meta.env.DEV && window.location.pathname === '/ui-preview'
  ? import('./RoomPreview.jsx')
  : import('./App.jsx');
loadApp.then(appModule => createRoot(document.getElementById('root')).render(createElement(appModule.default)));
