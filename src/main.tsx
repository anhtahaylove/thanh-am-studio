import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
// Before the first render, so React's first paint already has the stored or system theme; App keeps it in step afterwards.
const theme=localStorage.getItem('thanh-am-theme');document.documentElement.dataset.theme=theme==='dark'||theme!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
