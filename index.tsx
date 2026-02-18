
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { MsalProvider } from "@azure/msal-react";
import { msalInstance, msalReady } from "./authConfig";

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);

// MSAL v3 requires initialize() to complete before any token operations.
// Await initialization, then render the app so that MsalProvider and all
// downstream acquireToken* calls have a fully-ready instance.
msalReady.then(() => {
  root.render(
    <React.StrictMode>
      <MsalProvider instance={msalInstance}>
        <App />
      </MsalProvider>
    </React.StrictMode>
  );
});
