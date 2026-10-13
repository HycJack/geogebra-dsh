// 自检：跑 `node test/run.mjs`。零依赖，纯 Node。
//
// 覆盖的是**踩过坑的不变量**，不是行覆盖率 —— 每条断言都对应一个真实出现过的 bug
// 或一条容易悄悄破坏的约定。分两半：宿主半（工具、持久化、提示词）与客户端半
// （pane 注册、路由、错误拦截）。

import { apply } from '../src/host/index.js'
import {
  COMMAND_COUNT, extractCommandNames, suggestCommand, commandDocUrl,
  validateCommands, APP_PARAMETERS, VIEW_LETTERS, STANDARD_PERSPECTIVES,
} from '../src/host/catalog.js'
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
let group = ''

const section = (name) => { group = name; console.log(`\n== ${name} ==`) }
function ok(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ---------------------------------------------------------------------------
// 宿主半：一个最小 ctx，把插件挂起来

function hostHarness() {
  const apiRoutes = []
  const tools = []
  const sections = []
  const effect = (fn) => { fn(); return () => {} }
  apply({
    effect,
    get: () => undefined,
    connection: { fetch: { register: (route) => { apiRoutes.push(route); return async () => {} } } },
    inject: (deps, cb) => {
      const scope = { effect }
      if (deps.includes('webServer')) scope.webServer = { register: () => () => {} }
      if (deps.includes('tools')) scope.tools = { register: (t) => { tools.push(t); return () => {} } }
      if (deps.includes('systemPrompt')) scope.systemPrompt = { section: (s) => { sections.push(s); return () => {} } }
      cb(scope)
    },
  }, {})
  const call = async (endpoint, payload) => (await apiRoutes[0].fetch(new Request('http://x/', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const tool = (name) => tools.find((t) => t.name === name)
  const text = (name, value) => tool(name).output.render({}, value)[0].text
  return { apiRoutes, tools, sections, call, tool, text }
}

// ---------------------------------------------------------------------------
section('指令表与校验（离线）')

ok('指令表 549 条', COMMAND_COUNT === 549, String(COMMAND_COUNT))
ok('提取指令名：正常命令', JSON.stringify(extractCommandNames('Circle(A,3)')) === '["Circle"]')
ok('提取指令名：赋值不算命令', extractCommandNames('A=(1,2)').length === 0)
ok('提取指令名：函数定义不算', extractCommandNames('f(x)=x^2').length === 0)
ok('提取指令名：嵌套都取到',
  JSON.stringify(extractCommandNames('Circle(Midpoint(A,B),3)')) === '["Circle","Midpoint"]')
// 这条抓到过真 bug：字符串字面量里的内容被当成了指令名
ok('提取指令名：字符串里的内容要遮蔽',
  JSON.stringify(extractCommandNames('Text("Hi (there)",(1,2))')) === '["Text"]')
ok('拼错的指令能被识别', validateCommands(['Circl(A,3)']).unknown.length === 1)
ok('已定义的对象名不算未知', validateCommands(['myFunc(3)'], ['myFunc']).unknown.length === 0)
ok('建议给出最接近的', suggestCommand('Circl').includes('Circle'), suggestCommand('Circl').slice(0, 3).join('/'))
// 内置函数不是指令。把它们当拼错会挡住 f(x)=sin(x) —— 而这正是主打用法。
for (const c of ['C=(1,sqrt(3))', 'f(x)=sin(x)', 'h(x)=abs(x)+exp(x)', 'p1=floor(2.7)']) {
  ok(`内置函数不被误报：${c}`, validateCommands([c]).lines[0].unknown.length === 0)
}
// 但真正的拼写错误仍然要拦
ok('拼错仍然拦下', validateCommands(['Circl(A,3)']).unknown.length === 1)
// 没有相近指令的名字（多半是用户自己的对象）放行、只标存疑
const odd = validateCommands(['myOwnThing(3)'])[0] ?? validateCommands(['myOwnThing(3)'])
ok('无相近指令的名字放行并存疑', odd.unknown.length === 0 && odd.uncertain.length === 1)
ok('文档链接指向建议而非拼错的名字', commandDocUrl('Circle').endsWith('/commands/Circle/'))
ok('概率是 B 不是 P', VIEW_LETTERS.B.view.includes('Probability') && VIEW_LETTERS.P.view === 'Properties')
ok('3D 字母是 T、数字是 5',
  VIEW_LETTERS.T.view.includes('3D') && STANDARD_PERSPECTIVES['5'].label.includes('3D'))
ok('App 参数 ≥ 55 条', Object.keys(APP_PARAMETERS).length >= 55, `${Object.keys(APP_PARAMETERS).length} 条`)

// ---------------------------------------------------------------------------
section('宿主：注册与资源路径')

const h = hostHarness()
ok('注册了 7 个工具', h.tools.length === 7, h.tools.map((t) => t.name).join(','))
ok('每个工具都有 render 与 parameters',
  h.tools.every((t) => typeof t.output?.render === 'function' && t.parameters?.type === 'object'))
// 改名/搬目录之后最容易断的就是这条：资源必须相对包内解析
ok('GeoGebra 资源从包内 vendor 解析', (await h.call('info')).value.geogebra.dir.includes('vendor/GeoGebra'),
  (await h.call('info')).value.geogebra.dir)
ok('资源可用', (await h.call('info')).value.geogebra.available === true)

// ---------------------------------------------------------------------------
section('宿主：工作方式写在工具描述里（首次进入就靠它）')

const doDesc = h.tool('geogebra_do').description
ok('描述开头就是「先读懂题目」', doDesc.trimStart().startsWith('**先读懂题目'))
ok('要求一次性提交整张图', doDesc.includes('一次性提交整张图'))
ok('要求只重发出错的那几条', doDesc.includes('只重发出错的那几条'))
// 关掉错误弹窗之后，描述不能再承诺会给出错误原文
ok('不再承诺已经不存在的错误原文', !doDesc.includes('把 GeoGebra 的错误原文一并返回'))
ok('明说弹窗已关闭', doDesc.includes('错误弹窗已关闭'))

// ---------------------------------------------------------------------------
section('宿主：系统提示词只在用得到的地方注入')

const prompt = h.sections[0]
ok('注册了一个提示词段落', prompt?.name === 'geogebra-dsh:guidance')
ok('text 是按装配求值的函数', typeof prompt?.text === 'function')
const ctxOf = (id) => ({ agent: { session: { id } } })
// 没有任何 pane / 存档的会话 → 不注入（这是「别的会话不该背这段」那条要求）
ok('没开过 pane 的会话不注入', prompt.text(ctxOf('nobody')) === '')
ok('取不到会话 id 时不注入（fail closed）', prompt.text(undefined) === '')

// ---------------------------------------------------------------------------
section('宿主：持久化与清空')

const XML = '<geogebra><construction/></geogebra>'
ok('存档写进去', (await h.call('save-state', { key: 's1', xml: XML, perspective: '5' })).value.ok === true)
ok('读回来一致', (await h.call('load-state', { key: 's1' })).value.xml === XML)
ok('空内容被拒（避免抹掉好状态）',
  (await h.call('save-state', { key: 's1', xml: '' })).value.ok === false)
ok('被拒之后旧存档还在', (await h.call('load-state', { key: 's1' })).value.xml === XML)
ok('过大被拒', (await h.call('save-state', { key: 's1', xml: 'x'.repeat(3 * 1024 * 1024) })).value.ok === false)
ok('clear-state 真的抹掉', (await h.call('clear-state', { key: 's1' })).value.forgotten === true
  && (await h.call('load-state', { key: 's1' })).value === null)

// ---------------------------------------------------------------------------
section('宿主：导出真的写文件')

const tmp = mkdtempSync(join(tmpdir(), 'geogebra-dsh-'))
try {
  const pending = h.tool('geogebra_export').execute({ name: 'circle', dir: tmp })
  const polled = (await h.call('poll', {})).value.commands[0]
  await h.call('report', {
    id: polled.id, results: [], objects: [],
    export: { format: 'ggb', data: Buffer.from('GGBBYTES').toString('base64') },
  })
  const out = h.text('geogebra_export', await pending)
  ok('批次带上了 export 请求', polled.export?.format === 'ggb')
  ok('文件写出', existsSync(join(tmp, 'circle.ggb')))
  ok('内容与 base64 解码一致', readFileSync(join(tmp, 'circle.ggb')).toString() === 'GGBBYTES')
  const escaped = h.tool('geogebra_export').execute({ name: '../../etc/passwd', dir: tmp })
  const b2 = (await h.call('poll', {})).value.commands[0]
  await h.call('report', { id: b2.id, results: [], objects: [], export: { format: 'ggb', data: 'QUJD' } })
  await escaped
  ok('文件名净化，逃不出目录',
    !existsSync('/etc/passwd.ggb') && readdirSync(tmp).some((n) => n === 'etc-passwd.ggb'),
    readdirSync(tmp).join(' '))
} finally { rmSync(tmp, { recursive: true, force: true }) }

// ---------------------------------------------------------------------------
section('宿主：路由诊断能看出串会话')

await h.call('report', { id: 'x', session: 'sA', onScreen: 'sA', objects: [] })
const sameText = h.text('geogebra_state', await (async () => {
  const p = h.tool('geogebra_state').execute({})
  const b = (await h.call('poll', {})).value.commands[0]
  await h.call('report', { id: b.id, session: 'sA', onScreen: 'sA', objects: [] })
  return p
})())
ok('一致时说明「与屏幕一致」', sameText.includes('与屏幕一致'))

// ---------------------------------------------------------------------------
section('客户端半：pane 注册与按钮')

const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const pkgName = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name
const loadId = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(clientSrc)?.[1]
// 第一大坑：客户端注册 id 必须等于包名，否则 duplicate factory registration
ok('客户端注册 id 等于包名', loadId === pkgName, `${loadId} vs ${pkgName}`)
// pane 拿不到 sessionId 时按会话路由会整体退化成单例（跨会话画错面板的根因）
ok('pane 用 inject 拿到 sessionId', /inject:\s*\(sessionId\)\s*=>/.test(clientSrc))
ok('注册了 panel 图标（RSS 那一行）', clientSrc.includes("name: 'sidebar.panellist'"))
ok('注册了配对的空 main 座位', /name:\s*'main'/.test(clientSrc))
ok('tab 类型带 keepMounted（切会话不重载）', /keepMounted:\s*true/.test(clientSrc))
ok('工具栏有 2D / 3D / 函数', clientSrc.includes("perspective: '2'")
  && clientSrc.includes("perspective: '5'") && clientSrc.includes("perspective: '1'"))
ok('有打开文件与删除所有元素', clientSrc.includes('setBase64') && clientSrc.includes('newConstruction'))
// 这条对应真实 bug：mounted 未知时「随便取一个 pane」会把命令打到上一个会话
ok('不再「随便取一个已挂载的 pane」', !clientSrc.includes('[...map.values()][0]'))
ok('回报同时带 session 与 onScreen', clientSrc.includes('onScreen: currentSessionId'))

// ---------------------------------------------------------------------------
// 客户端半：真行为测试。
//
// 上面那些是源码级检查（「代码里有没有这一行」），证不了「跑起来会不会打错会话」。
// 这一段把 client.js 真的加载起来，喂假 applet，看命令落到谁身上 ——
// 串会话那个 bug 就是被这条抓到的。

section('客户端半：命令不会打到别的会话（行为）')

function clientHarness() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const scripted = []
  const reports = []
  const makeApplet = (tag) => {
    const log = []
    // 一个已存在的对象 A，外加它的样式 —— 用来验证「返回值说失败、样式却变了」。
    const styles = new Map([['A', '0,0,0']])
    return {
      tag, log, styles,
      evalCommand: (c) => {
        log.push(c)
        // 实测：SetColor 改动了 XML，evalCommand 却返回 false。
        const m = /^SetColor\(\s*([A-Za-z0-9_]+)\s*,/.exec(c)
        if (m) { styles.set(m[1], '255,0,0'); return false }
        return true
      },
      getObjectNumber: () => 1,
      getObjectName: () => 'A',
      getCommandString: () => 'A=(1,2)', getValueString: () => '(1,2)',
      getColor: (n) => styles.get(n) ?? '0,0,0',
      getLineThickness: () => 5, getPointSize: () => 4, getFilling: () => 0,
      getXML: () => `<ggb>${tag}</ggb>`,
      setXML() {}, setPerspective() {}, newConstruction() {},
      registerAddListener() {}, registerRemoveListener() {}, registerUpdateListener() {},
    }
  }
  const applet = makeApplet('s1')
  const doc = { body: {}, querySelector: () => null }
  const frame = {
    contentWindow: { ggbApplet: applet },
    contentDocument: { querySelector: (s) => (s === '#applet iframe'
      ? { contentWindow: { ggbApplet: applet }, contentDocument: doc } : null) },
  }
  const state = { mounted: 's1', openTabCalls: 0 }
  const win = {
    __ModuleLoader__: { load: (def) => { win.__def = def } },
    addEventListener() {}, removeEventListener() {},
    location: { origin: 't://x' }, setTimeout, clearTimeout,
    __geogebraFrames: new Map([['s1', frame]]),
    __geogebraFrameSessions: new Map([[frame, 's1']]),
    __geogebraFrame: frame,
  }
  const fakeDoc = {
    head: { appendChild() {} }, body: { appendChild() {}, removeChild() {} },
    createElement: () => ({ dataset: {}, textContent: '', remove() {}, click() {} }),
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {}, useRef: () => ({ current: null }),
  }
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.endpoint === 'poll') {
      const commands = scripted.splice(0, scripted.length)
      return { json: async () => ({ ok: true, value: { commands } }) }
    }
    if (body.endpoint === 'report') { reports.push(body.payload); return { json: async () => ({ ok: true, value: { ok: true } }) } }
    if (body.endpoint === 'load-state') return { json: async () => ({ ok: true, value: null }) }
    return { json: async () => ({ ok: true, value: { ok: true } }) }
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  const previous = { window: globalThis.window, document: globalThis.document, MutationObserver: globalThis.MutationObserver }
  globalThis.window = win
  globalThis.document = fakeDoc
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', source)(win, fakeDoc, { log() {} }, setTimeout, clearTimeout)
  const factory = win.__def.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  factory.apply({
    effect: (fn) => { fn() },
    slots: { inject: (_n, cb) => cb(), register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTab: () => { state.openTabCalls += 1 }, mounted: { getSnapshot: () => state.mounted } },
    layout: {
      openRightbar: () => {},
      panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} },
      selectPanel: () => {},
    },
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
    get: () => undefined,
  })
  return {
    applet, reports, state, scripted,
    get styleVerdict() {
      const r = reports.flatMap((x) => x.results ?? []).find((x) => x.command?.startsWith('SetColor'))
      return r
    },
    restore() {
      globalThis.fetch = originalFetch
      globalThis.window = previous.window
      globalThis.document = previous.document
      globalThis.MutationObserver = previous.MutationObserver
    },
  }
}

const ch = clientHarness()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const lastReport = () => ch.reports.filter((r) => r.results?.length).at(-1)
try {
  // 1) 屏幕上是 s1，命令应当落在 s1
  ch.scripted.push({ id: 'r1', commands: ['A=(1,2)'] })
  await sleep(2200)
  ok('屏幕上是 s1 → 命令打到 s1', ch.applet.log.includes('A=(1,2)'), JSON.stringify(ch.applet.log))
  ok('回报里 session 与 onScreen 一致',
    lastReport()?.session === 's1' && lastReport()?.onScreen === 's1',
    `session=${lastReport()?.session} onScreen=${lastReport()?.onScreen}`)

  // 2) 样式指令：GeoGebra 返回 false，但样式确实变了（已用导出的 XML 核实）。
  //    只看那个布尔会把它判成失败，模型就会徒劳地反复重试。
  ch.scripted.push({ id: 'r2', commands: ['SetColor(A,"red")'] })
  await sleep(2200)
  ok('样式指令返回 false 但样式变了 → 仍算成功',
    ch.styleVerdict?.ok === true && ch.styleVerdict?.accepted === false,
    JSON.stringify(ch.styleVerdict))

  // 3) mounted = undefined 正是「刚切过去、新会话 store 还没 mint」的那一瞬间。
  //    旧代码在这里会 return 任意一个已挂载的 pane —— 也就是用户刚离开的那个。
  const before = ch.applet.log.length
  ch.state.mounted = undefined
  ch.state.openTabCalls = 0
  ch.scripted.push({ id: 'r3', commands: ['B=(3,4)'] })
  await sleep(2600)
  ok('mounted 未知时绝不打到旧会话', ch.applet.log.length === before,
    `s1 又收到 ${ch.applet.log.length - before} 条`)
  ok('转而去为当前会话开正确的 pane', ch.state.openTabCalls > 0, String(ch.state.openTabCalls))
} finally { ch.restore() }

// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(46)}`)
console.log(`通过 ${passed} / 失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
