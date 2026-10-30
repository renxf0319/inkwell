mod commands;
mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // 用系统默认浏览器打开外部链接（「检查更新 → 前往下载」）。
        .plugin(tauri_plugin_opener::init())
        // 应用内自动更新（下载 / 校验签名 / 安装）与装完重启
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 工作区文件监听：磁盘变化实时推给前端（见 watch.rs 的模块注释）
        .manage(watch::WatchHandle::new())
        .invoke_handler(tauri::generate_handler![
            commands::read_dir,
            commands::read_file,
            commands::write_file,
            // 文件树右键菜单（新增 / 删除 / 在文件管理器中定位）
            commands::create_file,
            commands::create_dir,
            commands::remove_file,
            commands::remove_dir,
            commands::rename_path,
            commands::reveal_in_explorer,
            // 实时文件同步
            watch::watch_workspace,
            watch::unwatch_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
