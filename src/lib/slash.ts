/**
 * 斜杠命令（`/`）：在空行输入 `/` 后弹出块级元素插入菜单，
 * 包含一级~六级标题、有序 / 无序列表、表格（默认最多 10×10）、代码块。
 * 选中后把对应 Markdown 片段写进文档，并把光标落到合适位置。
 */
import { type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'

interface SlashItem {
  label: string
  detail: string
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
      apply: (view: EditorView, from: number, to: number) => insertBlock(view, from, to, mark, mark.length),
    }
  }),
  {
    label: 'UL 无序列表',
    detail: '- ',
    apply: (view, from, to) => insertBlock(view, from, to, '- ', 2),
  },
  {
    label: 'OL 有序列表',
    detail: '1. ',
    apply: (view, from, to) => insertBlock(view, from, to, '1. ', 3),
  },
  {
    label: 'TABLE 表格',
    detail: '表格（最多 10×10）',
    apply: (view, from, to) => {
      const t = buildTable(TABLE_COLS, TABLE_ROWS)
      insertBlock(view, from, to, t, t.length)
    },
  },
  {
    label: 'CODE 代码块',
    detail: '```',
    apply: (view, from, to) => insertBlock(view, from, to, '```\n\n```', 4),
  },
]

/**
 * CodeMirror 补全源：仅当「行首（允许前导空格）紧跟一个 `/`」时返回结果。
 * 这样在正文里随手打到 `/` 会弹出菜单，但 `http://` 这类 URL 不会误触发。
 */
export function slashCompletion(ctx: CompletionContext): CompletionResult | null {
  const pos = ctx.pos
  const line = ctx.state.doc.lineAt(pos)
  const before = ctx.state.doc.sliceString(line.from, pos)
  const m = /^\s*\/(.*)$/.exec(before)
  if (!m) return null
  const typed = m[1]
  const from = pos - typed.length - 1
  const options = ITEMS.map((it) => ({
    label: it.label,
    detail: it.detail,
    apply: (view: EditorView, _completion: unknown, f: number, t: number) => it.apply(view, f, t),
  }))
  return {
    from,
    to: pos,
    options,
    // 允许中英文过滤；CM 会用自身的模糊匹配按 label 收敛候选
    validFor: /[\w\u4e00-\u9fa5]*/,
  }
}
