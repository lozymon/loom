/* @refresh reload */
import { render } from "solid-js/web";

const root = document.getElementById("root") as HTMLElement;
const params = new URLSearchParams(window.location.search);
const detach = params.get("detach");

if (detach !== null) {
  // Torn-off pane window: render a single xterm bound to an existing PTY (multi-window tear-off).
  // Init the shared settings/theme stores first so the pane matches the main window's look.
  const paneId = Number(detach);
  const handle = Number(params.get("handle"));
  const title = params.get("title") ?? "";
  Promise.all([
    import("./components/DetachedPane"),
    import("./stores/settings"),
    import("./stores/theme"),
  ]).then(async ([{ default: DetachedPane }, settings, theme]) => {
    await settings.initSettings();
    await theme.initTheme();
    render(() => <DetachedPane paneId={paneId} handle={handle} title={title} />, root);
  });
} else {
  // The normal app.
  import("./App").then(({ default: App }) => {
    render(() => <App />, root);
  });
}
