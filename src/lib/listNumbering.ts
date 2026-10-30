import { type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import { renumberAt } from './listNumberingCore'

/**
 * 有序列表自动重编号（CodeMirror 插件层）。
 *
 * 需求：`1. / 2. / 3.` 里删掉第 2 项后，原来的「3.」应自动变成「2.」。
 * Typora 的行为是「序号跟着位置走」，而不是写死在文本里。
 *
 * 触发条件被刻意收得很窄：
 *  - **只有删除导致行数变少**时才重排。每次按键都重排的话，用户手打 `5.`
 *    会被立刻改回 `1.`，反而没法用了；
 *  - 只重排**删除位置所在的那一段同缩进列表**。嵌套列表各自成段，互不影响；
 *  - 起始值取该段第一项现有的数字 —— 保留用户「从 3 开始编号」的意图。
 *
 * 之所以延迟到下一个任务再 dispatch：CodeMirror 不允许在一次 update 进行中
 * 再次 dispatch（会抛 "update is not allowed while an update is in progress"）。
 */
export function orderedListRenumber(): Extension {
  return ViewPlugin.fromClass(
    class {
      private pending = false

      constructor(private view: EditorView) {}

      update(u: ViewUpdate) {
        if (!u.docChanged) return
        // 行数没变少（输入、改字、加行）→ 不介入
        if (u.state.doc.lines >= u.startState.doc.lines) return

        // 取第一处改动在新文档里的起点。删整行后它正好落在下一行行首，
        // 也就是「原 3.」那一行的起点。
        let pos = -1
        u.changes.iterChanges((_fromA, _toA, fromB) => {
          if (pos < 0) pos = fromB
        })
        if (pos < 0) return

        if (this.pending) return
        this.pending = true
        setTimeout(() => {
          this.pending = false
          const view = this.view
          // 代码块里的 `1. xxx` 是源码，不是列表 —— 不能重排。
          // 用 Markdown 语法树判断，比数反引号可靠（能认 ~~~、缩进代码块等）。
          const node = syntaxTree(view.state).resolveInner(pos, 1)
          for (let n: SyntaxNode | null = node; n; n = n.parent) {
            if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'CodeText') {
              return
            }
          }
          const changes = renumberAt(view.state.doc, pos)
          if (changes.length === 0) return
          view.dispatch({ changes })
        }, 0)
      }
    }
  )
}
