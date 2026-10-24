import { useEffect, useRef } from 'react'
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { tags } from '@lezer/highlight'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { useStore } from '../state/store'
import { livePreview, lineToPos } from '../lib/wysiwyg'
import { fenceLangCompletion } from '../lib/fenceLang'
import { slashCompletion } from '../lib/slash'
import { isMarkdownFile, isCodeFile } from '../lib/filetype'

/**
 * 覆盖 defaultHighlightStyle 里「标题带下划线」的规则。
 *
 * 根因：@codemirror/language 的 defaultHighlightStyle 给 tags.heading 设了
 * `textDecoration: "underline"`（源码 index.js 里明写着），而 Markdown 解析器
 * 会给标题打上 tags.heading —— 于是每个标题文字下方都有一条下划线。
 * 它不是我们 CSS 写的，所以改 global.css 没用，必须在 highlight 层覆盖。
 *
 * ⚠️ 顺序很关键：HighlightStyle.define 里**后写的规则覆盖先写的**，
 * 所以覆盖项必须放在 defaultHighlightStyle.specs **之后**，
 * 放前面会被后面的默认 heading 规则压回去（下划线又回来）。
 */
const koreHighlightStyle = HighlightStyle.define([
  ...defaultHighlightStyle.specs,
  { tag: tags.heading, textDecoration: "none", fontWeight: "bold" },
])

const themeCompartment = new Compartment()

/**
 * 按文件类型选择编辑模式。
 *
 * Markdown（.md/.markdown/.mdown 与未命名新文档）走 WYSIWYG：装饰引擎隐藏语法标记。
 * 代码（.js/.ts/.jsx/.tsx…）走 javascript()：有语法树，关键字/字符串/注释自动着色，
 *   且**不装** livePreview —— 代码里的 `#`（私有字段）、`*`（指针解引用）不是标记语法，
 *   被装饰引擎隐藏就等于毁掉源码。
 * 其它纯文本类型（.sql/.yaml/.conf/.properties/.txt…）**必须**走 plain：
 * 若给它们套上 Markdown 规则，`# comment` 整行会被当标题隐藏、`*`、`_`、`- `
 * 会被当强调/列表标记吃掉 —— 用户看到的就不是原文，而是「乱码」。
 */
function langExtension(nameOrPath: string | null): Extension {
  if (isMarkdownFile(nameOrPath)) return [markdown(), livePreview()]
  if (isCodeFile(nameOrPath)) {
    // javascript() 同时覆盖 js/jsx/ts/tsx（TS 关键字由 TS 插件识别），
    // 不需要为 .ts 单独开一套配置
    return javascript({ jsx: true, typescript: true })
  }
  return []
}

export default function Editor() {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const active = useStore((s) => s.active)
  const theme = useStore((s) => s.theme)
  const updateContent = useStore((s) => s.updateContent)
  const save = useStore((s) => s.save)
  const saveAs = useStore((s) => s.saveAs)
  const newDoc = useStore((s) => s.newDoc)
  const jumpLine = useStore((s) => s.jumpLine)
  const setJumpLine = useStore((s) => s.setJumpLine)

  useEffect(() => {
    if (!host.current) return
    const tab = useStore.getState().tabs.find((t) => t.id === active)
    const doc = tab?.content ?? ''
    const id = active
    // 未命名文档（path 为 null）按 Markdown 处理
    const mdMode = isMarkdownFile(tab?.path ?? null)
    const codeMode = isCodeFile(tab?.path ?? null)
    const asMarkdown = langExtension(tab?.path ?? null)
    // 纯文本模式换等宽字体：SQL / YAML / properties 都靠缩进与对齐表达结构，
    // 用正文字体渲染会让层次全糊在一起。代码文件同理，且额外用深色底衬托代码块。
    const contentClass = mdMode
      ? 'cm-typora-content'
      : codeMode
        ? 'cm-code-content'
        : 'cm-plain-content'

    const state = EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        /*
         * ⚠️ 这里**故意不装** drawSelection()，换来的原生选区是刻意的取舍。
         *
         * drawSelection 把选区画在 `.cm-selectionLayer` 里，而这一层是 z-index:-2 ——
         * 在内容层**下面**。凡是内容里带不透明底色的东西（代码块、行内代码、==高亮==），
         * 都会把选区盖住：选中代码块里的几行，屏幕上只剩左右两侧 content padding 上的
         * 两条紫边，正文区域一片白，用户直接反馈「无法选中代码块里的内容」。
         *
         * 同时它还装了一份 hideNativeSelection，用 !important 把原生选区刷成透明，
         * 于是全局那条 `::selection { background: var(--selection) }` 从来没生效过，
         * 真正画出来的是 CodeMirror 自己的默认色（浅色 #d7d4f0；深色要 .cm-dark 才切到 #233）——
         * 跟本项目的明暗两套设计令牌完全两套色。
         *
         * 原生选区的绘制顺序天生正确（底色 < 选区 < 文字），且直接用 --selection，
         * 一处改动同时解决「盖住」和「配色不对」。
         * 代价：多光标/矩形选区的次要选区不再单独画出（它们极少用，主选区仍正常）。
         */
        history(),
        rectangularSelection(),
        crosshairCursor(),
        highlightSelectionMatches(),
        // Markdown 解析 / WYSIWYG 装饰，或纯文本模式（二选一）
        asMarkdown,
        syntaxHighlighting(koreHighlightStyle, { fallback: true }),
        // 输入 ``` 后提示语言标识符（认不全也能选）
        closeBrackets(),
        // 纯文本模式下不装围栏补全：`.sql` 里的 ``` 只是普通字符，
        // 弹候选框反而是干扰
        ...(mdMode
          ? [
              autocompletion({
                override: [slashCompletion, fenceLangCompletion],
                activateOnTyping: true,
                // 行内已经有完整单词（如写了 `java` 之外的正文）时不打扰
                defaultKeymap: true,
              }),
            ]
          : codeMode
            ? [
                // 代码模式用 javascript() 自带的补全源（关键字 / 成员 / 文档内标识符），
                // 不像 Markdown 那样要 override 掉默认源
                autocompletion({ activateOnTyping: true }),
              ]
            : []),
        themeCompartment.of(theme === 'dark' ? oneDark : []),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...completionKeymap,
          indentWithTab,
          { key: 'Mod-s', preventDefault: true, run: () => (void save(), true) },
          { key: 'Mod-shift-s', preventDefault: true, run: () => (void saveAs(), true) },
          { key: 'Mod-n', preventDefault: true, run: () => (newDoc(), true) },
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && id) updateContent(id, u.state.doc.toString())
        }),
        EditorView.lineWrapping,
        // 编辑区在 Typora 里是居中的窄栏，两侧留白
        EditorView.contentAttributes.of({ class: contentClass }),
      ],
    })

    const view = new EditorView({ state, parent: host.current })
    viewRef.current = view
    // 只在「空文档」时自动聚焦；打开已有文件不聚焦。
    // - 打开已有 md：用户要求编辑区**不显示光标**（原来 focus() 让光标停在
    //   第一个字符并闪烁）。不聚焦 → CodeMirror 未激活，selection 不渲染。
    //   用户点击编辑区后自动聚焦并显示光标，与 Typora 一致。
    // - 空文档（启动时的未命名页）：Typora 是直接可输入的，所以要聚焦。
    if (!doc) setTimeout(() => view.focus(), 0)
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 仅依赖 active / theme：切换文档或主题时重建视图。
    // updateContent 会改变 tabs，但绝不能进依赖数组，否则每次按键都重建视图（光标跳动）。
  }, [active, theme])

  // 大纲跳转：按行号定位光标并滚动到该行
  useEffect(() => {
    if (jumpLine == null) return
    const view = viewRef.current
    if (!view) return
    const pos = lineToPos(view.state, jumpLine)
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }),
    })
    view.focus()
    setJumpLine(null)
  }, [jumpLine, setJumpLine])

  return <div className="editor-host" ref={host} />
}
