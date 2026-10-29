// Guard against the NPM / Rust version drift that kills `tauri build`.
//
// Tauri's CLI refuses to build when an NPM plugin package and its Rust crate
// are on different major/minor releases:
//
//   Found version mismatched Tauri packages.
//   tauri-plugin-updater (v2.13.3) : @tauri-apps/plugin-updater (v2.14.1)
//
// The trap is that `Cargo.toml` says `"2"` and `package.json` used to say
// `"^2.13.2"`: Cargo resolves against the committed Cargo.lock (stable), while
// npm resolves against the live registry (moves under your feet). Our CI even
// deletes package-lock.json on purpose, so a caret range means "whatever is
// newest on release day". v0.3.14 shipped into exactly that wall.
//
// So: all @tauri-apps/* must be *exact* versions, aligned with Cargo.lock.
// Run this before tagging a release (CI runs it too).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(rel) {
  try {
    return JSON.parse(readFileSync(join(root, rel), 'utf8'))
  } catch {
    return null
  }
}

function readCargoLock() {
  let text
  try {
    text = readFileSync(join(root, 'src-tauri', 'Cargo.lock'), 'utf8')
  } catch {
    return null
  }
  const crates = new Map()
  for (const block of text.split('[[package]]')) {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(block)
    if (name && version) crates.set(name[1], version[1])
  }
  return crates
}

// @tauri-apps/api  -> tauri
// @tauri-apps/plugin-x -> tauri-plugin-x
function crateFor(npmName) {
  const short = npmName.replace(/^@tauri-apps\//, '')
  if (short === 'api') return 'tauri'
  if (short.startsWith('plugin-')) return `tauri-plugin-${short.slice('plugin-'.length)}`
  return '' // @tauri-apps/cli has no Rust counterpart
}

const majorMinor = (v) => (v || '').split('.').slice(0, 2).join('.')

const pkg = readJson('package.json')
if (!pkg) {
  console.error('check-tauri-versions: package.json not found')
  process.exit(1)
}
const crates = readCargoLock()
if (!crates) {
  console.warn('check-tauri-versions: src-tauri/Cargo.lock not found, skipping crate comparison')
  process.exit(0)
}

const declared = { ...pkg.dependencies, ...pkg.devDependencies }
const rows = []
const errors = []
const stale = []

for (const [name, range] of Object.entries(declared)) {
  if (!name.startsWith('@tauri-apps/')) continue

  // Root cause #1: a floating range means npm picks the newest release at
  // install time, so the pair silently desynchronises between releases.
  const exact = /^\d+\.\d+\.\d+$/.test(range)
  if (!exact) {
    errors.push(`${name}: 必须写精确版本（当前 "${range}"），CI 会删 lock 重新解析，^ / ~ 会漂到最新版`)
  }

  const installed = readJson(join('node_modules', name, 'package.json'))
  const npmVersion = installed?.version || null
  const crate = crateFor(name)
  const crateVersion = crate ? crates.get(crate) || null : null

  // 以「声明版本」为准：CI 会删 lock 全新安装，届时声明什么就装什么。
  // 声明不是精确版本时退回已装版本，只为把表打全（错误已在上一条记下）。
  const effective = exact ? range : npmVersion
  const ok =
    !crate ||
    (effective && crateVersion && majorMinor(effective) === majorMinor(crateVersion))

  if (!ok) {
    const tag = exact ? '声明' : '已装'
    errors.push(
      `${name} (${tag} ${effective ?? '未知'}${installed ? '' : '，未安装'}) 与 crate ${crate} (${crateVersion ?? '缺失'}) 的 major.minor 不一致`,
    )
  }

  rows.push({
    npm: name,
    npmVersion: effective ?? '-',
    crate: crate || '-',
    crateVersion: crateVersion || '-',
    ok,
  })

  if (exact && npmVersion && npmVersion !== effective) {
    stale.push(`${name}: 声明 ${effective}，node_modules 里是 ${npmVersion} —— 本地跑一次 npm install`)
  }
}

const pad = (s, n) => String(s).padEnd(n)
console.log('\n@tauri-apps NPM 包 ←→ src-tauri/Cargo.lock')
console.log('-'.repeat(74))
console.log(pad('NPM 包', 32), pad('npm', 10), pad('crate', 26), 'cargo')
console.log('-'.repeat(74))
for (const r of rows) {
  console.log(pad(r.npm, 32), pad(r.npmVersion, 10), pad(r.crate, 26), r.crateVersion, r.ok ? '' : '  ✗')
}
console.log('-'.repeat(74))
console.log('注：只比较 major.minor（Tauri 自身的校验规则），@tauri-apps/cli 无对应 crate。\n')

if (stale.length) {
  console.warn('提示（不影响构建，CI 里是全新安装）：')
  for (const s of stale) console.warn(`  · ${s}`)
  console.warn('')
}

if (errors.length) {
  console.error('版本不一致，`tauri build` 会直接失败：\n')
  for (const e of errors) console.error(`  ✗ ${e}`)
  console.error('\n修法：把 package.json 里的 @tauri-apps/* 改成精确版本，')
  console.error('并与 src-tauri/Cargo.lock 里对应 crate 的 major.minor 对齐；')
  console.error('或反过来 cargo update 升级 Rust 侧（两边必须同一步调）。\n')
  process.exit(1)
}

console.log('✓ 版本一致\n')
