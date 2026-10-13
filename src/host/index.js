// geogebra-dsh · host half
//
// Three jobs:
//
//  1. A tiny facts endpoint on the shared /api channel (`/api/geogebra-dsh`), the
//     same shape ds-bot uses — the browser authenticates with its session cookie.
//  2. A static route serving a local GeoGebra build, plus the embed page the pane
//     iframes. GeoGebra loads its own assets by *relative* URL, so the assets need
//     a whole prefix, not one exact path.
//  3. A bridge that lets the agent draw on that GeoGebra and hear what the user
//     changed by hand. The applet lives in the browser, so the host keeps a queue
//     of commands and a mirror of the construction; the browser half polls for
//     work and reports back. Tools are registered over that bridge.
//
// On the static route: `ctx.connection.fetch.register` matches exact pathnames
// only (`fetchRoutes.get(url.pathname)`), so it cannot serve a directory tree.
// `ctx.webServer.register` can: a `kind: 'prefix'` route is matched by longest
// prefix, which is exactly what a 440-file app tree needs.
//
// Plain JavaScript on purpose. DSH loads a bundle entry by importing the package's
// `main`; a `.ts` entry that lands in the profile's node_modules cannot be loaded,
// because Node refuses to strip types for files under node_modules:
//
//   Stripping types is currently unsupported for files under node_modules
//
// Shipping .js keeps the plugin loadable straight from node_modules, with no build
// step and no loader configuration.

import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APP_PARAMETERS,
  COMMAND_COUNT,
  COMMAND_DOCS_BASE,
  PERSPECTIVE_SYNTAX,
  STANDARD_PERSPECTIVES,
  VIEW_LETTERS,
  commandDocUrl,
  suggestCommand,
  validateCommands,
} from './catalog.js'

export const name = 'geogebra-dsh'
// `connection` serves the facts endpoint. `webServer` and `tools` are injected
// optionally below: both exist in the Web composition, but the plugin must not
// refuse to activate without them (see the ctx.inject calls in apply).
export const inject = ['connection']

const ROUTE = '/api/geogebra-dsh'
const GGB_PREFIX = '/geogebra-dsh-ggb'
const EMBED_PATH = '/geogebra-dsh-embed'
const GGB_ENTRY = 'HTML5/5.0/GeoGebra.html'

// The GeoGebra build the pane embeds, vendored inside this package so the plugin
// is self-contained. Resolved from this module rather than from the process cwd,
// because a plugin is loaded from wherever the host put it.
//
// Overridable per profile through `config.geogebraDir` — point it at another
// build (a newer one, or a tree that also has `web3d`/`webSimple`) without
// touching this file.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_GGB_DIR = join(PACKAGE_ROOT, 'vendor', 'GeoGebra')

// A poll this recent means a browser half is listening right now.
const CLIENT_ALIVE_MS = 6000
// Long enough for the pane to open, boot GeoGebra on a cold start, and run.
const COMMAND_TIMEOUT_MS = 40000
// Kept per session; older user edits are dropped.
const MAX_CHANGES = 300
// Saved constructions, one per Session. Bounded so a long-lived host cannot grow
// without limit; the oldest Session's drawing is the one dropped.
const MAX_CONSTRUCTIONS = 20
const MAX_CONSTRUCTION_BYTES = 2 * 1024 * 1024

/**
 * Where the GeoGebra guidance sits in the system prompt.
 *
 * After the first-party tool sections (which run to 3100 with MCP) and well before
 * the SDK layer at 5000, so it lands next to the other tool guidance rather than
 * buried at the end. `SystemPrompt.getSectionOrder` has no slot for a plugin's own
 * guidance, so the number is chosen against the published table.
 */
const PROMPT_ORDER = 3200

/**
 * The one thing a tool schema cannot say.
 *
 * A schema can describe `geogebra_do`; it cannot tell the model to read the problem
 * before drawing, or to send the whole construction in one call. Without that the
 * model dribbles out one command per round trip and each round trip costs a settle
 * delay — slow, and easy to misjudge halfway through.
 *
 * Kept in Chinese to match the rest of this plugin's model-facing text. No backticks
 * anywhere: sections are interpolated, and a stray backtick is a real hazard when
 * this text ever moves inside a template literal.
 */
const PROMPT_TEXT = `## GeoGebra 作图

DSH 右侧栏有一块 GeoGebra 面板（每个会话一块）。你用工具操作它：
geogebra_state 读当前作图与存档诊断、geogebra_do 执行指令、geogebra_view 切换视角、
geogebra_check 离线校验指令名、geogebra_params 查 App 参数与视角语法、
geogebra_changes 读用户手动改了什么、geogebra_export 导出 .ggb 文件。

**先读懂题，再作图。** 用户给的是题目，不是指令。动手前先从题目里提取：要画哪些对象、
它们之间是什么关系、题目要求什么结论。把条件翻译成几何关系 ——「AB 是直径」要画成以 AB 为
直径的圆，「P 在直线 l 上」要让 P 真的约束在 l 上，而不是凑一组看着像的坐标。
缺关键信息就直接问，别用猜的数字画一张似是而非的图。

**一次给全，别一条一条试。** 先在心里把整张图规划完，再用一次 geogebra_do 调用提交全部指令。
逐条提交既慢（每条之间要等 GeoGebra 应用）又容易在中间状态上判断失误。对象之间的依赖用顺序表达：
先定义点，再画依赖它的对象。坐标自己选合适的，让图形铺满视野、比例正常。

**看结果，再修。** 返回值里每条命令都带 GeoGebra 自己的判定「[GeoGebra 接受] / [GeoGebra 拒绝]」：
- 全部接受 → 用 geogebra_state 确认对象确实建出来了，再向用户说明你画了什么、对应题目里的哪个条件。
- 有 ✗ → 按返回的说明只重发出错的那几条，不要整批重来。
- 样式指令（SetColor、SetLineThickness 等）即使工具说「GeoGebra 接受」或带着说明，也都算数 ——
  它们有时返回值是 false，但图形已经改了，工具会标出来，不要因为那个 false 反复重发。

指令名拼错会在执行前被拦下，并给出最接近的写法与官方文档链接，照那个改即可。
用户自己也会在面板上改图，geogebra_changes 能告诉你他改了什么；改动不必回滚，除非用户要求。`

// Only these extensions occur in the GeoGebra build (fonts ship as .js), but the
// map stays broader so a different build still serves correctly.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
}

// GeoGebra.html pulls Google Analytics from geogebra.org. This build is embedded
// offline inside the DSH UI, so the tag is dropped on the way out; everything
// else is served verbatim.
const ANALYTICS_TAG = /<script[^>]*id="fbase"[^>]*>\s*<\/script>/gi

/** Resolve a request path inside `root`, refusing anything that escapes it. */
function resolveInside(root, relative) {
  let decoded
  try { decoded = decodeURIComponent(relative) } catch { return undefined }
  if (decoded.includes('\0')) return undefined
  const full = normalize(join(root, decoded))
  const guard = root.endsWith(sep) ? root : root + sep
  if (full !== root && !full.startsWith(guard)) return undefined
  return full
}

/** Serve one file from the GeoGebra build. Owns the whole response lifecycle. */
function serveAsset(root, req, res) {
  const url = new URL(req.url, 'http://localhost')
  let relative = url.pathname.slice(GGB_PREFIX.length)
  if (relative === '' || relative === '/') relative = `/${GGB_ENTRY}`
  else if (relative.endsWith('/')) relative += 'index.html'

  const file = resolveInside(root, relative)
  if (file === undefined) { res.writeHead(403).end('forbidden'); return }

  let stat
  try { stat = statSync(file) } catch { res.writeHead(404).end('not found'); return }
  if (!stat.isFile()) { res.writeHead(404).end('not found'); return }

  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  // The entry document must stay fresh (it names the rest of the tree); the
  // hashed GWT chunks are content-addressed and safe to cache hard.
  const immutable = stat.size > 0 && /\.cache\.js$/.test(file)
  const headers = {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
  }

  // The one served document that is rewritten rather than streamed.
  if (type.startsWith('text/html')) {
    let body
    try { body = readFileSync(file, 'utf8').replace(ANALYTICS_TAG, '') } catch { res.writeHead(500).end('read failed'); return }
    headers['content-length'] = Buffer.byteLength(body)
    res.writeHead(200, headers)
    res.end(req.method === 'HEAD' ? undefined : body)
    return
  }

  headers['content-length'] = stat.size
  res.writeHead(200, headers)
  if (req.method === 'HEAD') { res.end(); return }
  const stream = createReadStream(file)
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

/** The page the DSH pane iframes: loads deployggb.js and boots the applet. */
function embedPage() {
  const config = JSON.stringify({ loader: `${GGB_PREFIX}/deployggb.js`, codebase: `${GGB_PREFIX}/HTML5/5.0/` })
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GeoGebra</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #fff; }
  #applet { width: 100%; height: 100%; }
  #status { position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: center; font: 13px system-ui, sans-serif; color: #444;
    background: #fff; text-align: center; padding: 24px; }
  #status[hidden] { display: none; }
</style>
</head>
<body>
<div id="applet"></div>
<div id="status">Loading GeoGebra…</div>
<script>window.__SIDE_JUMP_GGB__ = ${config};</script>
<script>
(function () {
  var cfg = window.__SIDE_JUMP_GGB__;
  var status = document.getElementById('status');

  function fail(message) {
    status.hidden = false;
    status.textContent = message;
  }

  function boot() {
    if (!window.GGBApplet) { fail('GeoGebra loader did not initialise.'); return; }
    var params = {
      appName: 'classic',
      width: window.innerWidth,
      height: window.innerHeight,
      // Everything the applet can show, on. The defaults leave most of the chrome
      // off (zoom buttons, fullscreen, tool help, style bar, file features), which
      // reads as a crippled GeoGebra rather than an embedded one.
      showToolBar: true,
      showToolBarHelp: true,
      showAlgebraInput: true,
      showMenuBar: true,
      perspective: '1',
      allowStyleBar: true,
      showResetIcon: true,
      showZoomButtons: true,
      showFullscreenButton: true,
      showSuggestionButtons: true,
      showAnimationButton: true,
      enableLabelDrags: true,
      enableShiftDragZoom: true,
      enableRightClick: true,
      enableUndoRedo: true,
      enableFileFeatures: true,
      // No error popups. A dialog is modal and blocks the pane, and the agent's
      // failures already reach it through the return value of evalCommand — a popup
      // adds nothing a tool result cannot say better.
      //
      // Trade-off: this also silences the *manual* input bar's error dialogs. Set
      // it back to true if you would rather keep those; the agent is unaffected
      // either way, and the pane still reads any dialog that appears regardless.
      errorDialogsActive: false,
      showLogging: false,
      useBrowserForJS: false,
      codebase: cfg.codebase,
      appletOnLoad: function (api) {
        // Same origin as the DSH page, so the pane reaches this directly.
        window.ggbApplet = api;
        status.hidden = true;
      }
    };
    try {
      new window.GGBApplet(params, true).inject('applet');
    } catch (error) {
      fail('GeoGebra failed to start: ' + (error && error.message ? error.message : error));
    }
  }

  var script = document.createElement('script');
  script.src = cfg.loader;
  script.onload = boot;
  script.onerror = function () { fail('Could not load ' + cfg.loader); };
  document.head.appendChild(script);

  window.addEventListener('resize', function () {
    if (window.ggbApplet) window.ggbApplet.setSize(window.innerWidth, window.innerHeight);
  });
})();
</script>
</body>
</html>
`
}

// ---------------------------------------------------------------------------
// GeoGebra bridge

/**
 * The host end of the browser exchange. The applet cannot be driven from here, so
 * a tool's command is queued until the browser polls for it, and the promise
 * settles on the report that comes back. Everything the browser last told us —
 * the construction and the user's own edits — is mirrored here for the read-only
 * tools, so they answer instantly instead of waiting for a round trip.
 */
function createBridge() {
  let seq = 0
  const waiting = new Map()
  let queue = []
  let lastPollAt = 0
  let objects = []
  let changes = []
  let changeSeq = 0
  /** What the browser's construction persistence last did; empty until it reports. */
  let persist = []
  /** Which Session the browser last acted on — the answer to "which panel got this?". */
  let lastSession = null
  /** Which Session the sidebar said was on screen at that moment. Must match. */
  let lastOnScreen = null
  /** Sessions with a live pane, as the browser last reported them. */
  let paneSessions = new Set()
  /** Why the last prompt assembly did or did not get the guidance. */
  let promptNote = null
  /** Session key -> the last construction the browser reported for it. */
  const constructions = new Map()

  const attached = () => lastPollAt !== 0 && Date.now() - lastPollAt < CLIENT_ALIVE_MS
  const touch = () => { lastPollAt = Date.now() }

  /** Queue a batch and resolve when the browser reports it finished. */
  function enqueue(commands, extra) {
    const id = `c${++seq}`
    return new Promise((resolve) => {
      const settle = (value) => {
        const entry = waiting.get(id)
        if (entry === undefined) return
        waiting.delete(id)
        clearTimeout(entry.timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        settle({
          ok: false,
          error: attached()
          ? '浏览器没有在超时前回报结果（GeoGebra 可能仍在加载，或该 pane 已被关闭）'
          : '没有连上浏览器：GeoGebra pane 从未打开过',
          results: [],
          objects,
        })
      }, COMMAND_TIMEOUT_MS)
      waiting.set(id, { timer, settle })
      queue.push({ id, commands, ...extra === undefined ? {} : extra })
    })
  }

  /** Hand the browser everything queued since its last poll. */
  function poll(payload) {
    touch()
    // Which Sessions currently have a GeoGebra pane alive. The browser knows; the
    // host needs it to keep this plugin's system-prompt guidance out of Sessions
    // that never opened the pane.
    if (Array.isArray(payload?.sessions)) {
      paneSessions = new Set(payload.sessions.filter((id) => typeof id === 'string' && id !== ''))
    }
    const commands = queue
    queue = []
    return { commands }
  }

  /** Take one batch's outcome, plus the construction it left behind. */
  function report(payload) {
    touch()
    if (Array.isArray(payload?.objects)) objects = payload.objects
    if (Array.isArray(payload?.persist)) persist = payload.persist
    if (typeof payload?.session === 'string' && payload.session !== '') lastSession = payload.session
    if (payload?.onScreen !== undefined) lastOnScreen = payload.onScreen
    const id = payload?.id
    if (id !== undefined) {
      const entry = waiting.get(id)
      if (entry !== undefined) {
        entry.settle({
          ok: payload?.error === undefined || payload.error === null,
          error: payload?.error ?? undefined,
          results: Array.isArray(payload?.results) ? payload.results : [],
          objects,
          ...payload?.view === undefined ? {} : { view: payload.view },
          ...payload?.export === undefined ? {} : { export: payload.export },
        })
      }
    }
    return { ok: true }
  }

  /** Record edits the browser attributes to the user. */
  function noteChanges(list) {
    touch()
    if (Array.isArray(list)) {
      for (const change of list) {
        if (change === null || typeof change !== 'object') continue
        changes.push({ ...change, at: Date.now(), seq: ++changeSeq })
      }
    }
    if (changes.length > MAX_CHANGES) changes = changes.slice(-MAX_CHANGES)
    return { ok: true, count: changes.length }
  }

  /**
   * Save the construction for one Session.
   *
   * The applet lives inside the pane, so the pane's lifetime bounds the drawing's
   * — closing its tab tears the applet down. Keeping the XML here outlives the
   * pane: closing and reopening restores the drawing, and so does a page reload,
   * for as long as this host process lives.
   */
  function saveConstruction(key, xml, perspective) {
    if (typeof xml !== 'string' || xml === '') return { ok: false, reason: '空状态' }
    if (xml.length > MAX_CONSTRUCTION_BYTES) {
      return { ok: false, reason: `状态过大（${Math.round(xml.length / 1024)}KB > ${Math.round(MAX_CONSTRUCTION_BYTES / 1024)}KB），未保存` }
    }
    const previous = constructions.get(key)
    // Re-insert to refresh its place in the eviction order.
    constructions.delete(key)
    constructions.set(key, {
      xml,
      perspective: typeof perspective === 'string' && perspective !== ''
        ? perspective
        : previous?.perspective ?? null,
      at: Date.now(),
    })
    while (constructions.size > MAX_CONSTRUCTIONS) {
      const oldest = constructions.keys().next().value
      constructions.delete(oldest)
    }
    return { ok: true, bytes: xml.length, sessions: constructions.size }
  }

  /** The saved construction for one Session, or null. */
  function construction(key) {
    return constructions.get(key) ?? null
  }

  /**
   * Drop a Session's saved construction.
   *
   * Needed because an empty applet is deliberately never saved — that rule stops a
   * closed pane from erasing a good drawing, but it also means "the user cleared
   * everything" would otherwise be undone the next time the pane opened.
   */
  function forgetConstruction(key) {
    return { ok: true, forgotten: constructions.delete(key) }
  }

  return {
    enqueue,
    poll,
    report,
    noteChanges,
    attached,
    saveConstruction,
    construction,
    forgetConstruction,
    getObjects: () => objects,
    getPersist: () => persist,
    getSession: () => lastSession,
    getOnScreen: () => lastOnScreen,
    getPaneSessions: () => [...paneSessions],
    /**
     * Whether this Session has a GeoGebra pane open right now.
     *
     * Requires a live browser: if polling stopped, the last report is stale and the
     * host must not keep claiming a pane it can no longer see.
     */
    hasPane: (sessionId) => attached() && paneSessions.has(String(sessionId)),
    /** Whether this Session has a drawing the host is holding. */
    hasConstruction: (sessionId) => constructions.has(String(sessionId)),
    notePrompt: (note) => { promptNote = { ...note, at: Date.now() } },
    getPromptNote: () => promptNote,
    /** Which Sessions the host is holding a drawing for. */
    savedKeys: () => [...constructions.keys()],
    getChanges: () => changes,
    clearChanges: () => { const n = changes.length; changes = []; return n },
  }
}

/**
 * Which Session the last operation acted on, and whether that is the one on screen.
 *
 * A mismatch is the cross-Session bug in its purest form: the command went to a
 * pane the user was not looking at. Printed as a warning rather than two innocent
 * lines, because the two lines look fine on their own.
 */
function describeRouting(bridge) {
  const target = bridge.getSession()
  const onScreen = bridge.getOnScreen()
  if (target === null || target === undefined) return '最近一次操作：尚未执行过'
  if (onScreen === null || onScreen === undefined) {
    return `最近一次操作作用于会话：${target}（屏幕上的会话当时未知）`
  }
  if (String(target) === String(onScreen)) return `最近一次操作作用于会话：${target}（与屏幕一致）`
  return `⚠ 串会话：命令打到了 ${target}，但屏幕上是 ${onScreen}`
}

/**
 * Whether the GeoGebra guidance made it into the last assembled system prompt.
 *
 * Worth showing because the failure is silent in both directions: guidance that
 * should be there and is not looks exactly like a model that ignored it.
 */
function describePromptNote(note, bridge) {
  if (note === null || note === undefined) {
    return `系统提示词：尚未装配过（guidance ${PROMPT_TEXT.length} 字，仅在开着 pane 的会话里注入）`
  }
  if (note.advised) {
    return note.reason === 'pane'
      ? '系统提示词：已注入 GeoGebra 指引（本会话开着 pane）'
      : '系统提示词：已注入 GeoGebra 指引（本会话有存档的作图，pane 虽关仍在）'
  }
  if (note.sessionId === null) {
    return '系统提示词：未注入 —— 装配上下文里取不到会话 id（失败时宁可不注入）'
  }
  return `系统提示词：未注入 —— 本会话（${note.sessionId}）既没开 pane，也没有存档的作图`
}

/**
 * One persistence event as a line. Persistence fails silently by nature — the
 * drawing is simply not there — so the caller gets to see what it actually did.
 */
function describePersist(entry) {
  const time = new Date(entry.at ?? Date.now()).toLocaleTimeString()
  const what = entry.what === 'save' ? '保存' : '恢复'
  const key = entry.key === undefined ? '' : `  key=${entry.key}`
  if (entry.ok !== true) return `${time}  ${what} 未完成${key}  —— ${entry.reason ?? '未知原因'}`
  if (entry.skipped !== undefined) return `${time}  ${what} 跳过${key}  —— ${entry.skipped}`
  const size = entry.bytes === undefined ? '' : `  ${entry.bytes} 字节`
  const count = entry.objects === undefined ? '' : `  ${entry.objects} 个对象`
  return `${time}  ${what} 成功${key}${size}${count}`
}

/** One change record as a line a person (or the model) can read. */
function describeChange(change) {  const time = new Date(change.at).toLocaleTimeString()
  const name = change.name ?? '(未命名)'
  if (change.kind === 'added') return `${time}  新增 ${name}${change.definition ? `  = ${change.definition}` : ''}`
  if (change.kind === 'removed') return `${time}  删除 ${name}`
  const parts = []
  if (change.from !== undefined && change.from !== change.to) parts.push(`${change.from} → ${change.to}`)
  else if (change.definition) parts.push(change.definition)
  return `${time}  修改 ${name}${parts.length > 0 ? `  ${parts.join('  ')}` : ''}`
}

function describeObjects(objects) {
  if (!Array.isArray(objects) || objects.length === 0) return '当前 GeoGebra 上没有任何对象。'
  return [
    `当前共 ${objects.length} 个对象：`,
    ...objects.map((o) => `- ${o.name}${o.definition ? `  = ${o.definition}` : ''}${o.value ? `   [${o.value}]` : ''}`),
  ].join('\n')
}

// Assembled once per request: cheap enough, and always current.
function snapshot(ctx, ggb, bridge) {
  const pkg = readPackage()
  const sessions = ctx.get('sessions')
  const list = sessions?.list?.getSnapshot?.()
  const byId = list?.byId ?? {}
  const ids = Object.keys(byId)

  const running = ids.filter(id => byId[id]?.running === true).length
  const archived = ids.filter(id => byId[id]?.archived === true).length
  const blanks = ids.filter(id => byId[id]?.blank === true).length

  return {
    plugin: {
      name: pkg.name ?? 'geogebra-dsh',
      version: pkg.version ?? '0.0.0',
      description: pkg.description ?? '',
    },
    host: {
      pid: process.pid,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      uptimeSeconds: Math.round(process.uptime()),
      home: process.env.DSH_HOME ?? null,
      cwd: safeCwd(),
    },
    sessions: {
      total: ids.length,
      running,
      archived,
      blank: blanks,
    },
    geogebra: { ...ggb, attached: bridge.attached() },
    checkedAt: Date.now(),
  }
}

function readPackage() {
  try {
    // This file lives at src/host/, so the manifest is two levels up.
    const here = new URL('../../package.json', import.meta.url)
    return JSON.parse(readFileSync(here, 'utf8'))
  } catch {
    return {}
  }
}

function safeCwd() {
  try { return process.cwd() } catch { return null }
}

/**
 * GeoGebra view presets.
 *
 * The digits are the standard perspectives and the letters are single views, both
 * exactly as the SetPerspective manual page defines them — which the App
 * Parameters reference names as the authority for the `perspective` parameter.
 *
 * Note `probability` is the digit 6 (or the letter `B`): `P` is the *Properties*
 * panel, which is an easy and silent mistake to make.
 *
 * GeoGebra accepts an unknown perspective in silence, so every switch is verified
 * by the browser half, which reports which views are actually on screen.
 */
const VIEW_PRESETS = {
  '2d': { perspective: '1', label: '代数 & 图形（标准 2D）' },
  function: { perspective: '1', label: '代数 & 图形（函数作图）' },
  '3d': { perspective: '5', label: '3D 绘图' },
  geometry: { perspective: '2', label: '几何' },
  spreadsheet: { perspective: '3', label: '表格' },
  cas: { perspective: '4', label: 'CAS' },
  probability: { perspective: '6', label: '概率' },
  graphics: { perspective: 'G', label: '仅绘图区' },
  graphics2: { perspective: 'D', label: '绘图区 2' },
  algebra: { perspective: 'A', label: '仅代数（函数在此输入）' },
  '3d-only': { perspective: 'T', label: '仅 3D 绘图区' },
  construction: { perspective: 'L', label: '作图过程' },
  properties: { perspective: 'P', label: '属性面板' },
}

function describeView(name, preset, answer) {
  const view = answer.view
  const lines = [`已请求视角「${name}」${preset === undefined ? '' : `（${preset.label}）`}`]
  if (view === undefined) {
    lines.push('浏览器没有回报视图状态，无法确认是否切换成功。')
    return lines.join('\n')
  }
  lines.push(`perspective = ${JSON.stringify(view.perspective)}`)
  if (view.error !== undefined) lines.push(`GeoGebra 抛出：${view.error}`)
  if (view.before === null || view.after === null) {
    lines.push('读不到 GeoGebra 的视图 DOM，无法自动确认 —— 请看界面实际是否变化。')
  } else if (view.changed) {
    lines.push(`视图已切换：${view.before || '(无)'} → ${view.after || '(无)'}`)
  } else {
    lines.push(`视图没有变化（仍是 ${view.after || '(无)'}）—— 该 perspective 可能不被这个 build 接受。`)
    lines.push('可以换一个 view 名，或用 perspective 直接传 GeoGebra 的视角字符串。')
  }
  return lines.join('\n')
}

/**
 * The names already in the construction, as the browser last reported them. A
 * user-defined object or function is a legitimate callee the catalog has never
 * heard of, so these count as known.
 */
function knownObjectNames(bridge) {
  return (bridge.getObjects() ?? []).map((object) => object.name).filter(Boolean)
}

/** `geogebra-20261012-183045`, the default export name. */
function timestampName() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `geogebra-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * Turn a requested name into a plain file name.
 *
 * Exports land in the user's filesystem, so separators, traversal and stray
 * extensions are all stripped rather than trusted.
 */
function exportFileName(requested) {
  const raw = typeof requested === 'string' ? requested.trim() : ''
  const fallback = timestampName()
  if (raw === '') return fallback
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, '-')
    // No leading dot or dash: `../..` must not become a hidden file, and a
    // leading dash reads as a command-line flag in a shell.
    .replace(/^[.\-\s]+/, '')
    .replace(/\.(ggb|xml)$/i, '')
    .trim()
    .slice(0, 80)
  return cleaned === '' ? fallback : cleaned
}

/** Where an export goes when the caller names no directory. */
function exportDirectory(requested) {
  if (typeof requested === 'string' && requested.trim() !== '') return resolve(requested.trim())
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'geogebra-dsh', 'exports')
}

/** One unknown name, its nearest catalog matches, and where to read up. */
function describeUnknownCommands(unknown) {
  const lines = []
  for (const entry of unknown) {
    const suggestions = suggestCommand(entry.name, 4)
    lines.push(`✗ ${entry.name} —— 不在 GeoGebra 的 ${COMMAND_COUNT} 个指令里`)
    if (suggestions.length > 0) {
      lines.push(`   最接近：${suggestions.join(' / ')}`)
      lines.push(`   用法：${commandDocUrl(suggestions[0])}`)
    } else {
      lines.push(`   没有相近的指令，指令索引见 ${COMMAND_DOCS_BASE}`)
    }
    lines.push(`   出现在：${entry.lines.join('  |  ')}`)
  }
  return lines.join('\n')
}

/**
 * The Session one prompt assembly belongs to.
 *
 * `assembleContextFor(agent, signal)` puts the Agent (and its scope) into the
 * context, so the Agent's live Session names itself here. Read defensively: a
 * diagnostics assembly has no Agent, and the id has moved between fields across
 * versions.
 */
function promptSessionId(context) {
  const session = context?.agent?.session
  for (const candidate of [session?.id, session?.sessionId, context?.agent?.sessionId]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/**
 * Contribute the GeoGebra working method — but only where it applies.
 *
 * The section is registered globally, which would otherwise put ~800 characters of
 * GeoGebra guidance into *every* Session's prompt, including ones that never touch
 * a drawing. `text` may be a provider evaluated per assembly, and an empty string
 * drops the section, so the guidance follows the pane instead of the process.
 *
 * The tools stay registered everywhere on purpose: they are how a Session
 * discovers GeoGebra in the first place. This is the follow-up guidance, and it
 * arrives once the pane is actually open.
 *
 * Fails closed: an assembly whose Session cannot be identified gets nothing. The
 * cost of that is a missing hint; the cost of guessing is guidance in the wrong
 * Session.
 */
function registerPrompt(scope, bridge) {
  // `inject` already withholds the callback when the service is absent; this keeps
  // the function total anyway, so its contract does not depend on the caller.
  if (scope?.systemPrompt === undefined) return
  scope.effect(() => scope.systemPrompt.section({
    name: 'geogebra-dsh:guidance',
    order: PROMPT_ORDER,
    text: (context) => {
      const sessionId = promptSessionId(context)
      const pane = sessionId !== undefined && bridge.hasPane(sessionId)
      // A closed pane is not the end of the work: the host still holds the drawing,
      // and the next request about it needs the same guidance. So a Session that has
      // ever produced a construction keeps its guidance even with the pane shut.
      const drawing = sessionId !== undefined && bridge.hasConstruction(sessionId)
      const advised = pane || drawing
      bridge.notePrompt({
        sessionId: sessionId ?? null,
        advised,
        reason: pane ? 'pane' : drawing ? 'drawing' : 'none',
        panes: bridge.getPaneSessions(),
        drawings: bridge.savedKeys(),
      })
      return advised ? PROMPT_TEXT : ''
    },
  }), 'geogebra-dsh: geogebra prompt')
}

/**
 * Register the agent-facing tools. Registered through the registry's own shape
 * (name + output { schema, render } + parameters as JSON Schema) rather than
 * `defineTool`, so the plugin needs no `@deepseek-ai/dsh-tools` import and stays
 * loadable and testable on its own.
 */
function registerTools(scope, bridge) {
  const text = (value) => [{ type: 'text', text: String(value) }]
  const output = { schema: { type: 'string' }, render: (_args, value) => text(value) }

  const tools = [
    {
      name: 'geogebra_do',
      description: [
        // The working style lives here rather than only in the system-prompt section
        // for a reason: the section only appears once the pane is open, but the very
        // first drawing is exactly the moment this matters. Tool descriptions are
        // always in context, so this is the one surface that reaches a session
        // before it has touched GeoGebra.
        '**先读懂题目，再一次性提交整张图的指令。** 说清要画哪些对象、条件之间是什么关系、题目要求什么结论，',
        '把条件翻译成几何关系（「AB 是直径」就画成以 AB 为直径的圆，而不是凑一组像的坐标），',
        '依赖用顺序表达（先定义点，再画依赖它的对象）。不要一条一条试：每条命令之间都要等 GeoGebra 应用，',
        '逐条提交既慢又容易在中间状态上判断失误。缺关键信息就直接问，别用猜的数字画一张似是而非的图。',
        '',
        '在 DSH 右侧栏的 GeoGebra 上作图或修改。命令语法就是 GeoGebra 输入栏的语法，',
        '例如 "A=(1,2)"、"Circle(A,3)"、"f(x)=x^2"、"SetColor(A, \\"red\\")"。',
        '执行前会先用内置的 GeoGebra 指令表（549 条）校验指令名；发现不存在的指令会**拒绝执行**并给出最接近的名字与文档链接，',
        '因为 GeoGebra 自己对这些错误完全不报错，与其跑一趟拿回一个含糊的结果，不如先挡住。',
        '每条结果带 GeoGebra 自己的判定 [GeoGebra 接受/拒绝] —— 来自 evalCommand 的布尔返回值。',
        '注意它**不是无条件的**：样式类指令（SetColor、SetLineThickness、SetPointSize、SetFilling、ZoomIn 等）',
        'GeoGebra 会返回 false，但改动其实生效了（已用导出的 XML 核实）。所以工具还会比对执行前后的对象快照',
        '（含颜色、线宽、点径、填充），只要确有改动就算成功，并注明「返回值说 false 但图形确实变了」。',
        '错误弹窗已关闭（它会挡住面板），所以失败时看到的是判定而不是 GeoGebra 的错误原文；',
        '真正失败时会说「没有任何效果」—— 那才是语法有问题。',
        '看到 ✗ 就说明写法有问题，改正后**只重发出错的那几条**，不要整批重来。',
        '若 GeoGebra pane 尚未打开，会自动打开（需要屏幕上有一个会话）。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          commands: {
            type: 'array',
            items: { type: 'string' },
            description: 'GeoGebra 命令列表，按顺序执行。',
          },
          allowUnknown: {
            type: 'boolean',
            description: '为 true 时跳过指令名校验直接执行。仅在你确定某个名字是自己定义的对象/函数、而校验误判时才用。',
          },
        },
        required: ['commands'],
        additionalProperties: false,
      },
      output,
      async execute(args) {
        const commands = (Array.isArray(args?.commands) ? args.commands : [])
          .map((c) => String(c ?? '').trim())
          .filter((c) => c !== '')
        if (commands.length === 0) return '没有给出任何命令。'

        // Refuse before spending a round trip. GeoGebra answers a bad command
        // with silence, so the only honest check is the catalog — and a name that
        // is not in it cannot start working by being sent.
        if (args?.allowUnknown !== true) {
          const { unknown } = validateCommands(commands, knownObjectNames(bridge))
          if (unknown.length > 0) {
            return [
              '没有执行：这些指令名不在 GeoGebra 的指令表里。',
              '',
              describeUnknownCommands(unknown),
              '',
              '改正后重试。若其中某个名字确实是你自己定义的对象或函数，确认它已在作图里，',
              '或用 allowUnknown=true 跳过这项校验。',
            ].join('\n')
          }
          // A name with no near neighbour in the command table is passed through:
          // refusing it would block the user's own objects and functions, and a
          // genuinely wrong name is caught by the per-command verdict below.
        }

        const answer = await bridge.enqueue(commands)
        const lines = []
        if (answer.error !== undefined) lines.push(`执行未完成：${answer.error}`)
        for (const result of answer.results) {
          const created = result.labels ? `  → 创建 ${result.labels}` : ''
          // GeoGebra's own verdict, when the build gave one. Worth showing even on
          // success: it is the only signal that does not depend on side effects.
          const verdict = result.accepted === undefined ? '' : `  [GeoGebra ${result.accepted ? '接受' : '拒绝'}]`
          const plus = result.note === undefined ? '' : `  —— ${result.note}`
          lines.push(`${result.ok === false ? '✗' : '✓'} ${result.command}${created}${verdict}${plus}${result.error ? `  — ${result.error}` : ''}`)
        }
        // Call the failures out on their own line: the model must not read a
        // batch that half-failed as a success.
        const failed = answer.results.filter((r) => r.ok === false)
        if (failed.length > 0) {
          lines.push('', `有 ${failed.length} 条命令没有生效，请检查它们的语法后重试：${failed.map((r) => r.command).join('、')}`)
        }
        lines.push('', describeObjects(answer.objects))
        return lines.join('\n')
      },
    },
    {
      name: 'geogebra_state',
      description: [
        '读取当前 GeoGebra 上的作图内容：每个对象的定义与当前值。会先向浏览器要一次最新快照。',
        '同时会带出「作图状态的保存/恢复」最近发生了什么 —— 关掉面板再打开却看不到图形时，看这一段。',
      ].join(''),
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output,
      async execute() {
        // An empty batch is a snapshot request: the browser reports its objects.
        const answer = await bridge.enqueue([])
        const saved = bridge.savedKeys()
        const pane = bridge.getPaneSessions()
        const persist = [
          '',
          describeRouting(bridge),
          `开着 GeoGebra pane 的会话：${pane.length === 0 ? '（无）' : pane.join(', ')}`,
          describePromptNote(bridge.getPromptNote(), bridge),
          `宿主持有的存档：${saved.length === 0 ? '（无）' : saved.join(', ')}`,
          ...bridge.getPersist().map(describePersist),
        ]
        if (answer.error !== undefined && answer.objects.length === 0) {
          return [`读取失败：${answer.error}`, ...persist].join('\n')
        }
        return [describeObjects(answer.objects), ...persist].join('\n')
      },
    },
    {
      name: 'geogebra_changes',
      description: [
        '读取用户在 GeoGebra 上**手动**做的改动（拖动、输入命令、增删对象等），以及这些改动之后的状态。',
        '只报告用户造成的改动，agent 自己通过 geogebra_do 做的改动不会出现在这里。',
        '默认读取后清空，避免重复报告；需要只看不清空时传 clear=false。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          clear: {
            type: 'boolean',
            description: '读取后是否清空记录，默认 true。',
          },
        },
        additionalProperties: false,
      },
      output,
      async execute(args) {
        const entries = bridge.getChanges()
        const clear = args?.clear !== false
        if (entries.length === 0) {
          return bridge.attached()
            ? '用户还没有手动改动过。'
            : '还没有连上浏览器：GeoGebra pane 尚未打开过，因此没有记录到任何改动。'
        }
        const lines = [`用户手动改动 ${entries.length} 处：`, ...entries.map(describeChange)]
        if (clear) {
          bridge.clearChanges()
          lines.push('', '（已清空记录）')
        }
        return lines.join('\n')
      },
    },
    {
      name: 'geogebra_view',
      description: [
        '切换 GeoGebra 的视角：2d / 3d / function / geometry / spreadsheet / cas / probability / graphics / graphics2 / algebra / 3d-only / construction / properties。',
        '用 view 选预设，或用 perspective 直接传视角字符串（会覆盖 view）。字符串语法见 geogebra_params 的 perspective 主题：',
        '并列是横排（"AGS"），斜杠是上下分（"S/G"），括号分组（"S/(GA)"），前缀 +/- 增减单个视图（"+D" 加绘图区 2），',
        '数字 1–6 是标准视角。注意 P 是属性面板，概率是 B 或数字 6。',
        'GeoGebra 对不认识的视角**不报错**，所以本工具会读取切换后实际可见的视图，',
        '并据此判断是否真的切成了；如果回报「视图没有变化」，说明该字符串不被接受，换一个再试。',
        '切换视角不会影响已经画好的对象。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            enum: Object.keys(VIEW_PRESETS),
            description: '预设视角名。function 与 2d 目前都指向「代数 & 图形」。',
          },
          perspective: {
            type: 'string',
            description: 'GeoGebra 视角字符串，例如 "1"、"5"、"G"、"A"、"AG"。给了它就忽略 view。',
          },
        },
        additionalProperties: false,
      },
      output,
      async execute(args) {
        const raw = typeof args?.perspective === 'string' ? args.perspective.trim() : ''
        const name = typeof args?.view === 'string' ? args.view.trim() : ''
        const preset = VIEW_PRESETS[name]
        const perspective = raw !== '' ? raw : preset?.perspective
        if (perspective === undefined) {
          return `请给出 view（${Object.keys(VIEW_PRESETS).join(' / ')}）或 perspective。`
        }

        const answer = await bridge.enqueue([], { view: { perspective } })
        if (answer.error !== undefined) return `切换视角未完成：${answer.error}`
        const lines = [describeView(raw !== '' ? `perspective=${raw}` : name, raw !== '' ? undefined : preset, answer)]
        const count = (answer.objects ?? []).length
        if (count > 0) lines.push('', `作图内容未受影响（仍 ${count} 个对象）。`)
        return lines.join('\n')
      },
    },
    {
      name: 'geogebra_export',
      description: [
        '把当前 GeoGebra 作图导出成 .ggb 文件（GeoGebra 原生格式，双击即可打开）或 XML，写到磁盘并返回绝对路径。',
        '.ggb 走 getBase64，连带视图与界面设置；XML 只有作图本身，适合再导入或做文本处理。',
        '默认写到 <DSH_HOME>/geogebra-dsh/exports/，可用 dir 指定其它目录；文件名用 name 指定（不含扩展名）。',
        '拿到路径后可以用 present 工具把它作为文件交给用户。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '文件名，不含扩展名。默认 geogebra-<时间戳>。' },
          dir: { type: 'string', description: '写入目录（绝对路径）。默认 <DSH_HOME>/geogebra-dsh/exports。' },
          format: { type: 'string', enum: ['ggb', 'xml'], description: '导出格式，默认 ggb。' },
        },
        additionalProperties: false,
      },
      output,
      async execute(args) {
        const format = args?.format === 'xml' ? 'xml' : 'ggb'
        const answer = await bridge.enqueue([], { export: { format } })
        if (answer.error !== undefined) return `导出未完成：${answer.error}`
        const payload = answer.export
        if (payload?.error !== undefined) return `导出失败：${payload.error}`
        const data = payload?.data
        if (typeof data !== 'string' || data === '') return '导出失败：浏览器没有返回内容。'

        const bytes = format === 'ggb' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8')
        const directory = exportDirectory(args?.dir)
        const file = join(directory, `${exportFileName(args?.name)}.${format}`)
        try {
          mkdirSync(directory, { recursive: true })
          writeFileSync(file, bytes)
        } catch (error) {
          return `写入失败：${error?.message ?? error}`
        }
        return [
          `已导出：${file}`,
          `  格式：${format}`,
          `  大小：${bytes.length} 字节`,
          `  对象：${(answer.objects ?? []).length} 个`,
          '',
          '可以把上面的路径用 present 工具交给用户，或直接双击用 GeoGebra 打开。',
        ].join('\n')
      },
    },
    {
      name: 'geogebra_check',
      description: [
        '校验 GeoGebra 指令：逐条提取指令名，对照内置的 ' + String(COMMAND_COUNT) + ' 条官方指令表，',
        '报出**不存在**的指令，并给出最接近的名字与官方文档链接。不执行任何东西，纯离线。',
        '写命令前先跑一遍，可以避免 GeoGebra「静默不生效」这种最难查的失败。',
        '注意这是启发式识别：函数定义（f(x)=… 这类）和作图里已有的对象名会被正确跳过。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          commands: {
            type: 'array',
            items: { type: 'string' },
            description: '要校验的 GeoGebra 命令或命令片段。',
          },
          name: {
            type: 'string',
            description: '只查一个指令名：返回它在指令表中的写法与文档链接，不做批量校验。',
          },
        },
        additionalProperties: false,
      },
      output,
      async execute(args) {
        const single = typeof args?.name === 'string' ? args.name.trim() : ''
        if (single !== '' && !Array.isArray(args?.commands)) {
          const suggestions = suggestCommand(single, 6)
          const exact = suggestions.length > 0 && suggestions[0].toUpperCase() === single.toUpperCase()
          if (exact) {
            return [
              `✓ ${suggestions[0]} 是 GeoGebra 的指令。`,
              '',
              `文档：${commandDocUrl(suggestions[0])}`,
            ].join('\n')
          }
          // Point at the name we are suggesting, not at the typo: the typo's own
          // page does not exist, so that URL would be a dead end.
          return [
            `✗ ${single} 不在 GeoGebra 的 ${COMMAND_COUNT} 个指令里。`,
            suggestions.length > 0 ? `相近的：${suggestions.join(' / ')}` : '没有相近的指令。',
            '',
            suggestions.length > 0
              ? `文档（按最接近的 ${suggestions[0]}）：${commandDocUrl(suggestions[0])}`
              : `全部指令索引：${COMMAND_DOCS_BASE}`,
          ].join('\n')
        }

        const commands = (Array.isArray(args?.commands) ? args.commands : [])
          .map((c) => String(c ?? '').trim())
          .filter((c) => c !== '')
        if (commands.length === 0) return '请给出 commands（要校验的命令）或 name（要查的指令名）。'

        const { lines, unknown, uncertain } = validateCommands(commands, knownObjectNames(bridge))
        const report = lines.map((line) => {
          const names = line.names.length > 0 ? `  [${line.names.join(', ')}]` : '  [无指令调用]'
          const mark = line.unknown.length > 0 ? '✗' : line.uncertain.length > 0 ? '?' : '✓'
          return `${mark} ${line.command}${names}`
        })
        if (unknown.length > 0) {
          report.push('', `发现 ${unknown.length} 个不存在的指令：`, '', describeUnknownCommands(unknown))
        }
        if (uncertain.length > 0) {
          report.push('', `另有 ${uncertain.length} 个名字不在指令表里，但没有相近的指令 —— 大概是自定义对象，会放行：`,
            '', describeUnknownCommands(uncertain))
        }
        if (unknown.length === 0 && uncertain.length === 0) {
          report.push('', '全部指令名都在指令表里。注意：名字合法不代表参数写法正确 —— 参数错误时 GeoGebra 同样静默不生效。')
        } else if (unknown.length === 0) {
          report.push('', '注意：名字合法不代表参数写法正确 —— 参数错误时 GeoGebra 同样静默不生效。')
        }
        return report.join('\n')
      },
    },
    {
      name: 'geogebra_params',
      description: [
        '查询 GeoGebra App 参数（GGBApplet 的创建参数）与视角语法。离线查表，来自官方 Reference。',
        '参数是**创建 applet 时**生效的，运行期改不了；本工具用来查它们的取值与默认值，以便判断某个设置能不能做、怎么做。',
        '查视角时返回字母与数字两种写法 —— 注意 P 是属性面板，概率是 B（或数字 6），这是最容易记错的一个。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '参数名（如 perspective、showToolBar）。不给则返回全部参数的清单。',
          },
          topic: {
            type: 'string',
            enum: ['parameters', 'perspective', 'all'],
            description: '要查的主题，默认 all。',
          },
        },
        additionalProperties: false,
      },
      output,
      async execute(args) {
        const wanted = typeof args?.name === 'string' ? args.name.trim() : ''
        const topic = typeof args?.topic === 'string' ? args.topic : 'all'

        if (wanted !== '') {
          const key = Object.keys(APP_PARAMETERS).find((name) => name.toLowerCase() === wanted.toLowerCase())
          if (key === undefined) {
            return `没有名为 ${wanted} 的 App 参数。用 geogebra_params 不带 name 可以看到全部清单。`
          }
          const [value, description, since] = APP_PARAMETERS[key]
          return [
            `${key}`,
            `  取值：${value}`,
            `  说明：${description}`,
            since === '' ? '' : `  始于：${since}`,
            '',
            `官方文档：https://geogebra.github.io/docs/reference/en/GeoGebra_App_Parameters/`,
          ].filter((line) => line !== '').join('\n')
        }

        const sections = []
        if (topic === 'parameters' || topic === 'all') {
          sections.push(
            `GeoGebra App 参数（${Object.keys(APP_PARAMETERS).length} 个）—— 创建 applet 时生效：`,
            ...Object.entries(APP_PARAMETERS).map(([name, [value, description]]) => `- ${name}  ${value}  ${description}`),
          )
        }
        if (topic === 'perspective' || topic === 'all') {
          sections.push(
            '',
            '视角语法（perspective 参数 / SetPerspective 指令）：',
            ...PERSPECTIVE_SYNTAX.map((line) => `- ${line}`),
            '',
            '字母：',
            ...Object.entries(VIEW_LETTERS).map(([letter, entry]) => `- ${letter} = ${entry.label}${entry.note ? `（${entry.note}）` : ''}`),
            '',
            '数字（标准视角）：',
            ...Object.entries(STANDARD_PERSPECTIVES).map(([digit, entry]) => `- "${digit}" = ${entry.label}（约等于 "${entry.equivalent}"）`),
          )
        }
        return sections.join('\n')
      },
    },
  ]

  for (const tool of tools) scope.effect(() => scope.tools.register(tool), `geogebra-dsh: tool ${tool.name}`)
}

export function apply(ctx, config = {}) {
  const route = config.route ?? ROUTE
  const ggbDir = config.geogebraDir ?? DEFAULT_GGB_DIR
  const ggbPresent = existsSync(join(ggbDir, GGB_ENTRY))
  const bridge = createBridge()

  const ggb = {
    available: ggbPresent,
    dir: ggbDir,
    embedPath: EMBED_PATH,
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: route,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body = {}
      try { body = await request.json() } catch { /* an empty body asks for the default view */ }
      const endpoint = String(body?.endpoint ?? 'info')
      const payload = body?.payload ?? {}

      // The browser half's channel. `poll`/`report`/`changes` carry the applet
      // exchange, `save-state`/`load-state` the construction that outlives the
      // pane, and `info` stays what the pane reads for its own diagnostics.
      const answer = endpoint === 'info' ? { ok: true, value: snapshot(ctx, ggb, bridge) }
        : endpoint === 'poll' ? { ok: true, value: bridge.poll(payload) }
        : endpoint === 'report' ? { ok: true, value: bridge.report(payload) }
        : endpoint === 'changes' ? { ok: true, value: bridge.noteChanges(payload?.changes) }
        : endpoint === 'save-state' ? { ok: true, value: bridge.saveConstruction(String(payload?.key ?? ''), payload?.xml, payload?.perspective) }
        : endpoint === 'load-state' ? { ok: true, value: bridge.construction(String(payload?.key ?? '')) }
        : endpoint === 'clear-state' ? { ok: true, value: bridge.forgetConstruction(String(payload?.key ?? '')) }
        : { ok: false, error: { code: 'geogebra-dsh/not-found', message: `Unknown endpoint ${endpoint}` } }

      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  }), 'geogebra-dsh: api route')

  // Optional activation: the GeoGebra pane needs the Web composition's server,
  // but the facts endpoint and the tools work without it.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: EMBED_PATH,
      handler: (req, res) => {
        try {
          if (!ggbPresent) { res.writeHead(503).end(`GeoGebra build not found at ${ggbDir}`); return }
          const body = Buffer.from(embedPage(), 'utf8')
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': body.length,
            // Never cache the shell that names the applet's codebase.
            'cache-control': 'no-store',
          })
          res.end(req.method === 'HEAD' ? undefined : body)
        } catch (error) {
          res.writeHead(500).end(String(error?.message ?? error))
        }
      },
    }), 'geogebra-dsh: geogebra embed page')

    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: GGB_PREFIX,
      handler: (req, res) => {
        try { serveAsset(ggbDir, req, res) } catch (error) {
          if (!res.headersSent) res.writeHead(500)
          res.end(String(error?.message ?? error))
        }
      },
    }), 'geogebra-dsh: geogebra assets')
  })

  // The agent-facing tools. Optional for the same reason as the routes above.
  ctx.inject(['tools'], (scope) => registerTools(scope, bridge))

  // How to work with those tools. A tool schema says what a tool does; it cannot
  // say "understand the problem first, then send the whole construction at once" —
  // and without that the model dribbles out one command per round trip.
  ctx.inject(['systemPrompt'], (scope) => registerPrompt(scope, bridge))
}

export default { name, inject, apply }
export { registerPrompt, promptSessionId, PROMPT_TEXT, PROMPT_ORDER }
