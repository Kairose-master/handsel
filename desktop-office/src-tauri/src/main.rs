// Prevents an extra console window from popping up on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// A thin native shell around the live /office page — no local worker logic,
// no polling, nothing this process does on its own. The window in
// tauri.conf.json points straight at handsel-main.vercel.app/office, the
// same page and the same session cookie a browser tab would use; this exists
// only to give it a dock icon and a window instead of a browser tab.
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Handsel Office");
}
