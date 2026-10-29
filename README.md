# Kore

> 极速 · 本地 · 开源的 Markdown 编辑器。**不做云同步**，文件只留在你的电脑上。

Kore 的目标是成为最好用的本地 Markdown 写作工具：启动快、输入零卡顿、界面克制。
技术栈刻意选得「新而稳」——Tauri 2（Rust 内核）+ React 18 + TypeScript + Vite，
编辑区用 CodeMirror 的装饰能力做成所见即所得的风格：**不换掉 Markdown 源码，只把语法标记藏起来**。

---

## 下载安装包

不想自己编译？直接下载对应平台的开箱即用安装包：

👉 **[下载最新版本](https://github.com/renxf0319/kore/releases/latest)**

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| **Windows** | `Kore_*_x64-setup.exe` / `Kore_*_x64_en-US.msi` | `.exe` 双击安装，或 `.msi` 用于企业部署 |
| **macOS** | `Kore_*_aarch64.dmg` | Apple Silicon（M 系列）；打开后拖入「应用程序」 |
| **Linux** | `Kore_*_amd64.AppImage` / `.deb` / `.rpm` | AppImage 免安装直接运行；`.deb`/`.rpm` 供 Debian/RedHat 系包管理 |

> 安装包体积仅 2~3MB（AppImage 因内嵌运行时略大），这正是 Tauri 相对 Electron 的优势所在。
> 首次打开 macOS 版本若提示「未验证开发者」，右键 → 打开，或到「隐私与安全性」允许即可（未做代码签名）。

---

## 特性

- **所见即所得风格**：不分屏，左边写出来的**就是最终排版**。标题、加粗、列表、
  引用、代码块、任务复选框、图片、**表格**全部按渲染后的样式显示，但底层仍是纯 Markdown 源码。
  把光标放到任意一行，那一行会临时显示原始语法（`#`、`**`、`- `），随时可改。
  表格更进一步：整块渲染成真表格后**直接在单元格里写**（不回落成源码），
  鼠标移到某一行/列时右侧、列边会冒出 `+`，**想插在哪就插在哪**（按住 `Shift` 插到上方/左侧）；
  右上角 `⋯` 里可设置对齐、删除行列或整表。改完自动落盘，且**只重写真正改动的那一行**，
  原有的 `**粗体**`、`` `代码` ``、行内链接与手写紧凑格式都原样保留。
- **代码块不挡手**：敲下 `` ``` `` 的瞬间，那一行会留在原地（不会整行消失），语言名边打边看得见；
  语言候选框不会抢走回车；即使 ` ``` ` 开在表格上方，表格也不会被吞成一片管道符。
- **不用先选工作区也能写**：直接「新建文档」或「打开」单个文件就能编辑，
  保存时再选择存到哪个路径。文件夹是可选的。
- **只打开能正确显示的纯文本**：文件树默认**只列出受支持的类型**——
  `.md` / `.markdown` / `.txt` / `.sql` / `.conf` / `.properties` / `.yaml` / `.json` 等。
  遇到 `.class`、`.png` 这类不支持的类型，会直接提示「暂不支持打开 xxx」并说明支持哪些类型，
  **不会报错、也不会显示乱码**。
  非 Markdown 文件自动切到**纯文本模式**（等宽字体、不套 Markdown 装饰），
  所以 `.sql` 里的 `--` 注释、`.yaml` 里的 `#` 注释都原样保留，不会被当成标题或强调标记吃掉。
  Markdown 文件仍是所见即所得，两种模式在状态栏有类型标签区分。
- **一级菜单**：`文件`（新建窗口 / 新建文档 / 打开 / 打开文件夹 / 保存 / 另存为 / 导出 PDF、HTML）
  与 `主题`（白色 / 黑色）。`Esc` 或点击菜单外收起。
- **左侧栏可切换、可折叠**：`文件`（目录树）/ `大纲`（点击标题跳转）两个等宽页签，
  用底部栏左下角的按钮折叠，编辑区占满整个窗口。未打开工作区时左侧栏只有一个「打开文件夹」按钮。
- **打开即用**：启动直接进入一个空的未命名文档，光标已在编辑区等你输入。「打开文件」是主动选择，不是进入编辑器的前提。
- **底部栏**：只剩左下角的左侧栏显隐按钮。单文档模式下不再显示文档名/标签 ——
  当前打开的文件在**左侧文件树高亮**（左侧竖条 + 加粗 + 强调色），保存状态看状态栏。
- **单文档模式**：不做多标签。点其他文件直接覆盖当前文档；**若上一个文档有未保存修改，
  会弹「保存 / 放弃 / 取消」**，选「保存」会先落盘再切换（另存为取消则中止切换，不会丢内容）。
- **所见即所得的边界**：光标停在某一行时，那一行会显示原始语法（`#`、`**`、`- `）方便编辑；
  光标离开编辑器或刚打开文档时，所有行都保持渲染后的样子。
- **双运行模式**：
  - 桌面端（Tauri）：Rust 直接读写磁盘，体积小、启动快、权限安全。
  - 浏览器端：用 File System Access API 直接读写本地文件，无需安装即可体验。
- **主题 / 暗色模式**：菜单里一键切换，自动跟随系统偏好，选择被持久化。
- **应用内更新**：发现新版本时顶部出现提示条，点「立即更新」即走「下载 → 校验签名 → 安装 → 自动重启」，
  不用自己去 Release 页面找包。
- **导出**：导出独立 HTML（内嵌样式），或导出 PDF（系统打印「另存为 PDF」）。
- **状态栏**：字数 / 字符 / 行数 / 保存状态 / 运行形态实时显示。
- **快捷键**：`Ctrl/Cmd + S` 保存，`+ Shift + S` 另存为，`+ N` 新建，`+ F` 搜索，等等（CodeMirror 全套）。

---

## 技术栈

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 运行时 | **Tauri 2**（Rust） | 几 MB 安装包、低内存、系统 WebView、本地文件权限模型安全 |
| UI | **React 18 + TypeScript + Vite** | 生态最丰富、类型安全、HMR 极快 |
| 编辑器 | **CodeMirror 6** | 比 Monaco 轻得多，扩展性强，支持搜索 / 多光标 / 缩进 |
| 所见即所得 | **CodeMirror Decoration**（自研 `lib/wysiwyg.ts`） | 隐藏语法标记 + 挂语义样式，文档始终是纯 Markdown，不需要富文本序列化 |
| 渲染（导出/打印用） | **markdown-it**（Web Worker） | 解析放到 Worker，大文档也不卡主线程 |
| 高亮 | **highlight.js** | 覆盖语言广、速度快 |
| 净化 | **DOMPurify** | 渲染前消毒，杜绝注入 |
| 状态 | **Zustand** | 极简、无样板 |
| 图标 | **lucide-react** | 清爽一致的图标 |

---

## 环境要求

- **Node.js 18+**（推荐 20 / 22 LTS）。Vite 5 从 v5 起就不再支持 Node 16 及更早版本。
  本项目用 [fnm](https://github.com/Schniz/fnm) 固定版本，见 `.node-version`（当前 `22.23.3`）。
  执行 `scripts\dev.cmd` 会自动切到该版本启动，**完全不影响系统里其他项目使用的 Node**。
- 只有需要**桌面端（Tauri）**时才需要 Rust 工具链，见下文。

> ⚠️ 若你在 Node 16 下直接跑 `npm run dev`，会看到
> `TypeError: crypto$2.getRandomValues is not a function` —— 这是 Node 版本太旧，不是代码问题。
> 项目已内置前置检查（`scripts/check-node.mjs`），会直接给出明确提示而不是让人去猜。

---

## 快速开始

### 浏览器模式（无需安装，立即体验）

```cmd
npm install
npm run dev        REM 启动 Vite 开发服务器
REM 打开 http://localhost:5173 → 点击「打开文件夹」选择任意本地目录
```

> **最省事的启动方式**：在仓库根目录的终端里直接运行 `npm run dev` 即可。
> 需要 `.cmd` 包装脚本时（例如想在文件管理器里双击启动），可改用仓库根目录下的 `dev.cmd`。

> 浏览器模式使用 File System Access API，推荐 Chrome / Edge 等支持的浏览器。
> 选择文件夹后授予读写权限即可像本地应用一样编辑；刷新后通过 IndexedDB 自动恢复。


---

## 项目结构

```
kore/
├─ src/                  # React 前端
│  ├─ assets/            # logo-mark / logo-wordmark（明暗两套，由 gen_logo.py 生成）
│  ├─ components/        # MenuBar / Sidebar / FileTree / DocBar / Editor / ConfirmSwitch / Banner / StatusBar / Welcome
│  ├─ lib/               # wysiwyg(所见即所得装饰引擎) / fs(双模桥) / filetype(受支持类型白名单) / markdown / outline / export / theme / slug / logo
│  ├─ workers/           # markdown.worker.ts（Worker 中解析 Markdown）
│  ├─ state/             # Zustand store
│  └─ styles/            # tokens.css(主题变量) / global.css
├─ src-tauri/            # Rust 后端（Tauri 2）
│  ├─ src/commands.rs    # read_dir / read_file / write_file
│  ├─ icons/             # 应用图标全套（由 gen_logo.py 生成）
│  ├─ tauri.conf.json
│  └─ capabilities/      # 权限声明
├─ .node-version         # 固定本项目的 Node 版本（fnm / asdf / volta 均识别）
├─ dev.cmd               # 根目录一键启动（双击即可，自动切 Node + 切工作目录）
├─ scripts/dev.cmd       # 一键启动浏览器模式开发（自动切换 Node 版本）
├─ scripts/dev-desktop.cmd   # 一键启动 Tauri 桌面端开发
├─ scripts/dev-desktop.ps1   # 同上（PowerShell 版，注入 Rust 工具链环境变量）
├─ scripts/check-node.mjs    # Node 版本前置检查（版本过低时给出明确提示）
├─ scripts/gen_logo.py   # 从品牌源图生成 logo 资源 + 应用图标（需 Pillow、numpy）
├─ scripts/install-rust.ps1  # 交互式选择盘符安装 Rust 工具链（不写 C 盘）
├─ scripts/push-to-github.ps1  # 一键建仓并推送到 GitHub（在本机联网环境运行）
└─ package.json
```

> **换 logo**：`python scripts/gen_logo.py <新源图>` 会一次性刷新
> `src/assets/logo-{mark,wordmark}-{light,dark}.png` 与 `src-tauri/icons/` 应用图标全套。
> 命令行参数里的量测常量（`BOX_WORDMARK` / `BOX_MARK`）对应源图的裁切范围，换图时需按新图调整。

欢迎提 Issue / PR，一起把它做的更好。

## 许可

[MIT](./LICENSE) © Kore Contributors
