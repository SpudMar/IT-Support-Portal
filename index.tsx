
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { MsalProvider } from "@azure/msal-react";
import { msalInstance } from "./authConfig";

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <MsalProvider instance={msalInstance}>
      <App />
    </MsalProvider>
  </React.StrictMode>
);
