/**
 * 斜杠命令（`/`）：输入 `/` 后弹出块级元素插入菜单，
 * 包含一级~六级标题、有序 / 无序列表、表格（默认最多 10×10）、代码块。
 * 选中后把对应 Markdown 片段写进文档，并把光标落到合适位置。
 *
 * ⚠️ 关键实现细节：必须传 `filter: false`，且**不能**同时给 `validFor`。
 *
 * 原因：CodeMirror 拿到结果后会自己做一遍模糊匹配，查询串是
 *   `state.sliceDoc(result.from, result.to)`
 * 也就是 `from` 到光标之间的**文档原文**。为了让选中后把 `/` 一起替换掉，
 * `from` 必须落在 `/` 上，于是查询串恒为 `"/"` 开头；而我们的候选标签
 * （`H1 一级标题`、`UL 无序列表`…）里没有任何一个字符是 `/`，
 * FuzzyMatcher 匹配全部落空 → options 被清空 → 菜单根本不弹。
 *
 * （v0.3.14 踩坑记录：这个 bug 让功能「构建通过但完全不生效」，
 *  因为 `tsc` 和 `vite build` 都发现不了 —— 只有真在浏览器里敲一次 `/`
 *  才会暴露。以后改补全相关代码，务必用浏览器实测。）
 *
 * 解法：关掉库自带的过滤（`filter: false`），改由本文件按已输入内容过滤；
 * 没有 `validFor` 时 CM 会逐键重新调用本源（见 autocomplete dist 中
 * `checkValid()` 无 validFor 即返回 false，随后走 ActiveSource(Pending)），
 * 代价只是一次 O(候选数) 的循环，可忽略。
 */
import { type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'

interface SlashItem {
  label: string
  detail: string
  /** 参与匹配的别名（含中文、拼音首字母），统一小写 */
  keys: string[]
  apply: (view: EditorView, from: number, to: number) => void
}

// 表格默认 3 列 × 3 行（含表头）；单元格最大支持 10 × 10。
const TABLE_COLS = 3
const TABLE_ROWS = 3

/** 生成一张合法的 GFM 表格（列数 / 行数限制在 [1, 10]） */
function buildTable(cols: number, rows: number): string {
  const c = Math.max(1, Math.min(10, cols))
  const r = Math.max(1, Math.min(10, rows))
  const head = '| ' + Array.from({ length: c }, () => ' ').join(' | ') + ' |'
  const delim = '| ' + Array.from({ length: c }, () => '---').join(' | ') + ' |'
  const body = Array.from({ length: r }, () => '| ' + Array.from({ length: c }, () => ' ').join(' | ') + ' |')
  return [head, delim, ...body].join('\n')
}

function insertBlock(view: EditorView, from: number, to: number, text: string, caret: number): void {
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + caret },
    scrollIntoView: true,
  })
}

const CN = ['一', '二', '三', '四', '五', '六']

const ITEMS: SlashItem[] = [
  ...[1, 2, 3, 4, 5, 6].map((lv) => {
    const mark = '#'.repeat(lv) + ' '
    return {
      label: `H${lv} ${CN[lv - 1]}级标题`,
      detail: mark.trimEnd(),
      keys: [`h${lv}`, String(lv), CN[lv - 1], '标题', 'heading', 'bt'],
      apply: (view: EditorView, from: number, to: number) => insertBlock(view, from, to, mark, mark.length),
    }
  }),
  {
    label: 'UL 无序列表',
    detail: '- ',
    keys: ['ul', '无序', '列表', 'bullet', 'list', 'wxlb', '-'],
    apply: (view, from, to) => insertBlock(view, from, to, '- ', 2),
  },
  {
    label: 'OL 有序列表',
    detail: '1. ',
    keys: ['ol', '有序', '列表', 'number', 'yxlb', '1.'],
    apply: (view, from, to) => insertBlock(view, from, to, '1. ', 3),
  },
  {
    label: 'TABLE 表格',
    detail: '表格（最多 10×10）',
    keys: ['table', '表格', 'biaoge', 'bg'],
    apply: (view, from, to) => {
      const t = buildTable(TABLE_COLS, TABLE_ROWS)
      insertBlock(view, from, to, t, t.length)
    },
  },
  {
    label: 'CODE 代码块',
    detail: '```',
    keys: ['code', '代码', '代码块', 'daima', 'dmk', '```'],
    apply: (view, from, to) => insertBlock(view, from, to, '```\n\n```', 4),
  },
]

/**
 * 按已输入内容过滤候选：先「前缀匹配」再「包含匹配」，
 * 两者都与 fenceLang 的 candidates() 保持一致的手感。
 */
function filterItems(q: string): SlashItem[] {
  if (!q) return ITEMS
  const starts: SlashItem[] = []
  const contains: SlashItem[] = []
  for (const it of ITEMS) {
    const keys = [it.label.toLowerCase(), ...it.keys]
    if (keys.some((k) => k.startsWith(q))) starts.push(it)
    else if (keys.some((k) => k.includes(q))) contains.push(it)
  }
  return [...starts, ...contains]
}

/** 空操作：用于「无匹配项」占位行，避免用户回车把已输入的内容删掉 */
function noop(): void {
  /* intentionally empty */
}

/**
 * CodeMirror 补全源。
 *
 * 触发条件：`/` 位于**行首**（允许前导空格）或**空白字符之后**，
 * 且其后只跟了「非空白、非斜杠」的字符。
 *   - 行首：空行输入 `/`，最常用的入口
 *   - 空白后：`正文 /` 也能触发，符合主流编辑器习惯
 *   - `http://` 不会误触发：那两个 `/` 前面分别是 `:` 和 `/`
 */
export function slashCompletion(ctx: CompletionContext): CompletionResult | null {
  const pos = ctx.pos
  const line = ctx.state.doc.lineAt(pos)
  const before = ctx.state.doc.sliceString(line.from, pos)
  const m = /(^|\s)\/([^\s/]*)$/.exec(before)
  if (!m) return null
  const typed = m[2]

  // from 覆盖 `/` 连同其后已输入的内容，选中后整段被替换
  const from = pos - typed.length - 1

  const items = filterItems(typed.toLowerCase())
  const options = items.map((it) => ({
    label: it.label,
    detail: it.detail,
    apply: (view: EditorView, _completion: unknown, f: number, t: number) => it.apply(view, f, t),
  }))

  if (options.length === 0) {
    // 没有匹配项时给一条占位提示，明确告诉用户「没匹配到」而不是静默消失
    return {
      from,
      to: pos,
      options: [{ label: '（无匹配项）', detail: '继续输入，或按 Esc 取消', apply: noop }],
      filter: false,
    }
  }

  return { from, to: pos, options, filter: false }
}
