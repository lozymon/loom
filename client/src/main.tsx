import { render } from "solid-js/web";
import { App } from "./App.tsx";
import { registerServiceWorker } from "./pwa/push.ts";
import "./styles.css";

registerServiceWorker();

render(() => <App />, document.getElementById("root")!);
