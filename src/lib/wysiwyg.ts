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
  /**
   * 光标所在行（1 起），-1 表示无焦点。
   * 用途：表格的跨行块级判断 + 围栏行「光标在本行就露出原文」
   */
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
const TASK_RE = /^(\s*)([-*+])(\s+)(\[[ xX]\])(\s*)(.*)$/

/** 围栏行解析结果 */
interface FenceInfo {
  /** 行首缩进宽度（0~3） */
  indent: number
  /** 围栏标记本身（``` 或 ~~~，3 个起） */
  marker: string
  /** 完整 info string（可含空格，如 `js copy`） */
  info: string
  /** 取首个 token 作为语言标识（与 markdown-it 一致） */
  lang: string
}

/**
 * 识别围栏行。
 *
 * ⚠️ info string 必须允许空格：` ```js copy ` / ` ```python title=a.py ` 都是
 * 合法围栏（CommonMark 里 info string 就是「语言 + 可选元信息」）。
 * 老实现对 `(\S*)\s*$` 的限制会让这种行**不被当成围栏**，于是整块代码按普通
 * 段落解析，更糟的是块末尾那个 ` ``` ` 反而被当成**开**围栏 ——
 * 后面的正文全被染成代码样式，且因为开/闭错位，一直到文末都无法恢复。
 *
 * ⚠️ 反引号围栏的 info string 里不能再有反引号：那种行是行内代码
 * （`` ```a``` ``），当成围栏会让整行凭空消失。
 */
function parseFence(lineText: string): FenceInfo | null {
  const m = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*(.*?)[ \t]*$/.exec(lineText)
  if (!m) return null
  const marker = m[2]
  const info = m[3]
  if (marker[0] === '`' && info.includes('`')) return null
  return { indent: m[1].length, marker, info, lang: info.split(/\s+/)[0] ?? '' }
}

/**
 * 闭围栏判据（CommonMark）：同种标记、不短于开围栏、且**不能带 info string**。
 *
 * 少了后两条时，块里出现一行 ` ```js ` 或 ` ``` ` 就会提前闭合，
 * 剩下的代码被当成正文，而真正的闭围栏又开了一个新块。
 *
 * 独立成函数是为了让判据只有一个出处 —— 之前表格那侧算过一份「围栏是否闭合」，
 * 两套判据一旦漂移就会出现「表格以为在代码里、围栏以为已闭合」的自相矛盾。
 */
function fenceCloses(openMarker: string, f: FenceInfo): boolean {
  return f.marker[0] === openMarker[0] && f.marker.length >= openMarker.length && f.info === ''
}

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
 * 围栏行的呈现（``` 或 ~~~）。
 *
 * 关键：**光标停在本行时必须露出原文**。
 *
 * 老实现无条件 `hide()` 整行，实测后果很具体：敲下第 3 个反引号的**那一瞬间**
 * 这一行就变成空白灰条 —— 接着输入的语言名（`java`）改的全是看不见的文本：
 *   - 打错没法发现、没法改；
 *   - 点这一行时光标逻辑位置在行尾、画在行首，看着像「点哪都没反应」；
 *   - 这时再敲字，` ```java ` 会变成 ` ```javaX `：语言标识被悄悄改坏，
 *     而用户屏幕上什么都没变。
 *
 * 这与标题等块级前缀「一律隐藏」的取舍不同：围栏行只有语言标识这几个字，
 * 露出来不影响阅读；不露出来，它就无法被编辑。
 */
function renderFenceLine(
  ctx: Ctx,
  lineText: string,
  lineFrom: number,
  lineNo: number,
  lang: string
): void {
  addLine(ctx, lineFrom, 'cm-md-fence')
  // 光标在本行：保留原文（语言标识直接可见可改），也不再挂右下角的语言标签
  if (ctx.cursorLine === lineNo) return
  hide(ctx, lineFrom, lineFrom + lineText.length)
  if (lang) {
    // 收起状态下，用右下角标签提示语言
    ctx.out.push({
      from: lineFrom + lineText.length,
      to: lineFrom + lineText.length,
      deco: Decoration.widget({ widget: new FenceLabel(lang), side: 1 }),
    })
  }
}

/**
 * 解析一行。
 * ctx.inFence / ctx.fenceMarker 表示**进入这一行之前**的围栏状态；
 * 围栏的开/关状态转移只在本函数内发生，调用方不需要再同步一遍。
 */
function processLine(
  state: EditorState,
  ctx: Ctx,
  lineText: string,
  lineFrom: number,
  lineNo: number
): void {
  // --- 代码围栏：整块不做内联解析 ---
  const fence = parseFence(lineText)
  if (fence) {
    if (ctx.inFence) {
      if (fenceCloses(ctx.fenceMarker, fence)) {
        ctx.inFence = false
        ctx.fenceMarker = ''
        renderFenceLine(ctx, lineText, lineFrom, lineNo, '')
        return
      }
      // 不是闭围栏 → 它只是围栏里的一行代码
      addLine(ctx, lineFrom, 'cm-md-codeblock')
      return
    }
    ctx.inFence = true
    ctx.fenceMarker = fence.marker
    renderFenceLine(ctx, lineText, lineFrom, lineNo, fence.lang)
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
  /** 有就地改动的表格相对行号：0=表头，1=分隔行，2 起=表体行 */
  dirty?: Set<number>
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
 * 只读 `.cm-md-cell-content` 子层：单元格里除了内容还可能挂装饰/控件，
 * 直接取 td.textContent 会把它们的文字一起写回 Markdown。
 * v0.3.14 就踩过 —— 当时行/列「+」按钮挂在单元格里，文字恰好是 "+"，
 * 每次落盘都往 Markdown 写进一批 "+"，单元格累积成 "++++++++"。
 * 现在插入按钮已经移到表格外侧，但这个读法继续保持「只认内容层」。
 */
function readCellText(cell: Element | null): string {
  return cellText(cell?.querySelector(':scope > .cm-md-cell-content') ?? null)
}

/** 单元格的内容层（落盘只认这一层，见 readCellText 的注释） */
function cellContentLayer(cell: Element | null): HTMLElement | null {
  return (cell?.querySelector(':scope > .cm-md-cell-content') as HTMLElement | null) ?? null
}

/**
 * 行内渲染器产出的标签 → Markdown 包装符。
 *
 * 必须与 INLINE_RULES 的 dom() 一一对应：多了会凭空写出不存在的语法，
 * 少了就等于「用户在这格改一个字，整格的格式被他自己的编辑冲掉」。
 */
const CELL_WRAP: Record<string, [string, string]> = {
  STRONG: ['**', '**'],
  EM: ['*', '*'],
  DEL: ['~~', '~~'],
  MARK: ['==', '=='],
  CODE: ['`', '`'],
}

/** 单元格只能占一行：这些节点一律折成空格，否则换行会把表格行劈开 */
const CELL_BREAK = new Set(['BR', 'DIV', 'P', 'LI'])

/** DOM → Markdown 行内源码（只用于**确实被改过**的单元格） */
function serializeInline(node: Node): string {
  if (node.nodeType === 3) return (node as Text).data
  if (node.nodeType !== 1) return ''
  const e = node as HTMLElement
  const tag = e.nodeName
  if (CELL_BREAK.has(tag)) return ' '
  if (tag === 'IMG') {
    const alt = e.getAttribute('alt') ?? ''
    const src = e.getAttribute('src') ?? ''
    return `![${alt}](${src})`
  }
  let inner = ''
  for (const c of Array.from(e.childNodes)) inner += serializeInline(c)
  if (tag === 'A') {
    const href = e.getAttribute('href') ?? ''
    return href ? `[${inner}](${href})` : inner
  }
  const pair = CELL_WRAP[tag]
  return pair && inner ? pair[0] + inner + pair[1] : inner
}

/** 单元格文本 → 可安全放进表格行的源码：竖线必须转义，否则会把格子劈成两列 */
function escapeCellText(t: string): string {
  // `\\?\|` 同时覆盖「裸竖线」和「已经转义过的竖线」，所以是幂等的
  return t.replace(/\\?\|/g, '\\|')
}

/**
 * 单元格当前是否被就地改过。
 *
 * 判定依据是渲染时的文本快照（`data-disp`）与现在的文本比对，
 * **不比较源码**：源码里 `**名称**` 渲染出来只有「名称」两个字，直接比永远不相等。
 */
function isCellEdited(cell: Element | null): boolean {
  if (!cell) return false
  const disp = cell.getAttribute('data-disp')
  if (disp === null) return true // 没有快照 → 保守地当作改过，走序列化
  return readCellText(cell) !== disp
}

/**
 * 读出一格该写回源码的文本。
 *
 * 两套走法，这是「不丢格式」的关键：
 *  - **没改过** → 原样返回解析出来的源码（`parseTableRow` 已把 `\|` 解成 `|`，
 *    所以这里只补转义）。`**粗体**`、`` `代码` ``、`[链接](url)`、甚至用户手写的
 *    `a\|b`，一个字符都不会动。
 *  - **改过** → 把 DOM 反序列化回 Markdown，再把竖线转义。
 *
 * 上一版两条路合成一条（统一读渲染后的纯文本），后果是**光是点一下表格再点走**，
 * 整张表的行内格式就被剥成纯文本；含 `\|` 的单元格还会多裂出一列。
 */
function cellSourceOf(cell: Element | null): string {
  if (!cell) return ''
  const src = cell.getAttribute('data-src')
  if (src !== null && !isCellEdited(cell)) return escapeCellText(src)
  const layer = cellContentLayer(cell)
  if (!layer) return escapeCellText(src ?? '')
  let text = ''
  for (const c of Array.from(layer.childNodes)) text += serializeInline(c)
  // 浏览器在 contenteditable 里习惯把空格写成 &nbsp;，落盘要还原成普通空格；
  // 制表符同样折成空格（Markdown 表格里的裸 tab 会干扰对齐与部分解析器）
  const clean = text.replace(/[\u00a0\r\n\t]+/g, ' ').replace(/\s+$/, '')
  return escapeCellText(clean)
}

/**
 * 从当前正在渲染的表格 DOM 读回结构化数据（含未落盘的就地编辑）。
 *
 * `dirty` 记录「有就地改动」的**表格相对行号**：0 是表头，1 是分隔行（永不参与），
 * 2 起是表体行。就地落盘只重写这些行，其余行连空格都不碰。
 */
function readTableFromDOM(wrap: HTMLElement, aligns: (Align | null)[]): TableData {
  const dirty = new Set<number>()
  const header = Array.from(wrap.querySelectorAll('thead th')).map((th) => {
    if (isCellEdited(th)) dirty.add(0)
    return cellSourceOf(th)
  })
  const rows = Array.from(wrap.querySelectorAll('tbody tr')).map((tr, ri) =>
    Array.from(tr.querySelectorAll('td')).map((td) => {
      if (isCellEdited(td)) dirty.add(ri + 2)
      return cellSourceOf(td)
    })
  )
  return { header, rows, aligns, dirty }
}

function alignToDelim(a: Align | null): string {
  if (a === 'center') return ':-:'
  if (a === 'right') return '--:'
  if (a === 'left') return ':-'
  return '---'
}

function buildRowLine(cells: string[]): string {
  return '| ' + cells.join(' | ') + ' |'
}

function buildTableLines(d: TableData): string[] {
  const delim = d.aligns.map(alignToDelim).join(' | ')
  const lines = [buildRowLine(d.header), '| ' + delim + ' |']
  for (const r of d.rows) lines.push(buildRowLine(r))
  return lines
}

/** 把表格区块整体替换为新内容（多行用 \n 连接） */
function replaceTableBlock(view: EditorView, block: TableBlock, lines: string[]): void {
  const from = view.state.doc.line(block.startLine).from
  const to = view.state.doc.line(block.endLine).to
  view.dispatch({ changes: { from, to, insert: lines.join('\n') } })
}

/**
 * 把 DOM 里的就地编辑合并进源码行：**只覆盖被改过的行**，其余行原文照抄。
 *
 * 「只改这一行」是刻意的：用户的空格对齐、紧凑写法 `|a|b|`、列宽风格都能原样留着，
 * diff 里也只出现真正改动的那一行。整表重建（buildTableLines）只用于结构变动。
 */
function mergeEditedRows(view: EditorView, block: TableBlock, data: TableData): string[] {
  const lines: string[] = []
  for (let n = block.startLine; n <= block.endLine; n++) lines.push(view.state.doc.line(n).text)
  for (const idx of data.dirty ?? []) {
    if (idx === 0) lines[0] = buildRowLine(data.header)
    else if (idx >= 2) {
      const row = data.rows[idx - 2]
      if (row) lines[idx] = buildRowLine(row)
    }
  }
  return lines
}

/**
 * 把就地编辑的结果落盘。
 *
 * 没有改动就一个字节都不写 —— 早先「整表重建 + 与源码比对」的写法会在
 * 用户只是点进表格又点走时，就把 `**粗体**`、`` `代码` ``、`a \| b` 一起改写掉。
 */
function commitTableIfChanged(view: EditorView, block: TableBlock, wrap: HTMLElement): void {
  const data = readTableFromDOM(wrap, block.aligns)
  if (!data.dirty || data.dirty.size === 0) return

  const next = mergeEditedRows(view, block, data)
  const cur: string[] = []
  for (let n = block.startLine; n <= block.endLine; n++) cur.push(view.state.doc.line(n).text)
  if (next.join('\n') === cur.join('\n')) return

  // 焦点还在某一格（Ctrl+S 落盘）：重渲染会把那格换掉，先把光标位置记下来。
  // 不记的话表现就是「按一下保存，光标凭空消失」，接着打字打到了别处。
  const active = document.activeElement as HTMLElement | null
  const activeCell = active?.closest?.('.cm-md-cell') as HTMLElement | null
  if (activeCell && wrap.contains(activeCell)) {
    focusCellAfterRender(
      view,
      Number(activeCell.dataset.row),
      Number(activeCell.dataset.col),
      { offset: caretOffsetInCell(activeCell), anchor: block.startLine }
    )
  }
  replaceTableBlock(view, block, next)
}

/**
 * 登记「结构变动后把光标送回 (row, col)」。
 *
 * ⚠️ 必须在 `view.dispatch` **之前**调用：CodeMirror 的 updateListener 是在
 * dispatch 内部同步触发的。早期把它写在 dispatch 之后，监听器早已跑完，
 * pendingRefocus 只能等下一次文档变化才被消费 —— 表现为增删行列后光标凭空消失。
 *
 * anchor 是**表格锚点**（表格起始行号）：文档里可能有多张表，只按 (row, col)
 * 找会跳进另一张表里。offset 是格内字符偏移，-1 表示放到末尾。
 */
function focusCellAfterRender(
  _view: EditorView,
  row: number,
  col: number,
  opts: { offset?: number; anchor?: number } = {}
): void {
  pendingRefocus = { row, col, offset: opts.offset ?? -1, anchor: opts.anchor ?? -1 }
}

/** 光标在当前单元格内的字符偏移；不在格内返回 -1 */
function caretOffsetInCell(cell: HTMLElement): number {
  const layer = cellContentLayer(cell)
  const sel = window.getSelection()
  if (!layer || !sel || sel.rangeCount === 0) return -1
  const range = sel.getRangeAt(0)
  if (!layer.contains(range.startContainer)) return -1
  const pre = document.createRange()
  pre.selectNodeContents(layer)
  pre.setEnd(range.startContainer, range.startOffset)
  return pre.toString().length
}

/** 聚焦单元格并按字符偏移落点（offset < 0 → 末尾） */
function focusCellNode(node: HTMLElement, offset = -1): void {
  node.focus()
  const sel = window.getSelection()
  if (!sel) return
  const target = cellContentLayer(node) ?? node
  const range = document.createRange()
  let rest = offset
  let placed = false
  if (rest >= 0) {
    // 按文本节点逐段减去，落在 offset 对应的那一格位置
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
    let n: Node | null = walker.nextNode()
    while (n) {
      const len = (n as Text).data.length
      if (rest <= len) {
        range.setStart(n, rest)
        range.collapse(true)
        placed = true
        break
      }
      rest -= len
      n = walker.nextNode()
    }
  }
  if (!placed) {
    range.selectNodeContents(target)
    range.collapse(false)
  }
  sel.removeAllRanges()
  sel.addRange(range)
}

/** 写剪贴板：优先异步 API，没有就退回 execCommand（Tauri 自定义协议下常拿不到 clipboard） */
function writeClipboard(text: string): void {
  const clip = navigator.clipboard
  if (clip?.writeText) {
    clip.writeText(text).catch(() => legacyCopy(text))
    return
  }
  legacyCopy(text)
}

function legacyCopy(text: string): void {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  // 不能用 display:none：那不参与选区，选中就是空的
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } catch {
    // 无剪贴板权限时静默失败：不打断用户，也不抛未捕获异常
  }
  ta.remove()
}

/**
 * 复制表格源码。
 *
 * ⚠️ 必须从 **DOM** 读，不能直接取 `view.state.doc`：单元格里刚敲的内容还没落盘
 * （要等离开表格才提交），取源码会复制到「编辑之前」的旧内容。
 */
function copyTable(view: EditorView, block: TableBlock, wrap: HTMLElement): void {
  const data = readTableFromDOM(wrap, block.aligns)
  writeClipboard(mergeEditedRows(view, block, data).join('\n'))
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

/** 按 (row, col) 找单元格；row=0 是表头，1 起是表体 */
function cellNode(wrap: HTMLElement, row: number, col: number): HTMLElement | null {
  return wrap.querySelector<HTMLElement>(`.cm-md-cell[data-row="${row}"][data-col="${col}"]`)
}

/** 在列索引 at 处（0..列数）插入一列；focusRow 决定插入后光标回到哪一行 */
function insertColumnAt(
  view: EditorView,
  block: TableBlock,
  wrap: HTMLElement,
  at: number,
  focusRow = 0
): void {
  const data = readTableFromDOM(wrap, block.aligns)
  const idx = Math.min(Math.max(at, 0), data.header.length)
  data.header.splice(idx, 0, '')
  for (const r of data.rows) r.splice(idx, 0, '')
  data.aligns.splice(idx, 0, null)
  focusCellAfterRender(view, Math.min(Math.max(focusRow, 0), data.rows.length), idx, { anchor: block.startLine })
  replaceTableBlock(view, block, buildTableLines(data))
}

/**
 * 在表体行索引 at 处（0..行数）插入一行；at=0 表示表头正下方。
 * focusCol：插完把光标放在新行的哪一列（默认第 0 列，菜单操作传光标所在列）。
 */
function insertRowAt(
  view: EditorView,
  block: TableBlock,
  wrap: HTMLElement,
  at: number,
  focusCol = 0
): void {
  const data = readTableFromDOM(wrap, block.aligns)
  const idx = Math.min(Math.max(at, 0), data.rows.length)
  data.rows.splice(idx, 0, Array.from({ length: data.header.length }, () => ''))
  focusCellAfterRender(view, idx + 1, Math.min(Math.max(focusCol, 0), data.header.length - 1), {
    anchor: block.startLine,
  })
  replaceTableBlock(view, block, buildTableLines(data))
}

/** 删除表体第 ri 行（0 基）；focusCol 让光标留在原来的列 */
function deleteRowAt(
  view: EditorView,
  block: TableBlock,
  wrap: HTMLElement,
  ri: number,
  focusCol = 0
): void {
  const data = readTableFromDOM(wrap, block.aligns)
  if (ri < 0 || ri >= data.rows.length) return
  data.rows.splice(ri, 1)
  // 删完还有行就停在原位置（原来那行的下一行顶上来）；全删光就回到表头
  const next = Math.min(ri, data.rows.length - 1)
  const col = Math.min(Math.max(focusCol, 0), data.header.length - 1)
  focusCellAfterRender(view, next >= 0 ? next + 1 : 0, col, { anchor: block.startLine })
  replaceTableBlock(view, block, buildTableLines(data))
}

/** 删除第 ci 列；至少保留一列 —— 零列表格不是合法 Markdown */
function deleteColumnAt(
  view: EditorView,
  block: TableBlock,
  wrap: HTMLElement,
  ci: number,
  focusRow = 0
): void {
  const data = readTableFromDOM(wrap, block.aligns)
  if (data.header.length <= 1 || ci < 0 || ci >= data.header.length) return
  data.header.splice(ci, 1)
  for (const r of data.rows) r.splice(ci, 1)
  data.aligns.splice(ci, 1)
  const col = Math.min(Math.max(ci - 1, 0), data.header.length - 1)
  focusCellAfterRender(view, Math.min(Math.max(focusRow, 0), data.rows.length), col, {
    anchor: block.startLine,
  })
  replaceTableBlock(view, block, buildTableLines(data))
}

/** 设置某列对齐方式 */
function setColumnAlign(
  view: EditorView,
  block: TableBlock,
  wrap: HTMLElement,
  ci: number,
  align: Align,
  focusRow = 0
): void {
  const data = readTableFromDOM(wrap, block.aligns)
  if (ci < 0 || ci >= data.header.length) return
  data.aligns[ci] = align
  focusCellAfterRender(view, Math.min(Math.max(focusRow, 0), data.rows.length), ci, {
    anchor: block.startLine,
  })
  replaceTableBlock(view, block, buildTableLines(data))
}

/**
 * 单元格粘贴。
 *
 * 只接受纯文本：从网页/Word 粘进来的 HTML 会带上 `&nbsp;`、`<div>`、行内样式，
 * 反序列化回 Markdown 的结果既不可控也没意义，还会把单元格撑成多行。
 * 换行同样要折成空格 —— 表格行必须是一行，否则整个表格结构会被劈开。
 */
function onCellPaste(e: ClipboardEvent): void {
  e.preventDefault()
  e.stopPropagation()
  const raw = e.clipboardData?.getData('text/plain') ?? ''
  if (!raw) return
  // 空白一律归一：换行会让表格行劈开，制表符/&nbsp; 写进源码既不可见又难维护
  const clean = raw.replace(/[ \t\u00a0\r\n]+/g, ' ').replace(/^ | $/g, '')
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  range.deleteContents()
  const node = document.createTextNode(clean)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

/**
 * 单元格内按键。
 *
 * 除保存快捷键外，这里接管了表格的**键盘导航**（语雀式）：
 *   Tab / Shift+Tab  依次前后移动单元格，走到最后一格自动追加一行
 *   Enter / Shift+Enter  上下移动；最后一行的回车自动加行
 * 其余按键只做 stopPropagation，避免穿透到 CodeMirror 触发整块重渲染。
 */
function onCellKey(e: KeyboardEvent, view: EditorView, block: TableBlock, wrap: HTMLElement): void {
  // 中文输入法组字期间（isComposing）不能抢键：Tab/Enter 可能正被输入法用来选词，
  // 抢掉会表现为「打拼音时莫名跳格 / 多出一行」
  if (e.isComposing) return

  if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey)) {
    // 先落盘，再让全局保存快捷键继续生效
    commitTableIfChanged(view, block, wrap)
    return
  }

  const cell = e.target as HTMLElement
  const row = Number(cell.dataset.row)
  const col = Number(cell.dataset.col)
  if (Number.isNaN(row) || Number.isNaN(col)) return

  const cols = wrap.querySelectorAll('thead th').length
  const bodyRows = wrap.querySelectorAll('tbody tr').length
  const go = (r: number, c: number): boolean => {
    const n = cellNode(wrap, r, c)
    if (!n) return false
    focusCellNode(n)
    return true
  }

  if (e.key === 'Tab') {
    e.preventDefault()
    e.stopPropagation()
    if (e.shiftKey) {
      if (col > 0) go(row, col - 1)
      else if (row > 0) go(row - 1, cols - 1)
      return
    }
    if (col + 1 < cols) go(row, col + 1)
    else if (row < bodyRows) go(row + 1, 0)
    else insertRowAt(view, block, wrap, bodyRows) // 最后一格 Tab → 追加一行
    return
  }

  if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    if (e.shiftKey) {
      if (row > 0) go(row - 1, col)
      return
    }
    if (row < bodyRows) go(row + 1, col)
    else insertRowAt(view, block, wrap, bodyRows, col) // 最后一行回车 → 再加一行（留在原列）
    return
  }

  // Esc：落盘并退出单元格。没有这个键，焦点进了表格就只能靠「点到别处」离开，
  // 用键盘的人是卡住的（Tab 只会在格子之间循环，最后一格还会加行）
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    commitTableIfChanged(view, block, wrap)
    ;(e.target as HTMLElement).blur()
    return
  }

  const stop = new Set([
    'Backspace',
    'Delete',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
  ])
  if (stop.has(e.key)) e.stopPropagation()
}

/**
 * 整块表格 Widget（所见即所得，可就地编辑）。
 *
 * 设计对齐语雀：
 *  - 浅灰细网格，单元格垂直居中，行悬停 + 列悬停淡色定位；
 *  - **不再往单元格里塞「+」**：只在表格右侧留白放列「+」、底部留白放行「+」，
 *    整张表最多两个插入按钮，悬停才显形（也彻底杜绝「+」污染单元格文本）；
 *  - 右上角「⋯」菜单按**当前单元格**做精确操作：上下插行 / 左右插列 /
 *    删除行列 / 列对齐 / 复制 / 删除表格；
 *  - 单元格 `contenteditable`，Tab / Enter 键盘导航（见 onCellKey）。
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
    // 锚点：结构变动后回填光标时用来认出「是这张表」（见 tableRefocus）
    wrap.dataset.tableStart = String(this.block.startLine)

    // ---- 行列操作的「目标单元格」：光标优先，悬停兜底 ----
    //
    // ⚠️ 光标和悬停必须是**两个独立状态**，不能像早期实现那样都写进同一个 active。
    // 原因很具体：右上角「⋯」在表格右侧留白里，鼠标从单元格移过去时会划过别的格，
    // 每次 mouseover 都覆盖目标 —— 于是「光标在第 1 列、删的却是第 2 列」。
    // 正确语义：有光标就跟光标；没有光标（只是鼠标在对面上滑）才退回悬停格。
    let caret: { row: number; col: number } | null = null
    let hover: { row: number; col: number } | null = null
    const target = (): { row: number; col: number } => caret ?? hover ?? { row: 0, col: 0 }

    const cellOf = (t: EventTarget | null): HTMLElement | null => {
      const e = t as Element | null
      const cell = e?.closest?.('.cm-md-cell') as HTMLElement | null
      return cell && wrap.contains(cell) ? cell : null
    }

    const colCount = (): number => wrap.querySelectorAll('thead th').length

    // ---- 右上角「⋯」菜单 ----
    const tools = el('div', 'cm-md-table-tools')
    const toolsBtn = document.createElement('button')
    toolsBtn.type = 'button'
    toolsBtn.className = 'cm-md-table-tools-btn'
    toolsBtn.textContent = '⋯'
    toolsBtn.title = '表格操作'
    toolsBtn.setAttribute('aria-label', '表格操作')

    const menu = el('div', 'cm-md-table-menu')
    menu.style.display = 'none'

    interface MenuItem {
      label: string
      run: () => void
      disabled?: () => boolean
      danger?: boolean
    }
    const items: { node: HTMLButtonElement; item: MenuItem }[] = []

    const closeMenu = (): void => {
      menu.style.display = 'none'
    }
    const addTitle = (t: string): void => {
      const d = el('div', 'cm-md-table-menu-title')
      d.textContent = t
      menu.appendChild(d)
    }
    const addDivider = (): void => {
      menu.appendChild(el('div', 'cm-md-table-menu-divider'))
    }
    const addItem = (item: MenuItem): void => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'cm-md-table-menu-item' + (item.danger ? ' is-danger' : '')
      b.textContent = item.label
      // mousedown 必须挡住：否则点菜单会先让编辑器失焦、整表重渲染
      b.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      b.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (b.getAttribute('aria-disabled') === 'true') return
        closeMenu()
        item.run()
      })
      menu.appendChild(b)
      items.push({ node: b, item })
    }

    addTitle('插入')
    addItem({
      label: '在上方插入行',
      // 光标在表头时「上方」不存在：置灰，避免按下去实际插到表头下面
      disabled: () => target().row < 1,
      run: () => insertRowAt(view, this.block, wrap, target().row - 1, target().col),
    })
    addItem({
      label: '在下方插入行',
      run: () => insertRowAt(view, this.block, wrap, Math.max(0, target().row), target().col),
    })
    addItem({
      label: '在左侧插入列',
      run: () => insertColumnAt(view, this.block, wrap, target().col, target().row),
    })
    addItem({
      label: '在右侧插入列',
      run: () => insertColumnAt(view, this.block, wrap, target().col + 1, target().row),
    })
    addDivider()
    addTitle('删除')
    addItem({
      label: '删除当前行',
      danger: true,
      disabled: () => target().row < 1,
      run: () => deleteRowAt(view, this.block, wrap, target().row - 1, target().col),
    })
    addItem({
      label: '删除当前列',
      danger: true,
      disabled: () => colCount() <= 1,
      run: () => deleteColumnAt(view, this.block, wrap, target().col, target().row),
    })
    addDivider()
    addTitle('对齐')
    addItem({
      label: '左对齐',
      run: () => setColumnAlign(view, this.block, wrap, target().col, 'left', target().row),
    })
    addItem({
      label: '居中对齐',
      run: () => setColumnAlign(view, this.block, wrap, target().col, 'center', target().row),
    })
    addItem({
      label: '右对齐',
      run: () => setColumnAlign(view, this.block, wrap, target().col, 'right', target().row),
    })
    addDivider()
    addItem({ label: '复制表格', run: () => copyTable(view, this.block, wrap) })
    addItem({ label: '删除表格', danger: true, run: () => deleteTable(view, this.block) })

    const openMenu = (): void => {
      // 每次打开按当前单元格重算可用状态
      for (const { node, item } of items) {
        node.setAttribute('aria-disabled', item.disabled?.() ? 'true' : 'false')
      }
      menu.style.display = 'block'
    }

    toolsBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    toolsBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (menu.style.display === 'none') openMenu()
      else closeMenu()
    })
    tools.appendChild(toolsBtn)
    tools.appendChild(menu)
    wrap.appendChild(tools)

    // ---- 表格本体 ----
    // 横向滚动只包住表格，控件留在 wrap 上，才不会被滚动容器裁掉
    const scroller = el('div', 'cm-md-table-scroll')
    const table = el('table', 'cm-md-table')

    // 每列一个「+」，挂在表头单元格右缘。悬停/光标落到哪一列，只有那一列的「+」显形，
    // 所以既能「任意位置插入」，又不会退回成一排 +++。
    const colAdds: HTMLButtonElement[] = []
    const lastCol = this.block.header.cells.length - 1
    const makeColAdd = (col: number): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'cm-md-col-add' + (col === lastCol ? ' is-last' : '')
      b.dataset.col = String(col)
      b.textContent = '+'
      b.title = '在右侧插入一列（Shift+点击：插入到左侧）'
      b.setAttribute('aria-label', '在右侧插入一列')
      // 按钮在 contenteditable 单元格内，必须脱离可编辑文本模型，
      // 否则全选删除时可能被当成文本一并删掉
      b.contentEditable = 'false'
      b.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      b.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        // 默认插到右侧，Shift 插到左侧
        insertColumnAt(view, this.block, wrap, e.shiftKey ? col : col + 1, target().row)
      })
      colAdds.push(b)
      return b
    }

    const thead = document.createElement('thead')
    const htr = document.createElement('tr')
    this.block.header.cells.forEach((c, i) => {
      const th = this.cellEl('th', c, i, 0, view, wrap)
      th.appendChild(makeColAdd(i))
      htr.appendChild(th)
    })
    thead.appendChild(htr)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    this.block.rows.forEach((row, ri) => {
      const tr = document.createElement('tr')
      row.cells.forEach((c, ci) => {
        tr.appendChild(this.cellEl('td', c, ci, ri + 1, view, wrap))
      })
      tbody.appendChild(tr)
    })
    table.appendChild(tbody)
    scroller.appendChild(table)
    wrap.appendChild(scroller)

    // ---- 行「+」：右侧留白里的单个按钮，靠改 top 对齐到当前行 ----
    // 点击插到该行下方（Shift：上方），覆盖「任意位置插行」
    let rowAddRow = -1 // 这个「+」当前对齐的行；点击以它为准（所见即所点）
    const rowAdd = document.createElement('button')
    rowAdd.type = 'button'
    rowAdd.className = 'cm-md-row-add'
    rowAdd.textContent = '+'
    rowAdd.title = '在下方插入一行（Shift+点击：插入到上方）'
    rowAdd.setAttribute('aria-label', '在下方插入一行')
    rowAdd.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    rowAdd.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const row = rowAddRow
      if (row < 1) {
        // 表体为空时「+」常显在表头中线（is-empty），此时没有行号可用：
        // 兜底插到表头下方第一行，否则会出现「看得见、点不动」
        if (this.block.rows.length === 0) insertRowAt(view, this.block, wrap, 0, target().col)
        return
      }
      insertRowAt(view, this.block, wrap, e.shiftKey ? row - 1 : row, target().col)
    })
    // 表体被删空时没有行可悬停，把「+」固定显示在表头中线，保证还能加回第一行
    if (tbody.children.length === 0) rowAdd.classList.add('is-empty')
    wrap.appendChild(rowAdd)

    // ---- 当前行列：列高亮 + 列「+」显隐 + 行「+」跟随 ----
    //
    // 「+」是直接操作（鼠标指到哪一列/哪一行就插在哪），所以展示位置**悬停优先**：
    // 所见即所点，不会有「看到的是 A 列、插进去是 B 列」的歧义。
    // 菜单不同 —— 菜单不带位置信息，必须跟光标（target()），这是上一轮修过的坑。
    let shownRow = -1
    let shownCol = -1
    let shownTr: HTMLElement | null = null
    const syncActive = (pos: { row: number; col: number } | null): void => {
      const row = pos ? pos.row : -1
      const col = pos ? pos.col : -1
      if (row === shownRow && col === shownCol) return
      shownRow = row
      shownCol = col
      for (const c of Array.from(wrap.querySelectorAll<HTMLElement>('.cm-md-cell'))) {
        c.classList.toggle('is-col-hover', col >= 0 && Number(c.dataset.col) === col)
      }
      for (const b of colAdds) {
        b.classList.toggle('is-active', col >= 0 && Number(b.dataset.col) === col)
      }
      // 目标行常亮：鼠标从行移到「+」上时 tr:hover 会失效，
      // 没有这个类就看不出「+」属于哪一行了
      if (shownTr) shownTr.classList.remove('is-row-hover')
      const tr = row >= 1 ? (tbody.children[row - 1] as HTMLElement | undefined) : undefined
      shownTr = tr ?? null
      if (tr) {
        tr.classList.add('is-row-hover')
        rowAddRow = row
        const wrapBox = wrap.getBoundingClientRect()
        const rowBox = tr.getBoundingClientRect()
        // 按钮高 20px（见 global.css），让按钮中心对准行中线
        rowAdd.style.top = `${rowBox.top - wrapBox.top + rowBox.height / 2 - 10}px`
        rowAdd.classList.add('is-active')
      } else {
        rowAddRow = -1
        rowAdd.classList.remove('is-active')
      }
    }
    const displayPos = (): { row: number; col: number } | null => hover ?? caret

    // ---- 光标 / 悬停：分开记录 ----
    wrap.addEventListener('mouseover', (e) => {
      const cell = cellOf(e.target)
      if (!cell) return
      hover = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) }
      syncActive(displayPos())
    })
    wrap.addEventListener('mouseleave', () => {
      // 鼠标离开表格就收起控件：避免「点过一格的 + 一直挂在那儿」的视觉噪音。
      // 键盘导航（Tab/Enter）不经过鼠标，focusin 会重新显示，不影响可达性。
      hover = null
      syncActive(null)
    })
    wrap.addEventListener('focusin', (e) => {
      const cell = cellOf(e.target)
      if (!cell) return
      caret = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) }
      // 清掉悬停：键盘 Tab 切格时鼠标可能停在上一个格，不能让它抢走展示位置
      hover = null
      syncActive(displayPos())
    })

    // 点击表格其它区域时收起菜单
    wrap.addEventListener('mousedown', (e) => {
      if (!tools.contains(e.target as Node)) closeMenu()
    })

    // 焦点离开时：① 控件交回悬停（或全部收起）；② 把未提交的单元格改动落盘
    wrap.addEventListener('focusout', (e: FocusEvent) => {
      const related = e.relatedTarget as Node | null
      if (related && wrap.contains(related)) return // 仍在同一表内（切到另一格 / 点按钮），不提交
      caret = null
      syncActive(displayPos())
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
    // 源码原文 + 渲染文本快照，落盘时靠这两个值区分「没碰过」和「改过」（见 cellSourceOf）
    td.dataset.src = c.text
    // 内容必须包一层 .cm-md-cell-content：落盘读取（readCellText）只认这一层。
    // 「+」按钮作为兄弟节点挂在内容层外面，永远不会被当成单元格文本写回源码。
    const content = el('span', 'cm-md-cell-content')
    content.appendChild(renderInlineDOM(c.text))
    td.dataset.disp = cellText(content)
    td.appendChild(content)
    td.addEventListener('keydown', (e) => onCellKey(e, view, this.block, wrap))
    td.addEventListener('paste', (e) => onCellPaste(e))
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
let pendingRefocus: { row: number; col: number; offset: number; anchor: number } | null = null

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
  const tableAt = (n: number): TableBlock | null => {
    const hit = tableCache.get(n)
    if (hit !== undefined) return hit
    const parsed = parseTableBlock(state.doc, n, endLine, state.doc.line(n).from)
    tableCache.set(n, parsed)
    return parsed
  }
  for (let n = 1; n <= endLine; n++) {
    const line = state.doc.line(n)
    ctx.claimed = []

    /*
     * --- 表格：整块识别，整块跳过 ---
     *
     * ⚠️ 表格的判定**不受围栏状态影响**：即使这一行落在某个 ``` 里面，也照样渲染成表格。
     *
     * 这不是疏忽，是两次实测事故换来的不变量：
     *
     *   用户把光标放到表格上方、敲下第 3 个反引号的那一瞬间，下面整张表就从 <table>
     *   变回一堆 `| 列名 | 类型 |` —— 内容其实没丢（删掉围栏行能逐字节复原，已验证），
     *   但屏幕上「表格被毁了」的观感足以让人不敢继续输入。
     *
     * 曾经试过更"聪明"的做法：只在全文找不到匹配闭围栏时才截断围栏。结果照样翻车 ——
     * 文档里别处有代码块时（长篇技术文档几乎必然有），那个远处的 ``` 会被当成闭围栏，
     * 于是判定「围栏已闭合」→ 表格照样被吞。判据依赖"远处有没有 ```"，用户根本
     * 无法预期，比不修更糟。
     *
     * 所以规则收敛成一句可预期的硬约定：**表格永远是表格，围栏吞不掉它**。
     * 代码行照旧按代码渲染，围栏状态也不因表格而改变 —— 不会连带影响表格之后的正文。
     *
     * 代价：没人能在围栏里展示"表格源码"（想展示就贴成截图或改缩进），
     * 与 markdown-it 导出在这一点上不一致。衡量过：这种情况罕见且无害，
     * 而表格被当场吞掉是每次写代码块都可能踩到的坑。
     */
    const block = tableAt(n)

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

    processLine(state, ctx, line.text, line.from, n)
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
  create: (state) => {
    // 新视图刚建好时**一定还没有焦点**。focusProxy 是模块级变量，会带着上一个
    // 视图的 true 值过来（比如切文档 / 换主题重建 EditorView）——
    // 那会让新文档光标所在处（通常是第 1 行行首）的语法标记被当成「有光标」直接露出来，
    // 与「打开已有文件不显示光标、也不显示原始语法」的约定相悖。
    // 真正聚焦时 cursorSync 会补发 setFocus 效果，这里只管起点正确。
    focusProxy = false
    return buildFrom(state)
  },
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
    // 先按锚点锁定「是哪一张表」：文档里两张表坐标完全可能一样，
    // 只按 data-row/col 找会把光标送到另一张表里（用错表比丢光标更糟）
    let wraps = Array.from(view.dom.querySelectorAll('.cm-md-table-wrap')) as HTMLElement[]
    if (target.anchor >= 0) {
      const same = wraps.filter((w) => w.dataset.tableStart === String(target.anchor))
      if (same.length > 0) wraps = same
    }
    for (const w of wraps) {
      const cell = w.querySelector(`[data-row="${target.row}"][data-col="${target.col}"]`)
      if (!cell) continue
      // 必须落到 `.cm-md-cell-content` 里：表头单元格的「+」按钮是内容的**兄弟节点**，
      // 直接 selectNodeContents(th) + collapse(false) 会把光标停在按钮后面，
      // 接着输入的字符就落在内容层之外，落盘时读不到 —— 表现为「输入的字消失」。
      focusCellNode(cell as HTMLElement, target.offset)
      break
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
