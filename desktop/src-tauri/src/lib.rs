//! Loom desktop (M9): a thin Tauri shell around the local hub and its web client.

mod hub;
mod layout;

use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

/// The hub this app started, if it started one, and the hub's origin once known.
#[derive(Default)]
struct AppState {
    owned: Mutex<Option<hub::OwnedHub>>,
    origin: Mutex<Option<String>>,
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn show(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn splash(app: &AppHandle, call: &str, text: &str) {
    if let Some(w) = main_window(app) {
        let arg = serde_json::to_string(text).unwrap_or_default();
        let _ = w.eval(format!(
            "window.loomSplash && window.loomSplash.{call}({arg})"
        ));
    }
}

/// Attaches to a hub on the configured port, or starts the bundled one, then shows its page.
fn connect(app: AppHandle) {
    let port = layout::hub_port();
    let origin = format!("http://127.0.0.1:{port}");
    *app.state::<AppState>().origin.lock().unwrap() = Some(origin.clone());

    let url = match hub::probe(port) {
        hub::Probe::Hub => {
            // Not ours: it may belong to `npm run hub` or another user session. The client asks for its token.
            format!("{origin}/")
        }
        hub::Probe::Other => {
            splash(&app, "error", &format!("Port {port} is used by something that is not a Loom hub. Change \"port\" in {}.", layout::config_dir().join("hub.json").display()));
            return;
        }
        hub::Probe::Nothing => {
            let resource_dir = match app.path().resource_dir() {
                Ok(d) => d,
                Err(e) => {
                    return splash(
                        &app,
                        "error",
                        &format!("Cannot find the app's resources: {e}"),
                    )
                }
            };
            let token = hub::random_token();
            let mut owned = match hub::start(&hub::Bundle::new(&resource_dir), &token) {
                Ok(h) => h,
                Err(e) => return splash(&app, "error", &e),
            };
            if let Err(e) = hub::wait_ready(&mut owned, port, Duration::from_secs(60)) {
                owned.stop();
                return splash(&app, "error", &e);
            }
            *app.state::<AppState>().owned.lock().unwrap() = Some(owned);
            format!("{origin}/#token={token}&once=1")
        }
    };
    if let (Some(w), Ok(url)) = (main_window(&app), Url::parse(&url)) {
        let _ = w.navigate(url);
    }
}

fn quit(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.hide();
    }
    if let Some(owned) = app.state::<AppState>().owned.lock().unwrap().take() {
        owned.stop();
    }
    app.exit(0);
}

/// Pages from the hub stay in the window; anything else opens in the system browser.
fn allowed_in_window(app: &AppHandle, url: &Url) -> bool {
    if matches!(url.scheme(), "tauri" | "about" | "data")
        || url.host_str() == Some("tauri.localhost")
    {
        return true;
    }
    let origin = app.state::<AppState>().origin.lock().unwrap().clone();
    if origin.is_some_and(|o| url.as_str().starts_with(&format!("{o}/")) || url.as_str() == o) {
        return true;
    }
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
    false
}

/// WebKitGTK ships with media streams off and denies permission requests nobody handles.
#[cfg(target_os = "linux")]
fn enable_linux_media(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| {
        use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
        let view = webview.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_media_stream(true);
            settings.set_enable_mediasource(true);
            settings.set_media_playback_requires_user_gesture(false);
        }
        view.connect_permission_request(|view, request| {
            use webkit2gtk::glib::ObjectExt;
            let local = view.uri().is_some_and(|u| {
                u.starts_with("http://127.0.0.1:") || u.starts_with("http://localhost:")
            });
            let wanted = request.is::<webkit2gtk::UserMediaPermissionRequest>()
                || request.is::<webkit2gtk::NotificationPermissionRequest>();
            eprintln!(
                "loom: webview permission {} for {}: {}",
                request.type_().name(),
                view.uri().unwrap_or_default(),
                if local && wanted { "allowed" } else { "denied" }
            );
            if local && wanted {
                request.allow();
            } else {
                request.deny();
            }
            true
        });
    });
}

fn push_to_talk(app: &AppHandle, down: bool) {
    if let Some(w) = main_window(app) {
        // WebKitGTK does not open the microphone for a hidden page, so talking brings Loom up.
        if down && !w.is_visible().unwrap_or(true) {
            let _ = w.show();
        }
        let _ = w.eval(format!(
            "window.loomDesktop && window.loomDesktop.pushToTalk({down})"
        ));
    }
}

pub fn run() {
    let talk = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show(app)
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &talk {
                        push_to_talk(app, event.state() == ShortcutState::Pressed);
                    }
                })
                .build(),
        )
        .manage(AppState::default())
        .setup(move |app| {
            let handle = app.handle().clone();
            let nav = handle.clone();
            let loaded = handle.clone();
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Loom")
                    .inner_size(1280.0, 820.0)
                    .min_inner_size(720.0, 480.0)
                    .on_navigation(move |url| allowed_in_window(&nav, url))
                    .on_page_load(move |w, payload| {
                        if payload.url().host_str() == Some("127.0.0.1") {
                            let _ = w.eval("window.loomDesktop && window.loomDesktop.attached()");
                        }
                        let _ = &loaded;
                    })
                    .build()?;
            #[cfg(target_os = "linux")]
            enable_linux_media(&window);
            let _ = window;

            let open = MenuItemBuilder::with_id("open", "Open Loom").build(app)?;
            let quit_item =
                MenuItemBuilder::with_id("quit", "Quit Loom (stops sessions)").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&open)
                .separator()
                .item(&quit_item)
                .build()?;
            TrayIconBuilder::with_id("main")
                .tooltip("Loom")
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .expect("the app has an icon"),
                )
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show(app),
                    "quit" => quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show(tray.app_handle());
                    }
                })
                .build(app)?;

            if let Err(e) = app.global_shortcut().register(talk) {
                eprintln!("loom: push-to-talk shortcut unavailable: {e}");
            }
            std::thread::spawn(move || connect(handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps sessions running; the tray has Quit.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Loom app");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(owned) = app.state::<AppState>().owned.lock().unwrap().take() {
                owned.stop();
            }
        }
    });
}

/// `loom <command>`: the hub's CLI through the bundled Node, without a window.
pub fn run_cli(args: &[String]) -> i32 {
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Console::AttachConsole(
            windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS,
        );
    }
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let resource_dir = match tauri::utils::platform::resource_dir(
        context.package_info(),
        &tauri::Env::default(),
    ) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("loom: cannot find the app's resources: {e}");
            return 1;
        }
    };
    let bundle = hub::Bundle::new(&resource_dir);
    if let Err(e) = bundle.check() {
        eprintln!("loom: {e}");
        return 1;
    }
    let mut cmd = std::process::Command::new(&bundle.node);
    cmd.arg(&bundle.hub_entry).arg("cli").args(args);
    if std::env::var_os("LOOM_HUB_URL").is_none() {
        cmd.env(
            "LOOM_HUB_URL",
            format!("http://127.0.0.1:{}", layout::hub_port()),
        );
    }
    match cmd.status() {
        Ok(status) => status.code().map(|c| c.min(1)).unwrap_or(1),
        Err(e) => {
            eprintln!("loom: cannot run {}: {e}", bundle.node.display());
            1
        }
    }
}
