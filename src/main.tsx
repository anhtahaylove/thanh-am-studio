import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import {applyTheme,readTheme} from './theme';
// Before the first render, so React's first paint already has the stored or system theme; App keeps it in step afterwards.
applyTheme(document.documentElement,readTheme(),matchMedia('(prefers-color-scheme: dark)').matches);
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
