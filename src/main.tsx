import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// You need to export CustomNotification from App.tsx or move it to its own file.
// For now, let's assume you export it: import { CustomNotification } from "./App"; 

// ... inside main.tsx
import { appWindow } from "@tauri-apps/api/window";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

if (appWindow.label === 'notification') {
    // If we are the notification window, strip the background and render ONLY the notification
    document.body.style.background = 'transparent';
    document.documentElement.style.background = 'transparent';
    
    // We need to render the CustomNotification component here. 
    // You must export it from App.tsx first!
    import("./App").then(module => {
        root.render(<module.CustomNotification />);
    });
} else {
    // Normal dashboard rendering
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
}