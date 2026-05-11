use std::{fs, path::PathBuf};

fn resolve_path(path: String) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);

    if path.as_os_str().is_empty() {
        return Err("File path is empty.".into());
    }

    Ok(path)
}

#[tauri::command]
fn read_gantt_file(path: String) -> Result<String, String> {
    let path = resolve_path(path)?;
    fs::read_to_string(&path).map_err(|err| format!("Failed to read file: {err}"))
}

#[tauri::command]
fn write_gantt_file(path: String, content: String) -> Result<(), String> {
    let path = resolve_path(path)?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Failed to create folder: {err}"))?;
    }

    fs::write(&path, content).map_err(|err| format!("Failed to write file: {err}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_gantt_file, write_gantt_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
