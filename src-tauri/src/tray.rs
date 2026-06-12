//! System-tray icon + summon/hide (a "bigger bet" from IDEAS.md). Right-click opens a menu
//! (Show/Hide, Quit); left-click toggles the window. Quit is delegated to the frontend by emitting
//! `termhaus://quit` so it flushes persisted state before destroying the window — the same path as
//! the title-bar close button. The global hotkey that also summons the window is registered from
//! TypeScript (it's a user-configurable setting), so this module is purely the tray.

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, Emitter, Manager, Runtime,
};

/// Build the tray icon and wire its menu + click handlers. Call once from `setup`.
pub fn build<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Show / Hide Termhaus", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Termhaus", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("Termhaus")
        .menu(&menu)
        // Left-click toggles the window; right-click opens the menu (standard tray behaviour).
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_window(app),
            // Hand off to the frontend so it flushes state before destroying the window.
            "quit" => {
                let _ = app.emit("termhaus://quit", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Show+focus the main window if it's hidden, else hide it — the summon/dismiss gesture shared by
/// the tray (left-click + menu). The global hotkey does the same from the frontend.
pub fn toggle_window<R: Runtime, M: Manager<R>>(manager: &M) {
    if let Some(win) = manager.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}
