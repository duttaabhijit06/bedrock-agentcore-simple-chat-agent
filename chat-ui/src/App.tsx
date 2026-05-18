import { useEffect } from "react";
import { ChatWindow } from "./components/ChatWindow";

function App() {
  useEffect(() => {
    // Global error handler
    const handleError = (event: ErrorEvent) => {
      console.error("[Global] Unhandled error:", event.error);
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.error("[Global] Unhandled promise rejection:", event.reason);
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    console.log("[App] Initialized, environment:", import.meta.env.MODE);

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>🎉 Party Supply Assistant</h1>
        <p>Ask me about products, orders, or party planning!</p>
      </header>
      <ChatWindow />
    </div>
  );
}

export default App;
