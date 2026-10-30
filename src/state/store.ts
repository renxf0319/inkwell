import { create } from 'zustand'
import type { OpenTab, SidePane, ThemeMode } from '../lib/types'
import { fsApi, isTauri, NotOpenableError } from '../lib/fs'
import { applyTheme, getStoredTheme } from '../lib/theme'
import { isSupportedFile, unsupportedMessage } from '../lib/filetype'

// 用户可见的提示（取代从前"点什么都没反应"的静默失败）
export interface Notice {
  kind: 'info' | 'error'
  text: string
  // 需要用户手势才能完成的动作，交给界面渲染成按钮
  //  - regrant：浏览器端重新授权文件夹
  //  - release：去浏览器下载页
  //  - update ：应用内下载并安装更新（推荐路径）
  action?: 'regrant' | 'release' | 'update'
}

function errText(e: unknown): string {
  // 浏览器的文件系统 API 抛的都是英文 DOMException，直接显示对用户毫无意义
  if (e instanceof DOMException) {
    switch (e.name) {
      case 'NotFoundError':
        return '找不到该文件或目录（可能已被移动、重命名或删除）'
      case 'NotAllowedError':
        return '浏览器拒绝了该操作'
      case 'SecurityError':
        return '缺少文件夹读写权限，需要重新授权'
      case 'TypeMismatchError':
        return '已存在同名的文件或文件夹'
      case 'InvalidModificationError':
        return '该操作不被允许（目标文件夹非空等）'
      case 'NoModificationAllowedError':
        return '文件被占用或只读'
      case 'QuotaExceededError':
        return '磁盘空间不足'
      case 'AbortError':
        return '操作已取消'
      default:
        return `${e.name}：${e.message}`
    }
  }
  if (e instanceof Error) return e.message
  return String(e)
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

/**
 * 判断「读取失败」是不是因为目标其实是目录。
 * Windows 上对目录调 read_to_string 会得到 os error 5（ERROR_ACCESS_DENIED），
 * 但同一条错误信息也可能来自真正的权限问题，所以这里只做保守判断：
 * 仅当错误文本里出现目录相关的中文提示或明确的 access denied 且路径无扩展名时才算。
 */
function isDirectoryError(e: unknown): boolean {
  const t = e instanceof Error ? e.message : String(e)
  return /不是文件|是文件夹|is a directory|EISDIR/i.test(t)
}

// 恢复上次文件夹是启动路径上唯一可能长时间挂起的操作（IndexedDB 反序列化句柄、
// 浏览器权限数据库异常等）。加超时兜底：宁可这一次不恢复，也不能让页面卡死。
function withTimeout<T>(
  p: Promise<T>,
  ms: number
): Promise<{ value: T | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ value: null, timedOut: true }), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve({ value: v, timedOut: false })
      },
      () => {
        clearTimeout(timer)
        resolve({ value: null, timedOut: false })
      }
    )
  })
}

let untitledSeq = 0

interface AppState {
  theme: ThemeMode
  mode: 'tauri' | 'browser' | 'unknown'
  rootPath: string | null
  rootName: string | null
  expanded: Record<string, boolean>
  dirs: Record<string, { name: string; path: string; isDir: boolean }[]>
  tabs: OpenTab[]
  /** 当前激活标签的 id（不是 path —— 未命名文档没有 path） */
  active: string | null
  ready: boolean
  notice: Notice | null
  /** 左侧栏当前页签：文件 / 大纲 */
  pane: SidePane
  /** 左侧栏是否展开；折叠后主区占满 */
  sidebarOpen: boolean
  /** 左侧栏宽度（px），可由侧栏右缘的竖线拖动调整 */
  sidebarW: number
  /** 大纲跳转请求：目标行号，由 Editor 消费后清空 */
  jumpLine: number | null

  init: () => Promise<void>
  setNotice: (n: Notice | null) => void
  regrantRoot: () => Promise<void>
  setTheme: (t: ThemeMode) => void
  setPane: (p: SidePane) => void
  toggleSidebar: () => void
  setSidebar: (open: boolean) => void
  setSidebarW: (w: number) => void
  setJumpLine: (n: number | null) => void

  newDoc: () => void
  openFileDialog: () => Promise<void>
  openFolder: () => Promise<void>
  loadDir: (path: string) => Promise<void>
  toggleExpand: (path: string) => void
  openFile: (path: string, name: string) => Promise<void>
  /** 重新读取某个已加载目录；列表没变化时不触发任何渲染。返回「该目录是否已不存在」 */
  refreshDir: (path: string) => Promise<boolean>
  /** 刷新所有「已展开」的目录（窗口获得焦点 / 定时轮询时调用） */
  refreshTree: () => Promise<void>
  /** 在 parentPath 下新建文件或文件夹，并**立刻落盘** */
  createEntry: (parentPath: string, name: string, isDir: boolean) => Promise<void>
  /** 删除文件或目录（目录递归），并同步磁盘 */
  deleteEntry: (path: string, isDir: boolean, parentPath: string) => Promise<void>
  /** 在系统文件管理器里定位该路径 */
  revealEntry: (path: string) => Promise<void>
  closeDoc: () => void
  updateContent: (id: string, content: string) => void
  save: () => Promise<void>
  saveAs: () => Promise<void>
  activeTab: () => OpenTab | null

  // --- 单文档切换的未保存拦截 ---
  /** 待确认的切换动作；非 null 时对话框显示「保存 / 放弃 / 取消」 */
  pendingSwitch: (() => void) | null
  /** 切换前的统一入口：当前文档有未保存改动时挂起动作，否则直接执行 */
  guard: (action: () => void) => void
  /** 关闭当前文档（走拦截） */
  requestClose: () => void
  /** 放弃未保存改动，直接执行待切换动作 */
  resolveDiscard: () => void
  /** 取消切换 */
  cancelSwitch: () => void
}

/**
 * 左侧栏宽度：拖动竖线可调，持久化到 localStorage。
 * 范围限制在 [140, 520]：小于 140px 文件名几乎不可读，大于 520px
 * 编辑区会被压得比侧栏还窄，失去主次。
 */
const SIDEBAR_W_MIN = 140
const SIDEBAR_W_MAX = 520
const SIDEBAR_W_DEFAULT = 196
const SIDEBAR_W_KEY = 'kore-sidebar-w'

function clampSidebarW(w: number): number {
  return Math.round(Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, w)))
}

function readSidebarW(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_W_KEY)
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) ? clampSidebarW(n) : SIDEBAR_W_DEFAULT
  } catch {
    // 隐私模式下 localStorage 可能抛异常，用默认值即可
    return SIDEBAR_W_DEFAULT
  }
}

/**
 * 单文档模式：`tabs` 永远只有 0 或 1 个元素。
 * 保留数组结构是为了让 Editor / StatusBar / FileTree 的取值逻辑不必大改，
 * 但**不要**再往里 push 第二个文档。
 */
function single(doc: OpenTab | null): Pick<AppState, 'tabs' | 'active'> {
  return { tabs: doc ? [doc] : [], active: doc ? doc.id : null }
}

/**
 * 两份目录列表是否「等价」—— 只看名字与是否目录，不看 path
 * （path 由名字推导，名字相同则 path 必然相同）。
 *
 * 用途见 refreshDir：轮询刷新时，列表没变就绝不 setState。
 */
function sameList(
  a: { name: string; isDir: boolean }[],
  b: { name: string; isDir: boolean }[]
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].isDir !== b[i].isDir) return false
  }
  return true
}

/**
 * 造一个空的未命名文档（Typora 启动时的样子）。
 * `id` 用时间戳 + 递增序号，保证同一毫秒内连续新建也不会撞 key。
 */
function makeBlank(): OpenTab {  untitledSeq += 1
  return {
    id: `untitled-${Date.now()}-${untitledSeq}`,
    path: null,
    name: '未命名',
    content: '',
    savedContent: '',
    dirty: false,
  }
}

export const useStore = create<AppState>((set, get) => ({
  theme: 'light',
  mode: 'unknown',
  rootPath: null,
  rootName: null,
  expanded: {},
  dirs: {},
  tabs: [],
  active: null,
  ready: false,
  notice: null,
  pane: 'files',
  sidebarOpen: true,
  sidebarW: readSidebarW(),
  jumpLine: null,
  pendingSwitch: null,

  async init() {
    const theme = getStoredTheme()
    applyTheme(theme)
    const mode = isTauri ? 'tauri' : 'browser'
    set({ theme, mode })

    // 逃生口：地址栏加 ?reset 打开，直接丢弃上次保存的目录句柄。
    // 当恢复流程本身把页面拖死、连界面都点不动时，这是唯一还能用的自救方式。
    if (new URLSearchParams(location.search).has('reset')) {
      await fsApi.forgetRoot()
      set(single(makeBlank()))
      set({
        ready: true,
        notice: { kind: 'info', text: '已清除上次打开的文件夹记录，请重新选择目录' },
      })
      return
    }

    try {
      const { value: restored, timedOut } = await withTimeout(fsApi.restore(), 3000)
      if (timedOut) {
        set({
          notice: {
            kind: 'error',
            text: '恢复上次打开的文件夹超时，已跳过。可点击工具栏「打开文件夹」重新选择目录。',
          },
        })
      }
      if (restored) {
        set({ rootPath: restored.name, rootName: rootNameOf(restored.name) })
        if (restored.granted) {
          await get().loadDir(restored.name)
        } else {
          // 句柄还在，但浏览器要求由用户手势重新授权 —— 这在每次新开页面时都会发生，
          // 必须给出明确入口，否则所有文件操作都会静默失败。
          set({
            notice: {
              kind: 'info',
              text: `上次打开的「${restored.name}」需要重新授权才能读写`,
              action: 'regrant',
            },
          })
        }
      }
    } catch (e) {
      set({ notice: { kind: 'error', text: `恢复上次的文件夹失败：${errText(e)}` } })
    }
    // 启动即备好一个空的未命名文档（Typora 的行为）：
    // 右侧编辑区一进来就是可输入的光标，而不是欢迎页 ——
    // 「打开文件」应该是主动选择的结果，而不是进入编辑器的前提。
    set(single(makeBlank()))
    set({ ready: true })
  },

  setNotice(n) {
    set({ notice: n })
  },

  async regrantRoot() {
    const ok = await fsApi.regrant()
    if (!ok) {
      set({
        notice: {
          kind: 'error',
          text: '授权未通过。可以点击工具栏「打开文件夹」重新选择目录。',
        },
      })
      return
    }
    const root = get().rootPath
    set({ notice: null })
    if (root) await get().loadDir(root)
  },

  setTheme(t) {
    applyTheme(t)
    set({ theme: t })
  },

  setPane(p) {
    // 侧栏显隐只有一个入口：底部栏左下角的按钮（用户指定）。
    // 这里只负责切页签，不再做「再点一次=折叠」的隐式折叠。
    set({ pane: p, sidebarOpen: true })
  },

  toggleSidebar() {
    set((s) => ({ sidebarOpen: !s.sidebarOpen }))
  },

  setSidebar(open) {
    set({ sidebarOpen: open })
  },

  setSidebarW(w) {
    const sidebarW = clampSidebarW(w)
    set({ sidebarW })
    try {
      localStorage.setItem(SIDEBAR_W_KEY, String(sidebarW))
    } catch {
      // 存不上不影响本次会话使用，只是下次启动不留存
    }
  },

  setJumpLine(n) {
    set({ jumpLine: n })
  },

  // --- 未保存拦截 -----------------------------------------------------------
  // 所有会「丢弃当前文档」的动作（新建/打开/关闭）都先过这里。
  // 有未保存改动时把动作挂起，交给对话框的「保存 / 放弃 / 取消」决定。
  guard(action: () => void) {
    const cur = get().activeTab()
    if (cur?.dirty) {
      set({ pendingSwitch: action })
      return
    }
    action()
  },

  requestClose() {
    // 关掉最后一个文档后补一个空白文档，编辑区不退回欢迎页 ——
    // 与 Typora 一致：任何时刻都有一个可输入的编辑区。
    get().guard(() => set(single(makeBlank())))
  },

  resolveDiscard() {
    const act = get().pendingSwitch
    set({ pendingSwitch: null })
    act?.()
  },

  cancelSwitch() {
    set({ pendingSwitch: null })
  },

  // 新建空白文档：不碰磁盘，直接进编辑态，保存时再问存哪
  newDoc() {
    get().guard(() => set(single(makeBlank())))
  },

  async openFileDialog() {
    // 先弹系统对话框选文件，拿到结果后再走拦截 —— 顺序反了会让用户
    // 先选完文件才发现要处理上一个文档的未保存内容。
    let f
    try {
      f = await fsApi.openFile()
    } catch (e) {
      if (isAbort(e)) return
      // 「打不开但不是程序坏了」不是故障：用中性提示，
      // 红色报错会让人以为程序出错，而用户其实只需要知道下一步该做什么
      if (e instanceof NotOpenableError) {
        set({ notice: { kind: 'info', text: e.message } })
        return
      }
      set({ notice: { kind: 'error', text: `打开文件失败：${errText(e)}` } })
      return
    }
    if (!f) return
    // 与文件树入口同款闸门：系统对话框可能被用户切成「所有文件」，
    // 或者在「文件名」框里手输一个 .pdf。这里再挡一次，
    // 保证「不支持的类型」永远是提示，而不是读盘失败或乱码。
    if (!isSupportedFile(f.name)) {
      set({ notice: { kind: 'info', text: unsupportedMessage(f.name) } })
      return
    }
    get().guard(async () => {
      set(single({ id: `file-${f.path}`, path: f.path, name: f.name, content: f.content, savedContent: f.content, dirty: false }))
      // 桌面端把工作区切到该文件所在目录，侧栏文件树跟着走
      if (isTauri) await fsApi.adoptParentOf(f.path)
    })
  },

  async openFolder() {
    try {
      const p = await fsApi.pickFolder()
      if (!p) return
      set({ rootPath: p, rootName: rootNameOf(p), expanded: { [p]: true }, notice: null })
      await fsApi.persistRoot(p)
      await get().loadDir(p)
    } catch (e) {
      if (isAbort(e)) return // 用户在系统窗口里点了取消，不是错误
      set({ notice: { kind: 'error', text: `打开文件夹失败：${errText(e)}` } })
    }
  },

  async loadDir(path) {
    try {
      const list = await fsApi.listDir(path)
      // 只展示受支持的纯文本类型；目录始终保留，否则无法进入子目录。
      // 白名单外的条目（.class / .png / .jar）**根本不列出来** ——
      // 列出来再给一句「不支持」，不如不让人点。
      const visible = list.filter((n) => n.isDir || isSupportedFile(n.name))
      set((s) => ({ dirs: { ...s.dirs, [path]: visible }, expanded: { ...s.expanded, [path]: true } }))
    } catch (e) {
      const msg = errText(e)
      if (fsApi.hasRestoredHandle() && /user gesture|权限|Permission/i.test(msg)) {
        set({
          notice: {
            kind: 'info',
            text: `读取「${rootNameOf(path)}」需要重新授权`,
            action: 'regrant',
          },
        })
        return
      }
      set({ notice: { kind: 'error', text: `读取目录失败：${msg}` } })
    }
  },

  /**
   * 静默刷新：只更新 dirs[path]，**不碰 expanded**、**列表没变就不 setState**。
   *
   * 最后一条是关键。这个函数会被定时轮询调用（见 App.tsx 的同步 effect），
   * 若无脑写入新数组，React 会周期性重建整棵子树的 DOM ——
   * 而 click 事件要求 mousedown 与 mouseup 落在同一个元素上，
   * DOM 一旦重建，用户按下时还在、松手时已被替换，浏览器就不派发 click。
   * 历史上的「有些行点不进去、要点两三次」正是这么来的（见 FileTree 的模块级注释）。
   *
   * 返回目录是否**已经不存在**（读取失败）。调用方（refreshTree）据此把它的
   * 缓存清掉 —— 目录被外部删掉后，留着 dirs[path] 会让它下次被「重新展开」时
   * 先闪出一份过期的旧列表。
   */
  async refreshDir(path) {
    try {
      const list = await fsApi.listDir(path)
      const visible = list.filter((n) => n.isDir || isSupportedFile(n.name))
      const prev = get().dirs[path]
      if (prev && sameList(prev, visible)) return false
      set((s) => ({ dirs: { ...s.dirs, [path]: visible } }))
      return false
    } catch {
      // 轮询期间的读取失败不打扰用户：目录可能刚被删掉、或正在被移动。
      // 真正由用户手势触发的读取走 loadDir，那里才需要给出提示。
      // 但要**清掉本地缓存**，否则那个已消失的目录会一直挂在 expanded 里，
      // 每次轮询都白读一次、且它下面的旧列表还会留在内存中。
      return true
    }
  },

  async refreshTree() {
    // 只刷新「已展开」的目录 —— 折叠着的内容用户看不见，读了也是白花钱。
    const state = get()
    const paths = Object.keys(state.dirs).filter((p) => state.expanded[p])
    const gone: string[] = []
    await Promise.all(
      paths.map(async (p) => {
        if (await get().refreshDir(p)) gone.push(p)
      })
    )
    if (gone.length === 0) return
    // 目录已消失：连同它的子目录缓存与展开状态一起摘掉。
    // 只删 dirs 不删 expanded 的话，refreshTree 下一轮还会去读一个不存在的目录；
    // 而删 expanded 才能让「重新打开同一个工作区」时回到干净的初始状态。
    set((s) => {
      const dirs = { ...s.dirs }
      const expanded = { ...s.expanded }
      for (const p of gone) {
        // 连带清理以 p 为前缀的子路径缓存（子目录随父目录一起没了）
        const prefix = p.endsWith('\\') || p.endsWith('/') ? p : p + (p.includes('\\') ? '\\' : '/')
        for (const k of Object.keys(dirs)) if (k === p || k.startsWith(prefix)) delete dirs[k]
        for (const k of Object.keys(expanded)) if (k === p || k.startsWith(prefix)) delete expanded[k]
      }
      return { dirs, expanded }
    })
  },

  async createEntry(parentPath, name, isDir) {
    const trimmed = name.trim()
    if (!trimmed) return
    // 只拦路径分隔符与各平台通用的非法字符；其余交给系统报错
    // （不同文件系统的规则不一样，硬编一套规则只会误伤合法名字）。
    if (/[\\/:*?"<>|]/.test(trimmed)) {
      set({ notice: { kind: 'error', text: '名称不能包含 \\ / : * ? " < > | 这些字符' } })
      return
    }
    // 新建文件默认 Markdown：用户没写扩展名就补 .md（需求：默认新增 md）
    const finalName =
      isDir || /\.[^./\\]+$/.test(trimmed) ? trimmed : `${trimmed}.md`
    try {
      const full = isDir
        ? await fsApi.createDir(parentPath, finalName)
        : await fsApi.createFile(parentPath, finalName)
      await get().loadDir(parentPath)
      // 新建完直接打开它 —— 「点了新建就想往里写」是绝大多数人的预期
      if (!isDir) await get().openFile(full, finalName)
    } catch (e) {
      set({ notice: { kind: 'error', text: errText(e) } })
    }
  },

  async deleteEntry(path, isDir, parentPath) {
    const name = rootNameOf(path)
    try {
      await fsApi.remove(path, isDir)
      // 删的正好是当前编辑的文件 → 立刻收走，不要留一个指向不存在文件的标签
      if (get().activeTab()?.path === path) set(single(makeBlank()))
      await get().loadDir(parentPath)
      // 删除成功不再弹提示：文件树里图标消失本身就是最直接的反馈，
      // 顶部横幅只会造成干扰。失败仍走下面的 error 分支。
    } catch (e) {
      set({ notice: { kind: 'error', text: `删除「${name}」失败：${errText(e)}` } })
    }
  },

  async revealEntry(path) {
    try {
      const ok = await fsApi.reveal(path)
      if (!ok) {
        set({
          notice: {
            kind: 'info',
            text: '浏览器模式打不开系统的文件管理器，请用桌面版或在资源管理器里手动定位',
          },
        })
      }
    } catch (e) {
      set({ notice: { kind: 'error', text: `打开文件位置失败：${errText(e)}` } })
    }
  },

  toggleExpand(path) {
    const open = !get().expanded[path]
    set((s) => ({ expanded: { ...s.expanded, [path]: open } }))
    if (open) void get().loadDir(path)
  },

  async openFile(path, name) {
    // 点当前正打开的同一文件：什么都不用做，更不该弹未保存提示
    if (get().activeTab()?.path === path) return
    // 类型闸门放在**读盘之前**：白名单外的文件不进入 read_file。
    // 否则 .class / .png 会被当 UTF-8 解，要么报「流中没有有效 UTF-8」这种
    // 让人一头雾水的底层错误，要么在某些环境下解出一屏乱码。
    if (!isSupportedFile(name)) {
      set({ notice: { kind: 'info', text: unsupportedMessage(name) } })
      return
    }
    let content: string
    try {
      content = await fsApi.readFile(path)
    } catch (e) {
      // 兜底：把「这是个目录」翻译成人话。
      // 不加这层时，用户看到的是 `os error 5 拒绝访问`，
      // 既看不出是哪个文件、也不知道该点「展开」而不是「打开」。
      if (isDirectoryError(e)) {
        set({ notice: { kind: 'info', text: `「${name}」是文件夹，请点击左侧箭头展开` } })
        return
      }
      // 打不开但不是程序坏了（编码不是 UTF-8 等）：中性提示即可，
      // 文案本身已经说明了该做什么，不需要再套一层「打开失败：」
      if (e instanceof NotOpenableError) {
        set({ notice: { kind: 'info', text: e.message } })
        return
      }
      // Rust 侧（桌面端）用 Err(String) 返回，拿不到错误类型。
      // 它的编码提示已自带「无法打开…请转存为 UTF-8」，
      // 这里按文案特征识别，避免又被套上「打开失败：」前缀变成红色报错。
      const raw = errText(e)
      if (/转存为 UTF-8|不是 UTF-8/.test(raw)) {
        set({ notice: { kind: 'info', text: raw } })
        return
      }
      set({ notice: { kind: 'error', text: `打开「${name}」失败：${raw}` } })
      return
    }
    get().guard(() => {
      set(single({ id: `file-${path}`, path, name, content, savedContent: content, dirty: false }))
    })
  },

  closeDoc() {
    get().requestClose()
  },

  updateContent(id, content) {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, content, dirty: content !== t.savedContent } : t
      ),
    }))
  },

  activeTab() {
    const s = get()
    return s.tabs.find((t) => t.id === s.active) ?? null
  },

  // 保存：有路径直接写盘；无路径（未命名文档）自动转入另存为
  async save() {
    const t = get().activeTab()
    if (!t) return
    if (!t.path) {
      await get().saveAs()
      return
    }
    if (!t.dirty) return
    try {
      await fsApi.writeFile(t.path, t.content)
      set((s) => ({
        tabs: s.tabs.map((x) =>
          x.id === t.id ? { ...x, savedContent: x.content, dirty: false } : x
        ),
      }))
    } catch (e) {
      set({ notice: { kind: 'error', text: `保存「${t.name}」失败：${errText(e)}` } })
    }
  },

  async saveAs() {
    const t = get().activeTab()
    if (!t) return
    try {
      // 桌面端给绝对路径做建议名，浏览器端用文件名（此时没有真实路径）
      const suggested = t.path ?? t.name
      const p = await fsApi.saveAs(suggested)
      if (!p) return // 用户取消
      const name = rootNameOf(p)
      const id = `file-${p}`
      set((s) => ({
        tabs: s.tabs.map((x) =>
          x.id === t.id
            ? { ...x, id, path: p, name, savedContent: x.content, dirty: false }
            : x
        ),
        active: id,
      }))
    } catch (e) {
      if (isAbort(e)) return
      set({ notice: { kind: 'error', text: `另存为失败：${errText(e)}` } })
    }
  },
}))

function rootNameOf(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}
