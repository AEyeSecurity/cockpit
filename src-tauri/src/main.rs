#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use commands::config::{read_config_file, unwatch_config_file, watch_config_file, write_config_file};
use commands::notifications::notify_system;
use commands::terminal::{
  terminal_close_session, terminal_list_ssh_hosts, terminal_resize, terminal_start_session, terminal_write
};
use commands::windows::open_aux_window;
use tauri::Manager;

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      #[cfg(debug_assertions)]
      {
        if let Some(window) = app.get_webview_window("main") {
          window.open_devtools();
        }
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      notify_system,
      open_aux_window,
      read_config_file,
      write_config_file,
      watch_config_file,
      unwatch_config_file,
      terminal_start_session,
      terminal_write,
      terminal_resize,
      terminal_close_session,
      terminal_list_ssh_hosts
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
