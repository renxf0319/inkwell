//! 工作区文件监听：把「磁盘上的增删改」实时推给前端。
//!
//! 为什么必须有它（而不是继续用 2 秒轮询）：
//! 轮询的延迟下限就是轮询间隔，用户拿 Typora 做参照物时，2 秒的滞后是
//! **一眼可见**的不同步 —— 「在资源管理器里删掉一个文件，编辑器里还挂着」。
//! 用户的原话是「在删除的一瞬间，应用这边也会消失」。
//!
//! 设计取舍：
//!  - 监听**整个工作区递归**，而不是只监听当前展开的目录。展开是前端的概念，
//!    Rust 侧不知道、也不该知道；递归监听由 OS 内核（Windows 的
//!    ReadDirectoryChangesW）完成，多开几层目录的代价可以忽略。
//!  - **防抖 120ms**：一次「保存文件」在 Windows 上会派发好几个事件
//!    （创建临时文件 → 改名 → 改属性）。不防抖就会让前端连着重读目录，
//!    白白重建 DOM —— 而 DOM 重建正是历史上「文件树某些行点不动」的成因。
//!  - **失败不致命**：没有监听能力时（权限、网络盘、不支持的 fs）只记日志，
//!    前端仍有轮询兜底。监听是「更好」，不是「必须」。
//!  - 事件只带一个「变了」的信号 + 受影响的路径，**不带目录内容**。
//!    目录内容仍由前端按需 read_dir 拉取，保证与「打开文件夹」「新建」走同一套
//!    逻辑（含类型白名单过滤），不会出现两套渲染路径各说各话。

use notify::{Event, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// 防抖窗口。见模块注释：一次写入会触发多个底层事件，必须合并。
/// 120ms 是「用户感知不到」与「一次保存只推一次」之间的折中：
/// 比它更小会在批量解压时把前端刷爆，更大就开始有可感知的滞后。
const DEBOUNCE: Duration = Duration::from_millis(120);

/// 推给前端的事件名。前端在 App.tsx 里监听这个名字。
pub const EVENT_NAME: &str = "kore://fs-change";

/// 一次「磁盘有变化」的通知。
///
/// `paths` 只用于**日志与将来可能的增量优化**（比如只刷新受影响的目录）；
/// 当前前端拿到信号后会刷新所有已展开目录 —— 一次 read_dir 极便宜，
/// 而「漏刷新某个目录」造成的不一致远比多读几次更让人恼火。
#[derive(Clone, Serialize)]
pub struct FsChange {
    /// 受影响的路径（可能为空 —— 某些平台的事件不带具体路径）
    pub paths: Vec<String>,
}

/// 当前生效的监听器。
///
/// 存 `RecommendedWatcher` 是**必须**的：`notify` 的 watcher 一旦被 drop
/// 就立刻停止监听（后台线程随之退出）。若只把接收端存起来、让 watcher
/// 随作用域结束被回收，表现就是「事件一个都收不到，但也不报错」——
/// 极难排查。所以这里用 State 把它**挂在 App 生命周期上**。
pub(crate) struct WatchState {
    /// 换工作区时先 drop 旧的再装新的，天然实现「取消上一个」
    watcher: Option<notify::RecommendedWatcher>,
    /// 当前正在监听的根目录，用于幂等判断（重复 watch 同一路径直接返回）
    root: Option<PathBuf>,
}

impl WatchState {
    fn new() -> Self {
        Self { watcher: None, root: None }
    }
}

/// 全局状态：Tauri 的 `manage` 要求类型可 Send + Sync。
/// `Mutex` 是为了让「换工作区」与「事件回调」不会同时改 watcher。
pub struct WatchHandle(pub Mutex<WatchState>);

impl WatchHandle {
    pub fn new() -> Self {
        Self(Mutex::new(WatchState::new()))
    }
}

/// 开始监听一个工作区根目录。重复调用同一路径是幂等的。
#[tauri::command]
pub fn watch_workspace(
    app: AppHandle,
    state: State<'_, WatchHandle>,
    path: String,
) -> Result<(), String> {
    let mut st = state.0.lock().map_err(|_| "监听状态锁被污染".to_string())?;

    let target = PathBuf::from(&path);

    // 幂等：已经在监听同一个目录，什么都不用做。
    // （前端在「打开文件夹」与「启动恢复」两处都会调用，必须能重复调。）
    if st.root.as_deref() == Some(target.as_path()) && st.watcher.is_some() {
        return Ok(());
    }

    if !target.is_dir() {
        return Err(format!("不是目录，无法监听: {}", path));
    }

    // 先卸掉旧监听：换工作区时不能沿用旧 watcher，
    // 否则会同时收到两个工作区的事件（表现为刷新到别的目录去）。
    st.watcher = None;
    st.root = None;

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

    let mut watcher = notify::recommended_watcher(move |res| {
        // 发送失败只可能是接收线程已退出（应用正在关闭），忽略即可
        let _ = tx.send(res);
    })
    .map_err(|e| format!("创建文件监听器失败: {}", e))?;

    watcher
        .watch(&target, RecursiveMode::Recursive)
        .map_err(|e| format!("监听目录失败 {}: {}", path, e))?;

    st.watcher = Some(watcher);
    st.root = Some(target);

    // 接收线程：把原始事件合并成防抖后的通知推给前端。
    //
    // ⚠️ 线程里**只**做「攒批 + 发事件」，不做任何 read_dir —— 读目录是前端的
    // 职责（它才知道哪些目录展开着、要不要按白名单过滤）。
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        // 攒批状态：窗口内收到的路径
        let mut pending: Vec<String> = Vec::new();
        let mut deadline: Option<Instant> = None;

        loop {
            // 有截止时间就等到它；没有就阻塞等事件（不空转）
            let msg = match deadline {
                Some(d) => {
                    let now = Instant::now();
                    if now >= d {
                        flush(&app_for_thread, &mut pending);
                        deadline = None;
                        continue;
                    }
                    match rx.recv_timeout(d - now) {
                        Ok(m) => m,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            flush(&app_for_thread, &mut pending);
                            deadline = None;
                            continue;
                        }
                        // 发送端被 drop（watcher 已销毁 / 应用退出）→ 结束线程
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                None => match rx.recv() {
                    Ok(m) => m,
                    Err(_) => break,
                },
            };

            // 接收线程只关心「有事发生」。事件类型（创建/删除/改名）与路径
            // 都不影响前端的动作 —— 一律重读目录，让磁盘成为唯一事实来源。
            // 这样连「重命名」这种不产生对应 create/remove 对的平台差异也一并绕开。
            if let Ok(ev) = msg {
                for p in ev.paths {
                    let s = p.to_string_lossy().into_owned();
                    // 过滤掉编辑器自身的临时文件噪声（如 .goutputstream-*、~$xxx）
                    if is_noise(&s) {
                        continue;
                    }
                    pending.push(s);
                }
                // 即使 paths 为空（有些平台如此）也要记一笔：
                // 事件本身已足够说明「这个目录变了」
                deadline = Some(Instant::now() + DEBOUNCE);
            }
        }
    });

    Ok(())
}

/// 停止监听（关闭工作区时）。不影响应用其它功能。
#[tauri::command]
pub fn unwatch_workspace(state: State<'_, WatchHandle>) -> Result<(), String> {
    let mut st = state.0.lock().map_err(|_| "监听状态锁被污染".to_string())?;
    // drop watcher → 后台线程的 recv 拿到 Disconnected → 线程自行结束
    st.watcher = None;
    st.root = None;
    Ok(())
}

/// 把攒批的路径去重后推给前端。
fn flush(app: &AppHandle, pending: &mut Vec<String>) {
    if pending.is_empty() {
        return;
    }
    // 去重：同一个文件在窗口内可能被触发多次（改内容 + 改时间戳）
    pending.sort();
    pending.dedup();
    let payload = FsChange { paths: std::mem::take(pending) };
    // emit 失败（窗口已关）不影响：下次打开会重新拉取
    if let Err(e) = app.emit(EVENT_NAME, payload) {
        eprintln!("[kore] 推送文件变更事件失败: {}", e);
    }
}

/// 是否是需要忽略的噪声路径（编辑器 / 系统的临时文件）。
///
/// 不忽略的后果不是崩溃，而是**无意义的重读** —— 很多编辑器保存时会先写
/// `.goutputstream-XXXXXX` 再改名，Office 会留 `~$xxx.docx`。这些文件既不会
/// 出现在文件树里（扩展名不在白名单），也不该触发一次刷新。
fn is_noise(path: &str) -> bool {
    let name = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path);
    if name.starts_with("~$") || name.starts_with(".~") {
        return true;
    }
    if name.starts_with(".goutputstream-") {
        return true;
    }
    // 编辑器/系统常见的原子写临时后缀
    if name.ends_with(".swp") || name.ends_with(".swx") || name.ends_with(".tmp") {
        return true;
    }
    false
}
