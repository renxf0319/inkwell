/**
 * 代码围栏语言提示：输入 ``` 之后弹出候选列表。
 *
 * 解决的问题：写代码块时，作者常常只记得「是 Java / Python」却记不住
 * Markdown 围栏要填的标准标识符（`java` / `py` / `sh` / `js`…）。
 * 这里把常用语言列出来，并且**同时提供别名与中文名**，
 * 所以输入 `py`、`python`、`蟒` 都能命中同一条候选。
 */
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'

interface LangSpec {
  /** 围栏里实际填写的标识符 */
  id: string
  /** 界面展示名 */
  label: string
  /** 可匹配的别名（含中文），小写 */
  alias: string[]
}

const LANGS: LangSpec[] = [
  { id: 'java', label: 'Java', alias: ['java', 'jav'] },
  { id: 'python', label: 'Python', alias: ['python', 'py', 'python3', '蟒蛇'] },
  { id: 'javascript', label: 'JavaScript', alias: ['javascript', 'js', 'ecmascript'] },
  { id: 'typescript', label: 'TypeScript', alias: ['typescript', 'ts'] },
  { id: 'jsx', label: 'JSX', alias: ['jsx', 'react'] },
  { id: 'tsx', label: 'TSX', alias: ['tsx'] },
  { id: 'html', label: 'HTML', alias: ['html', 'htm', '网页'] },
  { id: 'css', label: 'CSS', alias: ['css', '样式'] },
  { id: 'scss', label: 'SCSS', alias: ['scss', 'sass'] },
  { id: 'less', label: 'Less', alias: ['less'] },
  { id: 'json', label: 'JSON', alias: ['json'] },
  { id: 'xml', label: 'XML', alias: ['xml'] },
  { id: 'yaml', label: 'YAML / YML', alias: ['yaml', 'yml', '配置'] },
  { id: 'toml', label: 'TOML', alias: ['toml'] },
  { id: 'sql', label: 'SQL', alias: ['sql', '数据库'] },
  { id: 'shell', label: 'Shell / Bash', alias: ['shell', 'sh', 'bash', 'zsh', '终端'] },
  { id: 'powershell', label: 'PowerShell', alias: ['powershell', 'ps', 'ps1'] },
  { id: 'go', label: 'Go', alias: ['go', 'golang'] },
  { id: 'rust', label: 'Rust', alias: ['rust', 'rs'] },
  { id: 'c', label: 'C', alias: ['c'] },
  { id: 'cpp', label: 'C++', alias: ['cpp', 'c++', 'cxx'] },
  { id: 'csharp', label: 'C#', alias: ['csharp', 'c#', 'cs'] },
  { id: 'objectivec', label: 'Objective-C', alias: ['objectivec', 'objc', 'm'] },
  { id: 'php', label: 'PHP', alias: ['php'] },
  { id: 'swift', label: 'Swift', alias: ['swift'] },
  { id: 'kotlin', label: 'Kotlin', alias: ['kotlin', 'kt'] },
  { id: 'dart', label: 'Dart', alias: ['dart', 'flutter'] },
  { id: 'lua', label: 'Lua', alias: ['lua'] },
  { id: 'r', label: 'R', alias: ['r'] },
  { id: 'ruby', label: 'Ruby', alias: ['ruby', 'rb'] },
  { id: 'perl', label: 'Perl', alias: ['perl', 'pl'] },
  { id: 'vim', label: 'Vim Script', alias: ['vim', 'viml', 'vimscript'] },
  { id: 'nginx', label: 'Nginx', alias: ['nginx'] },
  { id: 'apache', label: 'Apache', alias: ['apache'] },
  { id: 'docker', label: 'Dockerfile', alias: ['docker', 'dockerfile'] },
  { id: 'make', label: 'Makefile', alias: ['make', 'makefile'] },
  { id: 'cmake', label: 'CMake', alias: ['cmake'] },
  { id: 'diff', label: 'Diff', alias: ['diff', 'patch'] },
  { id: 'ini', label: 'INI', alias: ['ini', 'conf', '配置'] },
  { id: 'properties', label: 'Properties', alias: ['properties', 'props', 'property'] },
  { id: 'text', label: '纯文本', alias: ['text', 'txt', 'plain', '文本'] },
]

/**
 * 触发条件：光标前紧邻着刚敲出的三个反引号，且该行还没有出现第四个反引号。
 * 这样在正文里随手打到 ``` 就会提示，但已经写完 ```java 再补文字不会重复弹。
 */
function fenceContext(state: {
  doc: { sliceString(from: number, to: number): string; lineAt(pos: number): { from: number; to: number } }
  selection: { main: { from: number } }
}): { from: number; typed: string } | null {
  const pos = state.selection.main.from
  const line = state.doc.lineAt(pos)
  const before = state.doc.sliceString(line.from, pos)
  // 光标前必须是 ``` 开头的一小段（只允许语言标识符字符）
  // \u4e00-\u9fa5：中文别名（`蟒蛇` / `样式` / `数据库`）也要能触发。
  // 早年只放了 ASCII，导致 LANGS 里那批中文别名是死数据 —— 一个都输不进去。
  const m = /^(`{3,4})([a-zA-Z0-9+#_\-\u4e00-\u9fa5]*)$/.exec(before)
  if (!m) return null
  // 整行里反引号数量超过已敲的，说明 ``` 后面还有别的内容（如紧跟的行内代码），不提示
  const whole = state.doc.sliceString(line.from, line.to)
  const ticks = (whole.match(/`/g) || []).length
  if (ticks > m[1].length) return null
  return { from: pos - m[2].length, typed: m[2] }
}

/**
 * 候选过滤：按已输入的前缀做「前缀匹配 + 包含匹配」。
 * 包含匹配是为了让用户输入 `java` 也能看到 `javascript`（同一前缀族）。
 */
function candidates(typed: string) {
  const q = typed.toLowerCase()
  if (!q) return LANGS
  const starts: LangSpec[] = []
  const contains: LangSpec[] = []
  for (const l of LANGS) {
    const keys = [l.id, l.label.toLowerCase(), ...l.alias]
    if (keys.some((k) => k.startsWith(q))) starts.push(l)
    else if (keys.some((k) => k.includes(q))) contains.push(l)
  }
  return [...starts, ...contains]
}

/** CodeMirror 的 CompletionSource：只在围栏行返回结果 */
export function fenceLangCompletion(ctx: CompletionContext): CompletionResult | null {
  const hit = fenceContext(ctx.state)
  if (!hit) return null
  // ⚠️ 空查询和「已经是完整标识符」都不弹候选 —— 这不是优化，是防往围栏行里塞东西：
  // 候选框默认选中第一项，而回车在补全激活时执行的是「采纳选中项」而不是换行。
  // 于是「``` + 回车」会变成「```text」，接着敲的代码全粘到围栏行上，
  // 整行变成一个巨大的 info string（实测 ` ```js ` + 回车会变成 ` ```jsx `，
  // 再输入的 `var a = 1` 直接拼进语言标识里，代码块变成空的）。
  // 语言名一旦写完整就没什么可补的，此时收起候选框，回车才会正常换行。
  const q = hit.typed.toLowerCase()
  if (!q) return null
  if (LANGS.some((l) => [l.id, l.label.toLowerCase(), ...l.alias].some((k) => k === q))) return null
  const options = candidates(hit.typed).map((l) => ({
    label: l.id === l.label.toLowerCase() ? l.label : `${l.label}`,
    // 补全后写入围栏的是 id（标准标识符），展示用 label
    apply: l.id,
    detail: l.id === l.label.toLowerCase() ? undefined : l.id,
    boost: l.alias.some((a) => a === q) ? 99 : 0,
  }))
  if (options.length === 0) {
    // 没有匹配项时给一条提示，明确告诉用户「没匹配到」而不是静默消失
    return { from: hit.from, to: ctx.pos, options: [{ label: '（无匹配语言）', apply: '' }] }
  }
  // 不设 validFor：它会让 CM 缓存住上一次的结果，之后只在本地按标签做模糊过滤
  // —— 上面那条「写完整就收起」的判定就再也跑不到了（实测 ` ```j ` 之后补一个 `s`，
  // 候选依旧是上一次的列表，回车照样被 `JSX` 截走）。
  // 代价是每敲一个键重跑一次本源（一次正则 + 一次 ~50 条的循环），可忽略。
  return { from: hit.from, to: ctx.pos, options }
}

/** 供文档/帮助界面展示的可选语言清单 */
export const SUPPORTED_LANGS = LANGS.map((l) => ({ id: l.id, label: l.label }))