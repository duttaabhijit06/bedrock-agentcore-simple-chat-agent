import { ChatWindow } from "./components/ChatWindow";

function App() {
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
