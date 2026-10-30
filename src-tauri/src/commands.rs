use serde::Serialize;
use std::fs;
use std::path::Path;

/// 目录项：文件名、完整路径、是否为目录
///
/// ⚠️ `rename_all = "camelCase"` 不是可选的洁癖，而是**修一个真实 bug**：
/// Tauri 只对**命令参数**做 camelCase 转换，**返回值**按 `serde` 原样序列化。
/// 所以字段名 `is_dir` 到了前端就是 `is_dir`，而 TS 侧读的是 `node.isDir`，
/// 结果恒为 `undefined`（falsy）→ 所有子目录都被当成文件：
///   - 图标显示成文件图标
///   - 点击走 `openFile` 而不是 `toggleExpand`
///   - 于是 `read_to_string(目录)` 在 Windows 上报 os error 5「拒绝访问」
/// 去掉这行会立刻复现「文件夹无法展开」的故障。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// 列出目录内容：目录优先，再按名称（不区分大小写）排序
#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("不是目录: {}", path));
    }
    let mut entries: Vec<FileEntry> = Vec::new();
    let read = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in read.flatten() {
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let full = entry.path();
        entries.push(FileEntry {
            name,
            path: full.to_string_lossy().into_owned(),
            is_dir: file_type.is_dir(),
        });
    }
    entries.sort_by(|a, b| match b.is_dir.cmp(&a.is_dir) {
        std::cmp::Ordering::Equal => {
            let an = a.name.to_lowercase();
            let bn = b.name.to_lowercase();
            an.cmp(&bn)
        }
        other => other,
    });
    Ok(entries)
}

/// 读取文本文件
///
/// 只放行受支持的纯文本扩展名，且必须是合法 UTF-8。
/// 两条都是前端体验的硬要求：
///  - 白名单外的文件（.class / .png / .jar）如果硬读，
///    `read_to_string` 要么报「stream did not contain valid UTF-8」这种
///    用户看不懂的底层错误，要么在别的平台上解出一屏乱码。
///  - 扩展名是白名单内但内容是二进制（有人把 .txt 改成 .exe）时，
///    同样会走到上面那条路。所以在**读完之后**再补一道 UTF-8 校验。
///
/// ⚠️ `SUPPORTED_EXTS` 必须与前端 `src/lib/filetype.ts` 的白名单保持一致。
/// 前端已经拦过一次，这里是防止绕过前端直接调 command 的第二道闸。
const SUPPORTED_EXTS: &[&str] = &[
    "md", "markdown", "mdown", "txt", "text", "log", "sql", "conf", "cfg", "ini", "properties",
    "yaml", "yml", "json", "toml", "xml",
    // 代码文件（前端会挂 javascript() 高亮，见 src/lib/filetype.ts 的 CODE 集合）
    "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx",
];

fn is_supported_ext(path: &Path) -> bool {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .map(|e| SUPPORTED_EXTS.contains(&e.as_str()))
        .unwrap_or(false)
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_else(|| "无扩展名".to_string())
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    // 先判目录：对目录调 read_to_string 在 Windows 上只会得到
    // os error 5「拒绝访问」，用户完全看不出真实原因（他其实点错了文件夹）。
    // 这里显式拦下来并给出可读提示，前端据此把提示换成「请点击左侧箭头展开」。
    if p.is_dir() {
        return Err(format!("这是一个文件夹，不是文件: {}", path));
    }
    if !is_supported_ext(p) {
        return Err(format!(
            "暂不支持打开「{}」（{}）。仅支持文本与代码类型：.md / .txt / .sql / .conf / .properties / .yaml / .js / .ts",
            p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone()),
            ext_of(p)
        ));
    }
    // 扩展名合法，但内容未必是文本：UTF-8 校验失败就明确说「不是文本文件」，
    // 而不是把底层错误抛给前端。
    match fs::read(p) {
        Ok(bytes) => String::from_utf8(bytes).map_err(|e| {
            let kind = if e.utf8_error().valid_up_to() == 0 {
                "看起来是二进制文件"
            } else {
                "编码不是 UTF-8（可能是 GBK 等其它编码）"
            };
            format!("无法打开「{}」：{}，请先用文本编辑器转存为 UTF-8", path, kind)
        }),
        Err(e) => Err(format!("读取失败 {}: {}", path, e)),
    }
}

/// 写入文本文件（覆盖）
#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| format!("写入失败 {}: {}", path, e))
}

// ---------------------------------------------------------------------------
// 文件树右键菜单用到的操作
//
// 全部遵循同一条原则：**能明确说清失败原因就说清**，不要把一个裸的
// io error 丢给用户（「os error 183」没人看得懂）。
// ---------------------------------------------------------------------------

/// 目标已存在时的统一错误文案。新建文件/文件夹都先查这一条 ——
/// 静默覆盖用户的文件是不可接受的，宁可报错让他改个名字。
fn exists_err(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    format!("「{}」已存在，请换一个名字", name)
}

/// 新建空文件。
///
/// 用 `create_new(true)` 而不是 `write`：它在**打开时就**要求文件不存在，
/// 因此连「检查完到写入之间被别的程序抢先创建」这种竞态也一并挡掉。
#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(exists_err(p));
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(p)
        .map(|_| ())
        .map_err(|e| format!("新建文件失败 {}: {}", path, e))
}

/// 新建目录。只建一层：上层目录必然存在（我们是从文件树里点的）。
#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(exists_err(p));
    }
    fs::create_dir(p).map_err(|e| format!("新建文件夹失败 {}: {}", path, e))
}

/// 删除文件
#[tauri::command]
pub fn remove_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("「{}」已不存在（可能已被其它程序删除）", path));
    }
    if p.is_dir() {
        return Err(format!("「{}」是文件夹，不能按文件删除", path));
    }
    fs::remove_file(p).map_err(|e| format!("删除失败 {}: {}", path, e))
}

/// 递归删除目录
#[tauri::command]
pub fn remove_dir(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("「{}」已不存在（可能已被其它程序删除）", path));
    }
    if !p.is_dir() {
        return Err(format!("「{}」不是文件夹", path));
    }
    fs::remove_dir_all(p).map_err(|e| format!("删除失败 {}: {}", path, e))
}

/// 重命名文件或目录（同一父目录内改名）。
///
/// `fs::rename` 在 Windows 上对文件与目录都适用（同卷内就是一次原子的改名）。
/// 目标已存在时直接拒绝：覆盖既有文件不可接受，与新建时的语义保持一致。
#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    let src = Path::new(&from);
    let dst = Path::new(&to);
    if !src.exists() {
        return Err(format!(
            "「{}」已不存在（可能已被其它程序移动或删除）",
            from
        ));
    }
    if dst.exists() {
        return Err(exists_err(dst));
    }
    fs::rename(src, dst).map_err(|e| format!("重命名失败 {} → {}: {}", from, to, e))
}

/// 在系统文件管理器里定位这个路径：
///  - 目录 → 直接打开它
///  - 文件 → 打开它所在的目录并**选中**该文件
///
/// 为什么自己起进程而不用 opener 插件的 reveal：
/// 插件的 `reveal_item_in_dir` 受前端 scope 约束（默认不放行任意绝对路径），
/// 而这里只是本机文件管理器的一个定位动作，自己 spawn 更直接、行为也更可控。
///
/// ⚠️ 一律用 `spawn` 而不 `wait`：explorer.exe 在成功时也会返回非 0 退出码，
/// 等它、解读它的返回值只会带来误报。
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("「{}」已不存在", path));
    }
    let is_dir = p.is_dir();

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // 不弹黑色控制台窗口（explorer 本身是 GUI，但保险起见）
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = std::process::Command::new("explorer");
        if is_dir {
            cmd.arg(&path);
        } else {
            // `/select,<完整路径>` 必须作为**一个**参数传入，中间不能有空格
            cmd.arg(format!("/select,{}", path));
        }
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("打开文件管理器失败: {}", e))
    }

    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if is_dir {
            cmd.arg(&path);
        } else {
            cmd.arg("-R").arg(&path); // -R = 在 Finder 中显示
        }
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("打开访达失败: {}", e))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Linux 没有统一的「选中文件」能力，退化为打开所在目录
        let target = if is_dir {
            path.clone()
        } else {
            p.parent()
                .map(|d| d.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone())
        };
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("打开文件管理器失败: {}", e))
    }
}
