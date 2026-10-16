import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'

// ---------------------------------------------------------------------------
// Typora 风格「所见即所得」装饰引擎
//
// 思路：不把文档换成富文本 DOM（那是 ProseMirror/TipTap 的路子），而是让 CodeMirror
// 继续编辑**纯 Markdown 源码**，只做两件事：
//   1. 用 Decoration.replace 把「语法标记」藏起来
//   2. 用 Decoration.mark / Decoration.line 把语义样式挂上去
// 于是：
//   - 文档始终是合法 Markdown，导出、复制、另存为零成本
//   - 光标落在哪一行，哪一行就临时显示原始标记（Typora 的行为）
//   - 不需要维护「富文本 ↔ Markdown」双向序列化，规避了一整类数据不一致 bug
//
// 两个必须遵守的实现约束（都是踩过的坑）：
//   A. 装饰必须按 from 升序加入，且同 from 时按 startSide 排序 —— 乱序会直接抛
//      "Ranges must be added sorted"。因此这里统一收集到数组，最后交给
//      Decoration.set(..., true) 排序，而不是手工维护 RangeSetBuilder。
//   B. 行内规则可能互相嵌套命中（如 `**粗**` 里的 `*` 也会命中斜体规则）。
//      所以用 claimed 记录已占用区间，重叠的命中直接跳过。
// ---------------------------------------------------------------------------

/** 一个待添加的装饰 */
interface Pending {
  from: number
  to: number
  deco: Decoration
}

interface Ctx {
  /** 光标所在行（1 起），-1 表示无焦点。**仅**用于表格的跨行块级判断 */
  cursorLine: number
  /** 光标绝对位置：决定「这一处标记是否露出来」的**唯一**依据；-1 表示无焦点 */
  cursorPos: number
  out: Pending[]
  /** 本行已被占用的区间（左闭右开），用于跳过重叠命中 */
  claimed: [number, number][]
  /**
   * 本次扫描收集到的**全部**标记区间（不管有没有真的被隐藏）。
   * 供上层回答「光标命中的是哪个标记」，用来避免每次移动光标都全文重扫。
   */
  marks: [number, number][]
  /** 代码围栏内部：不做内联解析 */
  inFence: boolean
  fenceMarker: string
}

function overlaps(claimed: [number, number][], from: number, to: number): boolean {
  for (const [a, b] of claimed) {
    if (from < b && to > a) return true
  }
  return false
}

function add(ctx: Ctx, from: number, to: number, deco: Decoration): void {
  if (to <= from) return
  ctx.out.push({ from, to, deco })
  ctx.claimed.push([from, to])
}

/** 行级装饰：范围是零宽的，挂在行首 */
function addLine(ctx: Ctx, lineFrom: number, cls: string): void {
  ctx.out.push({ from: lineFrom, to: lineFrom, deco: Decoration.line({ class: cls }) })
}

/**
 * **块级前缀一律隐藏**，光标进去也不露。
 *
 * 覆盖：`# ` / `> ` / `- ` / ` ``` ` / `---` / 表格分隔行。
 * 之所以比行内标记更绝，是因为用户对标题的诉求明确是
 * 「鼠标点选时不要暴露 md 语言符号」—— 只要还留着「光标碰到就露」这条路，
 * 鼠标点偏一点、方向键多按一下，符号就会突然冒出来打断阅读。
 * 想改标题级别有明确的替代路径：光标停在标题第一个字前面按回车
 * （`# 标题` → `# ` + `标题`，标题效果就没有了），再自己敲新的级别。
 *
 * 代价：光标能停在被隐藏的区间里（CM 的 replace 装饰默认不是原子的），
 * 但那里什么都不显示 —— 这与 Typora 一致。
 */
function hide(ctx: Ctx, from: number, to: number): void {
  if (to <= from) return
  ctx.out.push({ from, to, deco: Decoration.replace({}) })
  ctx.claimed.push([from, to])
}

/**
 * **行内标记**：默认隐藏，光标真的落在这段标记里才露出来。
 *
 * 与块级前缀的区别在于「鼠标点一下会不会破功」：
 * 行内标记（`**` / 反引号 / `[](url)`）周围全是正文，标记本身只有几个字符，
 * 露出它不影响对整行的理解；而标题的 `#` 露出来会让整个标题突然「变形」，
 * 视觉冲击大得多。所以行内保留「走进标记就显形」的逃生门，
 * 用户改链接地址、改强调范围时还能看见原文。
 *
 * 每次都把区间登记进 ctx.marks —— 上层靠它做「光标命中的是哪个标记」的
 * 二分查找（见 findMark），从而在选区变化时短路掉绝大多数全文重扫。
 * 登记的区间保证**两两不相交**（命中已claimed 的会被跳过，
 * 且配对规则的 head/tail 必然落在同一段互不重叠的命中内），
 * 这是二分查找能给出确定答案的前提。
 */
function hideInline(ctx: Ctx, from: number, to: number): void {
  if (to <= from) return
  ctx.marks.push([from, to])
  // ⚠️ 无论显不显示都要占位：漏了会让后面的规则在同一起点重复命中，
  // 而 marks 里就会出现**重叠区间**，二分查找 findMark 的答案不再唯一
  // → 光标移动时的短路判断会误判，标记该显不显 / 不该显却显。
  // 这两个子区间本来就落在本命中已claimed 的 [from,to] 里，重复登记无副作用。
  ctx.claimed.push([from, to])
  if (inMark(ctx, from, to)) return
  ctx.out.push({ from, to, deco: Decoration.replace({}) })
}

/**
 * 「光标是否正落在这一段标记内部」—— 决定标记显隐的**唯一**判据。
 *
 * 为什么从「光标在本行」改成「光标在本段」：
 * 早期逻辑是「光标所在行不隐藏任何标记」，于是鼠标点一下标题，`#` 立刻冒出来。
 * 点击是阅读时最高频的动作，等于「一点就破功」，观感被破坏。
 * 改成位置粒度后：
 *   - 点标题**正文** → 光标在 `# ` 之后、不在标记区间里 → `#` 保持隐藏 ✅
 *   - 光标被移进标记区间（Home / 左右方向键走过 `**` 中间）→ 才露出标记，可继续编辑
 * 这样「阅读」与「编辑」的切换由光标是否真的落在标记上决定，
 * 而不是「点在哪个字上」—— 后者完全不可预测。
 *
 * 判据用 `>= from && < to` 的左闭右开：**光标紧贴标记之后**（正好等于 to）
 * 算在标记之外，这样点标题正文第一个字时不会因为「刚好贴在 `> ` 后面」而误露。
 *
 * ⚠️ 无焦点时 ctx.cursorPos = -1，于是所有标记一律隐藏。
 * 这与老实现里activeLine 返回 -1 的效果一致：焦点在文件树/菜单上时，
 * 用户看不到光标，不该给他看原始语法。
 */
function inMark(ctx: Ctx, from: number, to: number): boolean {
  return ctx.cursorPos >= from && ctx.cursorPos < to
}

/**
 * 一条命中里「真正要显示给用户看」的部分有多长（不含首尾标记）。
 * 目前只有 tail = -1 的链接规则用到：可见内容就是 m[1]（链接文字）。
 * 规则若没有 group(1），退化为整段（不额外隐藏）。
 */
function visibleLen(m: RegExpExecArray): number {
  const g = m[1]
  return g === undefined ? m[0].length : g.length
}

// --- 块级语法 -----------------------------------------------------------
/**
 * ATX 标题：`#` 之后**必须有空白**才算标题。
 *
 * ⚠️ 这里刻意**不**提供 `|$` 分支（`/^(#{1,6})(\s+|$)(.*)$/`）。CommonMark 允许
 * 「一行只有 `#`」成为一个空标题，但那是「文档已定稿」时的解析规则；
 * 用在**逐键输入**的编辑器里就成了灾难：
 *   - 只敲一个 `#` 的瞬间，这一行立刻变成 h1，而前缀 `#` 被 hide() 整段藏掉
 *   - 于是屏幕上**什么都没有**（行变高了、字没了），用户以为自己把内容删掉了
 *   - 想写 `#标签` 或 `#include` 这类以井号开头的内容时，也会一路撞上这个「空标题」
 * Typora 的判据就是「# + 空格」：只敲 `#` 时它原样显示，空格落下才变标题。
 * 需求即原话：「输入 # 后显示 #，空格之后再显示成标题样式」。
 *
 * 注意 `\s+` 里含 `\t`：`#\t标题` 同样是合法标题，不能只认半角空格。
 */
const HEADING_RE = /^(#{1,6})(\s+)(.*)$/
const UL_RE = /^(\s*)([-*+])(\s+)(.*)$/
const OL_RE = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/
const QUOTE_RE = /^(\s*(?:>\s?)+)(.*)$/
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)\s*$/
const TASK_RE = /^(\s*)([-*+])(\s+)(\[[ xX]\])(\s*)(.*)$/

/**
 * 行内规则。
 * head/tail = 成对标记的首尾字符数，0 表示该侧不隐藏（图片整段替换）。
 *
 * tail = -1 是哨兵，表示「**藏掉尾部直到可见内容结束**」——
 * 目前只有链接用它：`[文字](url)` 只留 `文字`，`](url)` 整段消失。
 *
 * 优先级即数组顺序：先命中的规则占用区间，后面的规则不能再吃到同一段文本。
 *
 * dom 是**同一批规则的第二个消费者**：表格单元格要生成真实 DOM 节点（<code>/<a>），
 * 而装饰引擎只需要 class。两边共用一份正则与优先级，避免两套规则各自漂移。
 */
interface InlineRule {
  re: RegExp
  cls: string
  head: number
  tail: number
  image?: boolean
  /**
   * 可见内容是否就是 group(1) 本身。
   * 为 true 时 renderInlineDOM 会跳过递归（链接的 group(1) 已被 dom() 塞进 <a>）。
   * 用显式字段而不是比对 cls 字符串 —— 后者会在改类名时静默失效。
   */
  selfContained?: boolean
  dom?: (m: RegExpExecArray) => Node
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  return e
}

const INLINE_RULES: InlineRule[] = [
  // 行内代码最先：避免 `**x**` 里的星号被当成强调
  { re: /`([^`\n]+)`/g, cls: 'cm-md-code', head: 1, tail: 1, selfContained: true,
    dom: (m) => { const c = el('code', 'cm-md-code'); c.textContent = m[1]; return c } },
  { re: /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, cls: '', head: 0, tail: 0, image: true, selfContained: true,
    dom: (m) => { const i = el('img', 'cm-md-img'); i.src = m[2]; i.alt = m[1] ?? ''; return i } },
  // 链接：head 藏 `[`，tail 藏**整段 `](url)`**（含右方括号、圆括号、URL 本体）。
  //
  // ⚠️ 这里必须整段藏，不能只藏 `]`。曾经写成 tail:0 只藏 `[`，后果是
  // `](https://a.b)` 原样留在渲染文本里 —— 实测点击那一段时，
  // CodeMirror 的 posAtCoords 因为该区间已被 mark 装饰 claim、却没有对应的
  // replace 装饰而**无法映射**，光标死死卡在链接文字末尾不动：
  // 点 `]`、点 `(`、点 URL 的任意位置，光标 offset 全都等于链接文字结束处。
  // 表现为「链接后面那一段鼠标点不进去」。tail 用哨兵 -1 表示「藏到 from+1 之前的所有内容」。
  { re: /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, cls: 'cm-md-link', head: 1, tail: -1,
    dom: (m) => { const a = el('a', 'cm-md-link'); a.href = m[2]; a.textContent = m[1]; return a } },
  { re: /\*\*\*([^*]+)\*\*\*/g, cls: 'cm-md-strong cm-md-em', head: 3, tail: 3,
    dom: (m) => { const s = el('strong', 'cm-md-strong'); const e2 = el('em'); e2.textContent = m[1]; s.appendChild(e2); return s } },
  { re: /\*\*([^*]+)\*\*/g, cls: 'cm-md-strong', head: 2, tail: 2,
    dom: (m) => { const s = el('strong', 'cm-md-strong'); s.textContent = m[1]; return s } },
  { re: /__([^_]+)__/g, cls: 'cm-md-strong', head: 2, tail: 2,
    dom: (m) => { const s = el('strong', 'cm-md-strong'); s.textContent = m[1]; return s } },
  { re: /~~([^~]+)~~/g, cls: 'cm-md-del', head: 2, tail: 2,
    dom: (m) => { const s = el('del', 'cm-md-del'); s.textContent = m[1]; return s } },
  { re: /==([^=]+)==/g, cls: 'cm-md-mark', head: 2, tail: 2,
    dom: (m) => { const s = el('mark', 'cm-md-mark'); s.textContent = m[1]; return s } },
  { re: /(?<![*\w])\*([^*\n]+)\*(?!\*)/g, cls: 'cm-md-em', head: 1, tail: 1,
    dom: (m) => { const s = el('em', 'cm-md-em'); s.textContent = m[1]; return s } },
  { re: /(?<![_\w])_([^_\n]+)_(?![_\w])/g, cls: 'cm-md-em', head: 1, tail: 1,
    dom: (m) => { const s = el('em', 'cm-md-em'); s.textContent = m[1]; return s } },
]

/**
 * 解析一行。
 * ctx.inFence / ctx.fenceMarker 表示**进入这一行之前**的围栏状态；
 * 围栏的开/关状态转移只在本函数内发生，调用方不需要再同步一遍。
 */
function processLine(
  state: EditorState,
  ctx: Ctx,
  lineText: string,
  lineFrom: number
): void {
  // --- 代码围栏：整块不做内联解析 ---
  const fence = FENCE_RE.exec(lineText)
  if (fence) {
    const marker = fence[1]
    const lang = fence[2] || ''
    if (ctx.inFence && marker[0] === ctx.fenceMarker[0]) {
      ctx.inFence = false
      ctx.fenceMarker = ''
    } else {
      ctx.inFence = true
      ctx.fenceMarker = marker
      if (lang) {
        // 围栏行右端挂语言标签
        ctx.out.push({
          from: lineFrom + lineText.length,
          to: lineFrom + lineText.length,
          deco: Decoration.widget({ widget: new FenceLabel(lang), side: 1 }),
        })
      }
    }
    addLine(ctx, lineFrom, 'cm-md-fence')
    hide(ctx, lineFrom, lineFrom + lineText.length)
    return
  }

  if (ctx.inFence) {
    addLine(ctx, lineFrom, 'cm-md-codeblock')
    return
  }

  // --- 分割线 ---
  if (HR_RE.test(lineText)) {
    addLine(ctx, lineFrom, 'cm-md-hr')
    hide(ctx, lineFrom, lineFrom + lineText.length)
    return
  }

  // --- 标题 ---
  const h = HEADING_RE.exec(lineText)
  if (h) {
    addLine(ctx, lineFrom, `cm-md-h${h[1].length}`)
    const markEnd = lineFrom + h[1].length + h[2].length
    hide(ctx, lineFrom, markEnd)
    processInline(ctx, markEnd, h[3])
    return
  }

  // --- 引用 ---
  const q = QUOTE_RE.exec(lineText)
  if (q) {
    addLine(ctx, lineFrom, 'cm-md-quote')
    const bodyFrom = lineFrom + q[1].length
    hide(ctx, lineFrom, bodyFrom)
    processInline(ctx, bodyFrom, q[2])
    return
  }

  // --- 任务列表（必须早于无序列表判断）---
  const task = TASK_RE.exec(lineText)
  if (task) {
    addLine(ctx, lineFrom, 'cm-md-li cm-md-task')
    const boxFrom = lineFrom + task[1].length + task[2].length + task[3].length
    const boxTo = boxFrom + task[4].length
    hide(ctx, lineFrom, boxFrom)
    // 复选框：点击直接改文档里的 [ ] / [x]，长度相同所以光标不会跳
    const checked = task[4][1] === 'x' || task[4][1] === 'X'
    add(ctx, boxFrom, boxTo, Decoration.replace({ widget: new CheckboxWidget(checked, boxFrom, boxTo) }))
    const bodyFrom = boxTo + task[5].length
    processInline(ctx, bodyFrom, task[6])
    return
  }

  // --- 无序列表：圆点用 CSS ::before 画，只隐藏 -/*/+ 本身 ---
  const ul = UL_RE.exec(lineText)
  if (ul) {
    addLine(ctx, lineFrom, 'cm-md-li')
    const bodyFrom = lineFrom + ul[1].length + ul[2].length + ul[3].length
    hide(ctx, lineFrom, bodyFrom)
    processInline(ctx, bodyFrom, ul[4])
    return
  }

  // --- 有序列表：数字和「.」都保留（Typora 就是显示 "1. xxx"）---
  const ol = OL_RE.exec(lineText)
  if (ol) {
    addLine(ctx, lineFrom, 'cm-md-li cm-md-ol')
    const numFrom = lineFrom + ol[1].length
    const bodyFrom = numFrom + ol[2].length + ol[3].length + ol[4].length
    // 只隐藏数字前的缩进，序号本身留着，用户能直接确认是第几项
    hide(ctx, lineFrom, numFrom)
    processInline(ctx, bodyFrom, ol[5])
    return
  }

  // --- 普通段落 ---
  addLine(ctx, lineFrom, 'cm-md-p')
  processInline(ctx, lineFrom, lineText)
  void state
}

/** 解析行内标记 */
function processInline(ctx: Ctx, offset: number, text: string): void {
  if (!text) return
  for (const rule of INLINE_RULES) {
    rule.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        rule.re.lastIndex++
        continue
      }
      const from = offset + m.index
      const to = from + m[0].length

      // 已被前面的规则占用（嵌套命中）就跳过，避免装饰区间重叠
      if (overlaps(ctx.claimed, from, to)) continue

      if (rule.image) {
        const src = m[2]
        if (!src) continue
        // 图片是整段替换：光标落进来时露出原始语法（方便改链接），否则渲染成 <img>
        // 登记进 marks：光标进出图片会改变结果，短路判断必须知道这件事
        ctx.marks.push([from, to])
        if (!inMark(ctx, from, to)) {
          add(ctx, from, to, Decoration.replace({ widget: new ImageWidget(src, m[1] ?? '', from) }))
        } else {
          add(ctx, from, to, Decoration.mark({ class: 'cm-md-link' }))
        }
        continue
      }

      if (rule.cls) {
        ctx.out.push({ from, to, deco: Decoration.mark({ class: rule.cls }) })
        ctx.claimed.push([from, to])
      }
      // 藏首尾标记，保留可见内容。
      // 判据是「光标是否在**这一小段标记**里」而不是「在不在本行」——
      // 否则点一下 `**粗体**` 里的文字，整行的 `**` 就都冒出来了。
      if (rule.head > 0) hideInline(ctx, from, from + rule.head)
      // tail = -1：可见内容是 m[1]，从它结束处一直藏到整段末尾。
      // 链接的 `](url)` 就靠这条消失 —— 留着它会让那一段点不动。
      if (rule.tail === -1) hideInline(ctx, from + rule.head + visibleLen(m), to)
      else if (rule.tail > 0) hideInline(ctx, to - rule.tail, to)
    }
  }
}

// --- 表格 ----------------------------------------------------------------
//
// 表格是唯一必须**跨行**处理的块级语法：表头行 + 分隔行（`|---|---|`）+ 若干数据行。
// 单行装饰画不出表格，所以整块用 Decoration.replace({block:true}) 换成一个真 <table>。
//
// 光标进入表格时**整块回落成源码**（和光标行的处理逻辑一致）：
// Widget 里的内容不可编辑，要改字必须回到源码。这个取舍是刻意的 —— 换来的是
// 「文档永远只是纯 Markdown」，不需要维护富文本 ↔ 源码的双向序列化。

type Align = 'left' | 'center' | 'right'

interface TableCell {
  text: string
  /** 单元格文本在文档中的绝对位置，点击表格时把光标送到这里 */
  from: number
  to: number
}

interface TableRow {
  cells: TableCell[]
}

interface TableBlock {
  startLine: number
  delimLine: number
  endLine: number
  header: TableRow
  rows: TableRow[]
  aligns: (Align | null)[]
  /** Widget.eq 用：内容变化才重建 DOM */
  sig: string
}

/**
 * 拆一行成单元格。
 *
 * 两个容易踩的坑：
 *  1. `\|` 是转义竖线，不能当分隔符（GFM 允许单元格文本里出现裸竖线）
 *  2. 行首/行尾竖线会产生一个空片段，那是「外框」不是单元格，必须丢掉；
 *     但 `| a |  |` 中间那个空单元格要保留（它是真的第二列）
 */
function parseTableRow(text: string, lineFrom: number): TableRow {
  const cells: TableCell[] = []
  const n = text.length
  let i = 0
  // GFM 允许最多 3 个前导空格（再多就是代码块了）
  while (i < n && (text[i] === ' ' || text[i] === '\t')) i++
  if (text[i] === '|') i++ // 吃掉行首竖线

  let buf = ''
  let bufStart = i
  // 把当前缓冲区落成一个单元格。from 指向去掉左侧空白后的第一个字符，
  // 这样点击定位时光标落在内容上而不是空白处。
  const flush = (): void => {
    const trimmed = buf.trim()
    const lead = buf.length - buf.trimStart().length
    const from = lineFrom + bufStart + lead
    cells.push({ text: trimmed, from, to: from + trimmed.length })
    buf = ''
  }

  for (; i < n; i++) {
    const ch = text[i]
    if (ch === '\\' && text[i + 1] === '|') {
      buf += '|'
      i++
      continue
    }
    if (ch === '|') {
      flush()
      bufStart = i + 1
      continue
    }
    buf += ch
  }
  flush()

  // 行尾竖线产生的空片段
  if (cells.length > 1 && cells[cells.length - 1].text === '' && text[n - 1] === '|') {
    cells.pop()
  }
  return { cells }
}

const DELIM_CELL_RE = /^:?-{1,}:?$/

/** 分隔行：每个单元格都形如 `---` / `:--` / `--:` / `:-:`，且必须含竖线 */
function parseDelimRow(row: TableRow): (Align | null)[] | null {
  if (row.cells.length === 0) return null
  const aligns: (Align | null)[] = []
  for (const c of row.cells) {
    const t = c.text.trim()
    if (!DELIM_CELL_RE.test(t)) return null
    const left = t.startsWith(':')
    const right = t.endsWith(':')
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null)
  }
  return aligns
}

/**
 * 找出一个表格块；不是表格返回 null。
 * startLine 传 1 起的行号，lineAt 传该行的 from。
 */
function parseTableBlock(
  doc: EditorState['doc'],
  startLine: number,
  endLine: number,
  lineFrom: number
): TableBlock | null {
  const headerText = doc.line(startLine).text
  if (!headerText.includes('|')) return null
  if (startLine + 1 > endLine) return null
  const delimText = doc.line(startLine + 1).text
  // 必须含竖线：`foo` + `---` 在 CommonMark 里是 setext 二级标题，不是表格
  if (!delimText.includes('|')) return null

  const header = parseTableRow(headerText, lineFrom)
  const delimLine = startLine + 1
  const delim = parseDelimRow(parseTableRow(delimText, doc.line(delimLine).from))
  if (!delim) return null
  // GFM：表头与分隔行的列数必须相等
  if (delim.length !== header.cells.length) return null

  // 向下收集数据行：空行或不含竖线的行即表格结束
  const rows: TableRow[] = []
  let last = delimLine
  for (let n = delimLine + 1; n <= endLine; n++) {
    const t = doc.line(n).text
    if (!t.trim() || !t.includes('|')) break
    rows.push(parseTableRow(t, doc.line(n).from))
    last = n
  }

  return {
    startLine,
    delimLine,
    endLine: last,
    header,
    rows,
    aligns: delim,
    // sig 只用于 Widget.eq（判断要不要重建 DOM）。用 JSON.stringify 天然带分隔符，
    // 不必自己挑一个「保证不出现在正文里」的分隔字符（踩过 NUL 字节把源码变成二进制的坑）
    sig: JSON.stringify([headerText, delimText, rows.map((r) => r.cells.map((c) => c.text))]),
  }
}

/**
 * 把一段 Markdown 行内文本渲染成 DOM 片段，复用装饰引擎同一批规则与优先级。
 *
 * ⚠️ 嵌套处理：`claimed` 去重是为了防止两条规则吃到同一段文本，但直接用它
 * 会让**外层规则失效**。典型例子（用户报告里真实出现过）：
 *
 *     **无 `${}`**
 *
 * 行内代码规则先跑，吃掉了 `` `${}` `` 这段区间；随后粗体规则匹配到的区间
 * 与它重叠 → 被跳过 → 星号原样显示出来。
 *
 * 正确做法是「命中内层规则后，把它的内容递归渲染成子节点，再交给外层规则包起来」，
 * 于是 `**` 仍能被粗体规则识别，而其中的 `${}` 依旧是 <code>。
 * claimed 只用于「同级不重复命中」，不再阻止父子嵌套。
 */
function renderInlineDOM(text: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  // 只放「同一层」的命中区间：防止两条同级规则重复吃同一段
  const claimed: [number, number][] = []
  const pieces: { from: number; to: number; node: Node }[] = []

  for (const rule of INLINE_RULES) {
    if (!rule.dom) continue
    rule.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        rule.re.lastIndex++
        continue
      }
      const from = m.index
      const to = from + m[0].length
      // 只拦「完全覆盖」的同级重复；部分重叠（嵌套）放行给递归处理
      const covered = claimed.some(([a, b]) => from >= a && to <= b)
      if (covered) continue
      claimed.push([from, to])

      const node = rule.dom(m)
      // selfContained 规则（行内代码 / 图片 / 链接）的可见内容已由 dom() 放进
      // 自己的 textContent，无需也不能再递归 —— 否则会重复或破坏结构。
      // 其余规则（粗体/斜体/高亮等）的 group(1) 才是要递归的子内容，
      // 这样 `**无 `${}`**` 里的 `${}` 依旧能渲染成 <code>。
      if (!rule.selfContained && m[1] !== undefined) {
        const inner = renderInlineDOM(m[1])
        node.textContent = ''
        node.appendChild(inner)
      }
      pieces.push({ from, to, node })
    }
  }

  // ⚠️ 输出顺序必须是「**外层优先**」，不是单纯按 from 排序。
  // 排序后逐段输出时，`**无 `${}`**` 里的 `**`（from 小）会先输出，
  // 接着行内代码片段因 `p.from < pos` 被整段丢掉 —— 粗体里的代码就没了。
  // 正确做法：含嵌套的外层片段自带完整子树（含内层），
  // 因此输出时跳过「被已输出区间完全覆盖」的片段即可。
  pieces.sort((a, b) => a.from - b.from || b.to - a.to)
  let pos = 0
  for (const p of pieces) {
    // 被前面输出的区间完全覆盖 → 内容已在其子树里，跳过
    if (p.from < pos) continue
    frag.appendChild(document.createTextNode(text.slice(pos, p.from)))
    frag.appendChild(p.node)
    pos = p.to
  }
  frag.appendChild(document.createTextNode(text.slice(pos)))
  return frag
}

// --- Widgets -------------------------------------------------------------

class FenceLabel extends WidgetType {
  constructor(readonly lang: string) {
    super()
  }
  eq(other: FenceLabel): boolean {
    return other.lang === this.lang
  }
  toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = 'cm-md-fence-label'
    s.textContent = this.lang
    return s
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number
  ) {
    super()
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.from === this.from
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-md-checkbox'
    box.checked = this.checked
    box.contentEditable = 'false'
    box.setAttribute('aria-label', '任务完成状态')
    // mousedown preventDefault：避免编辑器抢走焦点，否则光标会跳到行首
    box.addEventListener('mousedown', (e) => e.preventDefault())
    box.addEventListener('click', () => {
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' },
        // scrollIntoView 不加：只改 3 个字符，视图不该跳
        userEvent: 'input.complete'
      })
    })
    return box
  }
  // 返回 false：让 click 事件能到达 input 自身
  ignoreEvent(): boolean {
    return false
  }
}

/**
 * 图片。
 *
 * 点击行为与 TableWidget 一致：**把光标送到图片语法的起点**，
 * 于是图片随即回落成原始 `![alt](src)` 源码（cursorPos 落进了 marks 区间），
 * 用户就能改链接。图片单独占一行时若没有这段处理，整行就只有一张图，
 * 任何位置点下去都没有反应 —— 表现为「这一行点不进去」。
 */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    /** 图片语法在文档中的起点，供点击定位 */
    readonly from: number
  ) {
    super()
  }
  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }
  toDOM(view: EditorView): HTMLElement {
    const img = document.createElement('img')
    img.className = 'cm-md-img'
    img.src = this.src
    img.alt = this.alt
    img.draggable = false
    img.title = '点击编辑图片地址'
    // 与 TableWidget 相同的两条约束，顺序也不能错：
    //  1. preventDefault —— 否则 CM 先处理这次点击，把光标放到替换区边界；
    //  2. 先 focus 再 dispatch —— 光标行靠 hasFocus 判断，
    //     先 dispatch 的话编辑器还没聚焦，图片会立刻又渲染回 <img>。
    img.addEventListener('mousedown', (e) => {
      e.preventDefault()
      view.focus()
      view.dispatch({ selection: { anchor: this.from }, userEvent: 'select.pointer' })
    })
    return img
  }
  ignoreEvent(): boolean {
    // 交给上面自己的 mousedown 处理，不走编辑器默认行为
    return true
  }
}

// --- 表格交互所需的工具函数 ----------------------------------------------

interface TableData {
  header: string[]
  rows: string[][]
  aligns: (Align | null)[]
}

/** 单元格文本内容（contenteditable 可能在换行处塞 <br>，原样取即可） */
function cellText(node: Element | null): string {
  if (!node) return ''
  // 单元格内换行要压成单空格：Markdown 的表格行必须是一行，
  // 否则换行会把表格行拆成两行导致渲染出错。
  return (node.textContent ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+$/, '')
}

/**
 * 从单元格 DOM 读回**纯内容**文本。
 *
 * ⚠️ 必须只读 `.cm-md-cell-content` 子层，绝不能读整个单元格的 textContent：
 * 单元格里还挂着行/列「+」按钮（.cm-md-col-add / .cm-md-row-add），
 * 它们的文字恰好就是 "+"。曾经直接读 td.textContent 落盘，
 * 结果每提交一次就往 Markdown 里写进一批 "+"，下次渲染再叠加 ——
 * 单元格被滚雪球式污染成 "++++++++"。这是结构事故，不是样式问题。
 */
function readCellText(cell: Element | null): string {
  return cellText(cell?.querySelector(':scope > .cm-md-cell-content') ?? null)
}

/** 从当前正在渲染的表格 DOM 读回结构化数据（含未落盘的就地编辑） */
function readTableFromDOM(wrap: HTMLElement, aligns: (Align | null)[]): TableData {
  const header = Array.from(wrap.querySelectorAll('thead th')).map((th) => readCellText(th))
  const rows = Array.from(wrap.querySelectorAll('tbody tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td')).map((td) => readCellText(td))
  )
  return { header, rows, aligns }
}

function alignToDelim(a: Align | null): string {
  if (a === 'center') return ':-:'
  if (a === 'right') return '--:'
  if (a === 'left') return ':-'
  return '---'
}

function buildTableLines(d: TableData): string[] {
  const delim = d.aligns.map(alignToDelim).join(' | ')
  const lines = ['| ' + d.header.join(' | ') + ' |', '| ' + delim + ' |']
  for (const r of d.rows) lines.push('| ' + r.join(' | ') + ' |')
  return lines
}

/** 把表格区块整体替换为新内容（多行用 \n 连接） */
function replaceTableBlock(view: EditorView, block: TableBlock, lines: string[]): void {
  const from = view.state.doc.line(block.startLine).from
  const to = view.state.doc.line(block.endLine).to
  view.dispatch({ changes: { from, to, insert: lines.join('\n') } })
}

/** 把就地编辑的结果落盘：仅当 DOM 与源码不一致时才写回，避免无意义重渲染 */
function commitTableIfChanged(view: EditorView, block: TableBlock, wrap: HTMLElement): void {
  const data = readTableFromDOM(wrap, block.aligns)
  const lines = buildTableLines(data)
  const cur: string[] = []
  for (let n = block.startLine; n <= block.endLine; n++) cur.push(view.state.doc.line(n).text)
  if (lines.join('\n') === cur.join('\n')) return
  replaceTableBlock(view, block, lines)
}

/** 结构变动后，等表格重渲染把光标送回 (row, col) 单元格 */
function focusCellAfterRender(_view: EditorView, row: number, col: number): void {
  pendingRefocus = { row, col }
}

function copyTable(view: EditorView, block: TableBlock): void {
  const from = view.state.doc.line(block.startLine).from
  const to = view.state.doc.line(block.endLine).to
  const text = view.state.doc.sliceString(from, to)
  const clip = navigator.clipboard
  if (clip) clip.writeText(text).catch(() => {})
}

function deleteTable(view: EditorView, block: TableBlock): void {
  const from = view.state.doc.line(block.startLine).from
  const lastNo = block.endLine
  const to = view.state.doc.line(lastNo).to
  // 连同紧随其后的一个换行一起删，避免出现空行残留
  let end = to
  if (lastNo < view.state.doc.lines) end = view.state.doc.line(lastNo + 1).from
  view.dispatch({ changes: { from, to: end, insert: '' }, selection: { anchor: from } })
}

/** 在 col 列右侧插入一列 */
function addColumn(view: EditorView, block: TableBlock, wrap: HTMLElement, col: number): void {
  const data = readTableFromDOM(wrap, block.aligns)
  const at = col + 1
  data.header.splice(at, 0, '')
  for (const r of data.rows) r.splice(at, 0, '')
  data.aligns.splice(at, 0, null)
  replaceTableBlock(view, block, buildTableLines(data))
  focusCellAfterRender(view, 0, at)
}

/** 在 rowIdx 行（0 基，不含表头）下方插入一行 */
function addRow(view: EditorView, block: TableBlock, wrap: HTMLElement, rowIdx: number): void {
  const data = readTableFromDOM(wrap, block.aligns)
  const at = rowIdx + 1
  data.rows.splice(at, 0, Array.from({ length: data.header.length }, () => ''))
  replaceTableBlock(view, block, buildTableLines(data))
  focusCellAfterRender(view, at + 1, 0)
}

/** 单元格内按键：阻止会穿透到 CodeMirror 的少数按键，保存类快捷键先落盘再放行 */
function onCellKey(e: KeyboardEvent, view: EditorView, block: TableBlock, wrap: HTMLElement): void {
  const stop = new Set([
    'Enter',
    'Backspace',
    'Delete',
    'Tab',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
  ])
  if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey)) {
    // 先落盘，再让全局保存快捷键继续生效
    commitTableIfChanged(view, block, wrap)
    return
  }
  if (stop.has(e.key)) e.stopPropagation()
}

/**
 * 整块表格 Widget（所见即所得，可就地编辑）。
 *
 * 交互：
 *  - 单元格 `contenteditable`，点哪格直接在哪格改字，表格**不会**回落成源码；
 *  - 左上角「编辑表格」按钮弹出菜单：复制 / 剪切 / 删除 整张表格；
 *  - 列分隔线（每列表头右缘）的「+」在右侧插入一列；
 *  - 行分隔线（每行首格底边）的「+」在下方插入一行。
 * 改动通过「离开表格时落盘 / 结构变动时重排」回写到纯 Markdown 源码。
 */
class TableWidget extends WidgetType {
  constructor(readonly block: TableBlock) {
    super()
  }
  eq(other: TableWidget): boolean {
    return other.block.sig === this.block.sig
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = el('div', 'cm-md-table-wrap')

    // ---- 左上角「编辑表格」工具按钮 + 菜单 ----
    const tools = el('div', 'cm-md-table-tools')
    const toolsBtn = document.createElement('button')
    toolsBtn.type = 'button'
    toolsBtn.className = 'cm-md-table-tools-btn'
    toolsBtn.textContent = '▦'
    toolsBtn.title = '编辑表格'
    toolsBtn.setAttribute('aria-label', '编辑表格')
    const menu = el('div', 'cm-md-table-menu')
    menu.style.display = 'none'
    const mkItem = (label: string, fn: () => void): HTMLButtonElement => {
      const it = document.createElement('button')
      it.type = 'button'
      it.className = 'cm-md-table-menu-item'
      it.textContent = label
      it.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      it.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        menu.style.display = 'none'
        fn()
      })
      return it
    }
    menu.appendChild(mkItem('复制表格', () => copyTable(view, this.block)))
    menu.appendChild(
      mkItem('剪切表格', () => {
        copyTable(view, this.block)
        deleteTable(view, this.block)
      })
    )
    menu.appendChild(mkItem('删除表格', () => deleteTable(view, this.block)))
    toolsBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    toolsBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none'
    })
    tools.appendChild(toolsBtn)
    tools.appendChild(menu)
    wrap.appendChild(tools)

    // 点击表格其它区域时收起菜单
    wrap.addEventListener('mousedown', () => {
      menu.style.display = 'none'
    })

    const table = el('table', 'cm-md-table')

    // ---- 表头 + 列加号 ----
    const thead = document.createElement('thead')
    const htr = document.createElement('tr')
    this.block.header.cells.forEach((c, i) => {
      const th = this.cellEl('th', c, i, 0, view, wrap)
      htr.appendChild(th)
      const add = el('span', 'cm-md-col-add')
      add.textContent = '+'
      add.title = '在右侧插入一列'
      add.dataset.col = String(i)
      add.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      add.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        addColumn(view, this.block, wrap, i)
      })
      th.appendChild(add)
    })
    thead.appendChild(htr)
    table.appendChild(thead)

    // ---- 表体 + 行加号 ----
    const tbody = document.createElement('tbody')
    this.block.rows.forEach((row, ri) => {
      const tr = document.createElement('tr')
      row.cells.forEach((c, ci) => {
        const td = this.cellEl('td', c, ci, ri + 1, view, wrap)
        tr.appendChild(td)
        if (ci === 0) {
          const add = el('span', 'cm-md-row-add')
          add.textContent = '+'
          add.title = '在下方插入一行'
          add.dataset.row = String(ri)
          add.addEventListener('mousedown', (e) => {
            e.preventDefault()
            e.stopPropagation()
          })
          add.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            addRow(view, this.block, wrap, ri)
          })
          td.appendChild(add)
        }
      })
      tbody.appendChild(tr)
    })
    table.appendChild(tbody)
    wrap.appendChild(table)

    // 焦点离开表格（移到表格外）时，把未提交的单元格改动落盘
    wrap.addEventListener('focusout', (e: FocusEvent) => {
      const related = e.relatedTarget as Node | null
      if (related && wrap.contains(related)) return // 仍在同一表内（切到另一格 / 点 + 按钮），不提交
      commitTableIfChanged(view, this.block, wrap)
    })

    return wrap
  }
  private cellEl(
    tag: 'th' | 'td',
    c: TableCell,
    col: number,
    row: number,
    view: EditorView,
    wrap: HTMLElement
  ): HTMLElement {
    const td = document.createElement(tag)
    const align = this.block.aligns[col]
    if (align) td.style.textAlign = align
    td.dataset.row = String(row)
    td.dataset.col = String(col)
    td.setAttribute('contenteditable', 'true')
    td.className = 'cm-md-cell'
    // 内容必须包一层 .cm-md-cell-content：落盘读取（readCellText）只认这一层。
    // 「+」按钮作为兄弟节点挂在内容层外面，永远不会被当成单元格文本写回源码。
    const content = el('span', 'cm-md-cell-content')
    content.appendChild(renderInlineDOM(c.text))
    td.appendChild(content)
    td.addEventListener('keydown', (e) => onCellKey(e, view, this.block, wrap))
    return td
  }
  ignoreEvent(): boolean {
    // 表格内的编辑 / 点击全部由我们自己的处理器接管，不走编辑器默认行为
    return true
  }
}

// --- 插件 ----------------------------------------------------------------

/**
 * 装饰集合用 **StateField** 而不是 ViewPlugin 提供。
 *
 * 原因：表格是整块替换（`block: true`），而 CodeMirror 明确禁止 ViewPlugin
 * 产生块级装饰 —— 会在布局阶段抛
 * `RangeError: Block decorations may not be specified via plugins`，
 * 顺带把整个 DocView 打崩（后续报 measureVisibleLineHeights undefined）。
 * 这个限制只在真正渲染时才暴露，`tsc` 和 `vite build` 都发现不了。
 *
 * StateField + EditorView.decorations 是官方唯一允许块级装饰的入口。
 */

/**
 * 上一次 buildFrom 收集到的全部标记区间（按 from 升序）。
 * 用于「光标命中的是哪个标记」的二分查找，避免每次按方向键都全文重扫。
 */
let markIndex: [number, number][] = []
/** 结构变动（增删行列）后，等表格重渲染把光标送回目标单元格 */
let pendingRefocus: { row: number; col: number } | null = null

/** 焦点是否落在表格控件内部（contenteditable 单元格 / + 按钮 / 工具栏） */
function isInsideTableWidget(el: Element | null): boolean {
  return !!el && el.closest('.cm-md-table-wrap') !== null
}

/** 二分查找：光标 pos 命中的标记下标；没命中返回 -1 */
function findMark(pos: number): number {
  let lo = 0
  let hi = markIndex.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [a, b] = markIndex[mid]
    if (pos < a) hi = mid - 1
    else if (pos >= b) lo = mid + 1
    else return mid
  }
  return -1
}

/** 编辑器是否有焦点。无焦点时不该给用户看任何原始语法 */
let focusProxy = false
/** 上一次 buildFrom 时「光标命中的标记下标」，-1 = 没命中任何标记 */
let hitMarkProxy = -1
/** 上一次 buildFrom 时的光标行号（表格按行判断用） */
let cursorLineProxy = -1

function buildFrom(state: EditorState): DecorationSet {
  const out: Pending[] = []
  const marks: [number, number][] = []
  const sel = state.selection.main
  const ctx: Ctx = {
    cursorLine: focusProxy ? state.doc.lineAt(sel.head).number : -1,
    cursorPos: focusProxy ? sel.head : -1,
    out,
    claimed: [],
    marks,
    inFence: false,
    fenceMarker: '',
  }

  // 扫描范围是**整篇文档**，不用 visibleRanges。
  //
  // 为什么不能用 visibleRanges：一旦某块被 block 替换，CodeMirror 会把这段
  // 从 visibleRanges 里「挖掉」（实测渲染过表格后 visibleRanges 变成
  // [[0,564],[1408,2739]] 这种两段不连续区间，表格所在区间正好不在里面）。
  // 拿它当扫描依据 → 表格被自己的渲染结果挤出扫描范围 → 永远算不出源码态，
  // 表现为「光标明明进了表格，表格还是 <table>」。
  //
  // 整篇扫描对大文档是否有性能问题：装饰重建只发生在 docChanged /
  // selectionSet / viewportChanged / focusChanged，其中真正逐键输入的只有
  // docChanged 与 selectionSet，而它们本来就要求全文重算（原实现也是线性扫到
  // 可见区末尾）。这份报告 158 行、实测无卡顿；真要优化，正确方向是给
  // TableBlock 加「文档版本号」做增量缓存，而不是缩小扫描范围。
  const endLine = state.doc.lines

  // 表格块缓存：同一行可能被多次询问，避免重复解析
  const tableCache = new Map<number, TableBlock | null>()

  for (let n = 1; n <= endLine; n++) {
    const line = state.doc.line(n)
    ctx.claimed = []

    // --- 表格：整块识别，整块跳过 ---
    if (!ctx.inFence) {
      const cached = tableCache.get(n)
      const block =
        cached !== undefined ? cached : parseTableBlock(state.doc, n, endLine, line.from)
      tableCache.set(n, block)

      if (block) {
        // 整块换成 <table>（`block: true` 整体替换）。表格始终以所见即所得形式呈现，
        // 点击进入后**不再回落成源码**——单元格本身可就地编辑（见 TableWidget）。
        //
        // ⚠️ `block: true` 的 Widget 绝不能带纵向 margin（会令其下方所有行点击偏到下一行，
        // 见 global.css 里 `.editor-host .cm-content *` 的全局防线）。
        out.push({
          from: state.doc.line(block.startLine).from,
          to: state.doc.line(block.endLine).to,
          deco: Decoration.replace({
            widget: new TableWidget(block),
            block: true,
          }),
        })
        n = block.endLine
        continue
      }
    }

    processLine(state, ctx, line.text, line.from)
  }

  // 记录本次的推导结果，供 update() 判断「下一次选区变化是否需要重算」。
  // markIndex 必须排序：扫描是按行推进的，但**行内**的标记是按规则顺序
  // push 的（行内代码规则先跑），不保证全局 from 有序，二分会失效。
  markIndex = marks.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  hitMarkProxy = focusProxy ? findMark(state.selection.main.head) : -1
  cursorLineProxy = ctx.cursorLine

  return Decoration.set(
    out.map((p) => p.deco.range(p.from, p.to)),
    true
  )
}

/**
 * 携带「焦点状态」的空文档 transaction。
 *
 * 为什么必须用 effect 显式传，而不是模块级变量：
 * StateField 的 `create` 在插件构造之前就跑，此时 updateListener 还没跑过，
 * 模块级变量会是初始值 —— 装饰算两遍（第二遍才对）或者干脆算错。
 * 走 transaction 则保证「算装饰时用的光标」与「触发重算的光标」同源。
 */
const setFocus = StateEffect.define<boolean>()

const decoField = StateField.define<DecorationSet>({
  create: (state) => buildFrom(state),
  update(decos, tr) {
    // 文档变了最重要：先按新文档重扫全文
    if (tr.docChanged) return buildFrom(tr.state)

    let hasEffect = false
    for (const e of tr.effects) {
      if (e.is(setFocus)) {
        focusProxy = e.value
        hasEffect = true
      }
    }
    if (hasEffect) return buildFrom(tr.state)

    // 注意：Transaction 上是 `selection`，ViewUpdate 上才是 `selectionSet`
    if (!tr.selection) return decos

    // ⚠️ 选区变了**不一定**要重算装饰。只有两种情况会改变结果：
    //   1. 光标「命中 / 脱离」了某个标记区间 → 该标记的显隐要翻转
    //   2. 光标跨行 → 表格的按行判断（cursorLine）失效
    // 同一行里在正文上左右移动光标时两者都不变，直接复用旧装饰。
    // 少了这个判断，每按一次方向键都会全文重扫一遍，长文档下会明显卡。
    const head = tr.state.selection.main.head
    if (!focusProxy) return decos
    const hit = findMark(head)
    const line = tr.state.doc.lineAt(head).number
    if (hit === hitMarkProxy && line === cursorLineProxy) return decos
    return buildFrom(tr.state)
  },
  provide: (f) => EditorView.decorations.from(f),
})

/**
 * 焦点同步：只有 view 才知道 hasFocus，所以焦点状态由它算出后经 effect 传给 StateField。
 *
 * ⚠️ 这里用 **EditorView.updateListener** 而不是 ViewPlugin.fromClass(...).update，
 * 是踩过坑才换的：ViewPlugin 的 update 只在「视图需要重绘」时触发，
 * 而 `view.dispatch({ selection })` 这类纯选区变化不一定会走到它 ——
 * 实测把光标在表格内外来回移动，ViewPlugin.update 的调用计数死死不动，
 * 导致光标状态永远停在旧值，表现为「光标进了表格，表格死活不回落源码」，
 * 且**没有任何报错**。updateListener 对每个 transaction 都会触发，是这里唯一可靠的钩子。
 *
 * 这里**只**同步焦点，选区变化的处理全在 decoField.update 里
 * （它能直接拿到 tr.state，且自带「命中标记是否变化」的短路判断）。
 * 早前在这里也 dispatch 选区，会导致一次移动触发两遍全文扫描。
 */
const cursorSync = EditorView.updateListener.of((u) => {
  // 文档变化时 decoField 自己会重扫，这里不能插手，否则一次按键扫两遍
  if (u.docChanged) return
  const focused = u.view.hasFocus
  if (focused === focusProxy) return
  // 焦点落到了表格控件内部（contenteditable 单元格 / + 按钮 / 工具栏）时，
  // 不要当成「编辑器失焦」—— 否则会触发整表重渲染、破坏正在编辑的单元格。
  if (!focused && isInsideTableWidget(document.activeElement)) return
  u.view.dispatch({ effects: setFocus.of(focused) })
})

/**
 * 结构变动（增删行列）后，等表格重渲染把光标送回目标单元格。
 * 在 rAF 里执行：此时 CodeMirror 已完成 DOM 更新，新 Widget 的单元格已就位。
 */
const tableRefocus = EditorView.updateListener.of((u) => {
  if (!pendingRefocus) return
  if (!u.docChanged) return
  const target = pendingRefocus
  pendingRefocus = null
  const view = u.view
  requestAnimationFrame(() => {
    const wraps = view.dom.querySelectorAll('.cm-md-table-wrap')
    for (const w of Array.from(wraps) as HTMLElement[]) {
      const cell = w.querySelector(`[data-row="${target.row}"][data-col="${target.col}"]`)
      if (cell) {
        const node = cell as HTMLElement
        node.focus()
        const sel = window.getSelection()
        if (sel) {
          const range = document.createRange()
          range.selectNodeContents(node)
          range.collapse(false)
          sel.removeAllRanges()
          sel.addRange(range)
        }
        break
      }
    }
  })
})

export function livePreview(): Extension {
  return [decoField, cursorSync, tableRefocus]
}

// --- 供大纲跳转使用 ------------------------------------------------------

/** 行号（1 起）→ 文档绝对位置 */
export function lineToPos(state: EditorState, line: number): number {
  const n = Math.min(Math.max(1, line), state.doc.lines)
  return state.doc.line(n).from
}
