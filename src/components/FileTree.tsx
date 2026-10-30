import { useState } from 'react'
import { ChevronRight, ChevronDown, FileText, Folder, FolderOpen } from 'lucide-react'
import { useStore } from '../state/store'
import type { FileNode } from '../lib/types'
import { ContextMenu, ConfirmDialog, NameDialog, type MenuEntry } from './TreeMenu'

/**
 * 单个目录 / 文件节点。
 *
 * ⚠️ 这个组件**必须定义在模块级**，不能写在 FileTree 函数体内部。
 *
 * 原因：写在函数体里时，每次 FileTree 重渲染都会得到一个**全新的组件类型**，
 * React 认为「原来的组件没了，换了个新组件」，于是卸载并重建整棵子树的 DOM。
 * 而 click 事件要求 mousedown 与 mouseup 落在**同一个元素**上 ——
 * 用户按下鼠标时节点还是旧的、松手时已被替换，浏览器就不会派发 click。
 * 表现就是「有些行点不进去，得点两三次」，且偶发、越靠下的行越明显
 * （它们在重建时更可能落在被换掉的节点上）。
 *
 * 附带好处：DOM 不再每次重建，hover 状态与滚动位置不会被吃掉。
 */

/**
 * 缩进封顶值。
 *
 * 侧栏最窄 140px，缩进按 13px/层算，封到 5 层 = 75px，
 * 剩下的宽度足够显示并点击文件名。再深的层级不再继续右移，
 * 否则深目录下的条目会被挤成一条点不中的缝。
 */
const MAX_INDENT_DEPTH = 5

/** 右键菜单的目标：路径、名字、是不是目录，以及它所在的父目录 */
export interface MenuTarget {
  path: string
  name: string
  isDir: boolean
  parent: string
}

function TreeNode({
  node,
  depth = 1,
  parentPath,
  onMenu,
}: {
  node: FileNode
  depth?: number
  /** 本节点所在目录的路径 —— 「在此处新建」要用它 */
  parentPath: string
  onMenu: (e: React.MouseEvent, target: MenuTarget) => void
}) {
  const isOpen = useStore((s) => Boolean(s.expanded[node.path]))
  // 只订阅「当前激活文档的路径」这一个原始值，而不是整个 tabs 数组：
  // 文档内容每次按键都会变，订阅整个数组会让所有可见节点跟着重渲染。
  const activePath = useStore((s) => {
    const t = s.tabs.find((x) => x.id === s.active)
    return t?.path ?? null
  })
  const isActive = !node.isDir && activePath === node.path
  const children = useStore((s) => s.dirs[node.path])
  const toggleExpand = useStore((s) => s.toggleExpand)
  const openFile = useStore((s) => s.openFile)

  // CSS 变量走内联 style：缩进要按**封顶后的**深度算，所以只能在 JS 里夹。
  const indent = { '--d': Math.min(depth, MAX_INDENT_DEPTH) } as React.CSSProperties

  const onCtx = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation() // 别让事件冒到容器上被当成「点在空白处」
    onMenu(e, { path: node.path, name: node.name, isDir: node.isDir, parent: parentPath })
  }

  if (node.isDir) {
    return (
      <div className="tree-node">
        <div
          className="tree-row"
          style={indent}
          onClick={() => toggleExpand(node.path)}
          onContextMenu={onCtx}
          role="treeitem"
          aria-expanded={isOpen}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              toggleExpand(node.path)
            }
          }}
        >
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
          <span>{node.name}</span>
        </div>
        {isOpen && (
          <div className="tree-children" role="group">
            {(children || []).map((c) => (
              <TreeNode
                key={c.path}
                node={c}
                depth={depth + 1}
                parentPath={node.path}
                onMenu={onMenu}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className={`tree-row file${isActive ? ' active' : ''}`}
      style={indent}
      onClick={() => void openFile(node.path, node.name)}
      onContextMenu={onCtx}
      role="treeitem"
      aria-selected={isActive}
      tabIndex={0}
      title={node.name}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          void openFile(node.path, node.name)
        }
      }}
    >
      <FileText size={14} />
      <span>{node.name}</span>
    </div>
  )
}

// 左侧栏「文件」页签：工作区目录树（懒加载）
//
// 展示规则：**只列出受支持的纯文本类型**（见 lib/filetype.ts），目录永远保留
// —— 否则用户没法进入子目录，也就没法找到里面支持的文件。
// 白名单外的条目（.class / .png / .jar）根本不列出来：让用户点到再告诉他
// 「不支持」，不如不让他点。（原先有个「显示全部文件」的眼睛开关，已按需求去掉。）
//
// 右键菜单：新建文件（默认 .md）/ 新建文件夹 / 重命名 / 打开文件位置 / 删除。
// 新建、重命名与删除都**直接落盘**，不是只改内存 —— 见 store 的
// createEntry / renameEntry / deleteEntry。
export function FileTree() {
  const rootPath = useStore((s) => s.rootPath)
  const rootName = useStore((s) => s.rootName)
  const rootOpen = useStore((s) => Boolean(s.rootPath && s.expanded[s.rootPath]))
  const rootChildren = useStore((s) => (s.rootPath ? s.dirs[s.rootPath] : undefined))
  const toggleExpand = useStore((s) => s.toggleExpand)
  const openFolder = useStore((s) => s.openFolder)
  const createEntry = useStore((s) => s.createEntry)
  const deleteEntry = useStore((s) => s.deleteEntry)
  const renameEntry = useStore((s) => s.renameEntry)
  const revealEntry = useStore((s) => s.revealEntry)

  // 右键菜单：坐标 + 目标
  const [menu, setMenu] = useState<(MenuTarget & { x: number; y: number }) | null>(null)
  // 当前弹窗：新建文件 / 新建文件夹 / 重命名 / 删除确认
  const [dialog, setDialog] = useState<
    { kind: 'file' | 'dir' | 'rename' | 'delete'; parent: string; target?: MenuTarget } | null
  >(null)

  if (!rootPath) {
    // 按需求：空态只留一个「打开文件夹」按钮，不做任何文字说明。
    // Typora 左侧栏无工作区时也是极简的，文字提示反而像在教用户。
    return (
      <div className="sidebar-empty">
        <button className="ghost-btn" onClick={() => void openFolder()}>
          <FolderOpen size={14} /> 打开文件夹
        </button>
      </div>
    )
  }

  const openMenu = (e: React.MouseEvent, target: MenuTarget) => {
    setMenu({ ...target, x: e.clientX, y: e.clientY })
  }

  // 根目录行：右键目标就是根目录本身，「新建」都建在工作区里
  const rootTarget: MenuTarget = {
    path: rootPath,
    name: rootName ?? rootPath,
    isDir: true,
    parent: rootPath,
  }

  // 容器上的右键 = 点在了空白处 → 同样以工作区根目录为目标
  const onBlankContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    openMenu(e, rootTarget)
  }

  const menuItems: MenuEntry[] = menu
    ? (() => {
        const items: MenuEntry[] = [
          {
            label: '新建文件',
            onSelect: () =>
              // 右键目录 → 建在它里面；右键文件 → 建在它旁边
              setDialog({ kind: 'file', parent: menu.isDir ? menu.path : menu.parent }),
          },
          {
            label: '新建文件夹',
            onSelect: () =>
              setDialog({ kind: 'dir', parent: menu.isDir ? menu.path : menu.parent }),
          },
        ]
        // 工作区根目录不允许重命名：会打乱 rootPath 与所有已缓存路径
        const canRename = menu.path !== rootPath
        if (canRename) {
          items.push({
            label: '重命名',
            sep: true,
            onSelect: () => setDialog({ kind: 'rename', parent: menu.parent, target: menu }),
          })
        }
        items.push(
          {
            label: '打开文件位置',
            // 没有「重命名」时靠这条分隔线把新建组与定位/删除分开
            sep: !canRename,
            onSelect: () => void revealEntry(menu.path),
          },
          {
            label: '删除',
            sep: true,
            danger: true,
            onSelect: () => setDialog({ kind: 'delete', parent: menu.parent, target: menu }),
          }
        )
        return items
      })()
    : []

  return (
    // 结构说明：滚动区占满剩余高度；原先贴在底部的「显示全部文件」开关已移除。
    <div className="tree-pane">
      <div className="tree-scroll" onContextMenu={onBlankContextMenu}>
        <div className="tree" role="tree">
          <div
            className="tree-row"
            onClick={() => toggleExpand(rootPath)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              openMenu(e, rootTarget)
            }}
            role="treeitem"
            aria-expanded={rootOpen}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggleExpand(rootPath)
              }
            }}
          >
            {rootOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Folder size={14} />
            <span className="root-name">{rootName}</span>
          </div>
          {rootOpen && (
            <div className="tree-children" role="group">
              {(rootChildren || []).map((c) => (
                <TreeNode key={c.path} node={c} parentPath={rootPath} onMenu={openMenu} />
              ))}
            </div>
          )}
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}

      {dialog?.kind === 'file' && (
        <NameDialog
          title="新建文件"
          hint="不写扩展名会自动补 .md"
          defaultValue="未命名.md"
          confirmText="创建"
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            const parent = dialog.parent
            setDialog(null)
            void createEntry(parent, name, false)
          }}
        />
      )}

      {dialog?.kind === 'dir' && (
        <NameDialog
          title="新建文件夹"
          defaultValue="新建文件夹"
          confirmText="创建"
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            const parent = dialog.parent
            setDialog(null)
            void createEntry(parent, name, true)
          }}
        />
      )}

      {dialog?.kind === 'rename' && dialog.target && (
        <NameDialog
          title={dialog.target.isDir ? '重命名文件夹' : '重命名文件'}
          hint="改名会直接作用到磁盘，扩展名可一并修改"
          defaultValue={dialog.target.name}
          confirmText="重命名"
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            const t = dialog.target as MenuTarget
            const parent = dialog.parent
            setDialog(null)
            void renameEntry(t.path, t.isDir, parent, name)
          }}
        />
      )}

      {dialog?.kind === 'delete' && dialog.target && (
        <ConfirmDialog
          title={dialog.target.isDir ? '删除文件夹' : '删除文件'}
          confirmText="删除"
          body={
            dialog.target.isDir ? (
              <>
                将删除文件夹「{dialog.target.name}」及其全部内容。
                磁盘上的文件会一起删除，且无法撤销。
              </>
            ) : (
              <>
                将删除文件「{dialog.target.name}」。磁盘上的文件会一起删除，且无法撤销。
              </>
            )
          }
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const t = dialog.target as MenuTarget
            const parent = dialog.parent
            setDialog(null)
            void deleteEntry(t.path, t.isDir, parent)
          }}
        />
      )}
    </div>
  )
}
