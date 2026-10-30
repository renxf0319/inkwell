/**
 * 有序列表重编号的纯逻辑（不依赖 CodeMirror 运行时）。
 *
 * 单独拆出来是为了能直接在 Node 里用 `Text` 跑用例 —— 插件层只负责
 * 「什么时候调用它」，这里只负责「该改成什么」。
 */

/** 只用到 Text 的这几个成员，按结构类型声明，避免把 @codemirror/state 拖进来 */
export interface DocLike {
  readonly length: number
  readonly lines: number
  lineAt(pos: number): LineLike
  line(n: number): LineLike
}

export interface LineLike {
  readonly number: number
  readonly from: number
  readonly text: string
}

export interface NumChange {
  from: number
  to: number
  insert: string
}

// 与 wysiwyg.ts 的 OL_RE 同一条规则：缩进 + 数字 + `.`/`)` + 空白
export const OL_RE = /^(\s*)(\d{1,9})([.)])(\s+)/

/**
 * 计算「pos 所在的那段有序列表」需要修正的序号。
 * 返回空数组表示不需要改动（或 pos 处不是有序列表项）。
 *
 * 规则：
 *  - 只处理**同缩进**的连续列表项，嵌套层级各自成段；
 *  - 起始编号取该段第一项现有的数字（保留「从 3 开始」的意图）；
 *  - 只替换数字本身，`.`/`)` 与缩进原样保留。
 */
export function renumberAt(doc: DocLike, pos: number): NumChange[] {
  if (doc.length === 0) return []
  const p = Math.max(0, Math.min(pos, doc.length))
  const line = doc.lineAt(p)
  const hit = OL_RE.exec(line.text)
  if (!hit) return []
  const indent = hit[1]

  // 向上找同缩进连续列表项的起点
  let start = line.number
  while (start > 1) {
    const prev = doc.line(start - 1)
    const pm = OL_RE.exec(prev.text)
    if (!pm || pm[1] !== indent) break
    start--
  }
  // 向下找终点
  let end = line.number
  while (end < doc.lines) {
    const next = doc.line(end + 1)
    const nm = OL_RE.exec(next.text)
    if (!nm || nm[1] !== indent) break
    end++
  }

  const first = OL_RE.exec(doc.line(start).text)
  if (!first) return []
  let n = parseInt(first[2], 10)
  if (!Number.isFinite(n)) return []

  const changes: NumChange[] = []
  for (let ln = start; ln <= end; ln++) {
    const L = doc.line(ln)
    const m = OL_RE.exec(L.text)
    if (!m) continue
    const want = String(n)
    if (m[2] !== want) {
      const from = L.from + m[1].length
      changes.push({ from, to: from + m[2].length, insert: want })
    }
    n++
  }
  return changes
}
