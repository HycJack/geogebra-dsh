// geogebra-dsh · browser half
//
// A classic script that hands one factory to `window.__ModuleLoader__`, the shape
// ds-bot's built client.js has. `require` resolves the platform modules the shell
// seeds (react, ...), so those stay external. No bundler is involved.
//
// What it registers:
//   sidebar.panellist      · 'geogebra-dsh'     the icon in the global panel row
//   main                   · 'geogebra-dsh'     an empty seat for that icon (see below)
//   sidebarRightTabs       · tab type        the GeoGebra pane the icon opens
//   sidebar.right.pane.tab · <tab type id>   that pane's body
//
// The GeoGebra pane is a real tab in the shell's right sidebar, not an overlay:
// the column, its tab strip, docking and fullscreen stay the shell's business.
// The applet itself runs inside an iframe served by this plugin's host half (see
// src/host/index.js), so nothing here touches GeoGebra's API directly.
//
// The panel icon is a two-step trick: that row's click belongs to the sidebar
// (`selectPanel(id)`), so the icon is paired with an empty `main` panel and an
// effect bounces the selection straight back, opening the right-hand pane instead.
//
// `id` MUST be the exact npm package name. The module system keys every bundle by
// it, so a mismatch (say the host entry id) leaves the bundle untracked and the
// shell loads it again, which throws "duplicate factory registration".
console.log('[geogebra-dsh] client.js loaded')

window.__ModuleLoader__.load({
  id: 'geogebra-dsh',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    // The footer button's slot cell id. Distinct from the tab type id below.
    const PANEL_ID = 'geogebra-dsh'
    // The panel-icon row: the RSS reader sits at 15, so this lands right after it.
    const PANEL_ORDER = 20
    // Tab types are keyed by `id` in a registry that rejects duplicates, and the
    // body slot is dispatched with that same id — the package name keeps both
    // unmistakably ours (ui-sidebar-terminal does the same).
    const TAB_ID = 'geogebra-dsh'
    const TAB_KIND = 'geogebra'
    const INFO_ROUTE = '/api/geogebra-dsh'
    const DEFAULT_EMBED = '/geogebra-dsh-embed'
    const DIAG_DELAY_MS = 9000

    // -- icon -------------------------------------------------------------
    function GeoGebraIcon(props) {
      const size = props?.size ?? 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M3 20h18' }),
        h('path', { d: 'M3 20V4' }),
        h('path', { d: 'M4 16c3 0 4-9 7-9s3 6 6 6 3-3 3-3' }),
        h('circle', { cx: 11, cy: 7, r: 1.4, fill: 'currentColor', stroke: 'none' }),
      )
    }

    // -- host bridge ------------------------------------------------------
    async function callHost(endpoint) {
      const response = await fetch(INFO_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      })
      const answer = await response.json()
      if (answer?.ok !== true) throw new Error(answer?.error?.message ?? 'geogebra-dsh: host refused the request')
      return answer.value
    }

    // -- styles -----------------------------------------------------------
    const CSS = `
.ggb-pane { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; }
.ggb-tools { flex: none; display: flex; align-items: center; gap: 6px; padding: 5px 8px; flex-wrap: wrap;
  border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
.ggb-tool { font: inherit; font-size: 11px; padding: 3px 9px; border-radius: 6px; cursor: pointer;
  color: inherit; background: none;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
.ggb-tool:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
.ggb-danger { color: #c0392b; border-color: #c0392b; }
.ggb-sep { width: 1px; align-self: stretch; margin: 0 2px;
  background: color-mix(in srgb, currentColor 15%, transparent); }
.ggb-spacer { flex: 1 1 auto; }
.ggb-file { display: none; }
.ggb-frame { flex: 1; min-height: 0; width: 100%; border: 0; background: #fff; display: block; }
.ggb-note { display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; gap: 8px; padding: 24px; text-align: center; font-size: 13px; opacity: .75; }
.ggb-note code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  overflow-wrap: anywhere; opacity: .8; }
.ggb-diag { flex: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; line-height: 1.5; padding: 8px 12px; overflow-wrap: anywhere;
  border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  background: color-mix(in srgb, #f59e0b 14%, transparent); }
`

    function installStyles(text, key) {
      const style = document.createElement('style')
      style.dataset.sideJump = key
      style.textContent = text
      document.head.appendChild(style)
      return style
    }

    // -- blank-frame diagnostics ------------------------------------------
    // The embed page is same-origin, so when the pane comes up empty this reads
    // the frame's own document and reports what it found. A white rectangle says
    // nothing; this says where GeoGebra stopped.
    function inspectFrame(frame) {
      if (!frame) return '未找到 iframe 元素'
      let doc
      try { doc = frame.contentDocument } catch (error) { return `无法访问 iframe 文档（跨源？）: ${error.message}` }
      if (!doc) return 'iframe 尚未加载（contentDocument 为空）'
      const out = []
      out.push(`title=${JSON.stringify(doc.title || '')}`)
      const status = doc.getElementById('status')
      if (status) {
        out.push(`提示=${JSON.stringify((status.textContent || '').trim().slice(0, 120))}`)
        out.push(`提示隐藏=${status.hidden === true}`)
      } else {
        out.push('提示元素=缺失')
      }
      const view = (() => { try { return doc.defaultView } catch { return null } })()
      out.push(`deployggb=${view && view.GGBApplet ? '已加载' : '未加载'}`)
      out.push(`ggbApplet=${view && view.ggbApplet ? '就绪' : '未就绪'}`)
      const inner = doc.querySelector('#applet iframe')
      out.push(`applet-iframe=${inner ? '已创建' : '未创建'}`)
      if (inner) {
        let idoc = null
        try { idoc = inner.contentDocument } catch (error) { out.push(`applet文档不可读: ${error.message}`) }
        if (idoc && idoc.body) out.push(`applet-body长度=${idoc.body.innerHTML.length}`)
      }
      return out.join(' | ')
    }

    /**
     * The pane's view buttons.
     *
     * Same three perspectives the reference front end works in, and the same ids
     * the SetPerspective page documents: 1 = Algebra & Graphics (where functions
     * are entered), 2 = Geometry, 5 = 3D Graphics.
     */
    const PANE_VIEWS = [
      { id: '2d', label: '2D', perspective: '2', title: '切换到 2D 平面几何' },
      { id: '3d', label: '3D', perspective: '5', title: '切换到 3D 立体几何' },
      { id: 'function', label: '函数', perspective: '1', title: '切换到函数视图（代数 & 图形）' },
    ]

    // -- the pane body ----------------------------------------------------
    // Mounted by the right sidebar for every tab of our kind. The iframe is
    // mounted with it, so GeoGebra boots when the tab opens and is torn down when
    // the tab closes or is hidden (`keepMounted` is left false).
    // `sessionId` comes from the slot's `inject` function; it names the Session
    // this tab belongs to, which is how the bridge finds the right applet.
    function GeogebraTab(props) {
      const [info, setInfo] = useState(null)
      const [diag, setDiag] = useState(null)
      const [confirmClear, setConfirmClear] = useState(false)
      const frameRef = useRef(null)
      const fileRef = useRef(null)

      /** The applet behind this pane's own iframe. */
      const appletNow = () => {
        try { return frameRef.current?.contentWindow?.ggbApplet ?? null } catch { return null }
      }

      useEffect(() => {
        let live = true
        callHost('info')
          .then((value) => { if (live) setInfo(value) })
          .catch(() => { if (live) setInfo({ geogebra: { available: true, embedPath: DEFAULT_EMBED } }) })
        return () => { live = false }
      }, [])

      useEffect(() => {
        const timer = setTimeout(() => setDiag(inspectFrame(frameRef.current)), DIAG_DELAY_MS)
        return () => clearTimeout(timer)
      }, [])

      // Publish the frame so the bridge (which lives outside React) can reach the
      // applet one iframe down. Same origin, so `contentWindow.ggbApplet` is ours.
      //
      // Keyed by Session because the pane is kept mounted (see the tab type):
      // several Sessions' panes can be alive at once, each with its own applet,
      // and the bridge must drive the one belonging to the Session on screen.
      useEffect(() => {
        const frame = frameRef.current
        const sessionId = props?.sessionId
        const frames = window.__geogebraFrames ?? (window.__geogebraFrames = new Map())
        // The frame itself remembers its Session. The bridge keys saved drawings by
        // this rather than by asking a service which Session is on screen, because
        // that answer can be missing or differ at the moment a tab closes — and a
        // key mismatch here loses the drawing without a word.
        const owners = window.__geogebraFrameSessions ?? (window.__geogebraFrameSessions = new Map())
        if (sessionId !== undefined) frames.set(sessionId, frame)
        owners.set(frame, sessionId ?? null)
        window.__geogebraFrame = frame
        return () => {
          // Capture before the frame leaves: closing this tab destroys the applet.
          void window.__geogebraFlushState?.()
          if (sessionId !== undefined && frames.get(sessionId) === frame) frames.delete(sessionId)
          owners.delete(frame)
          if (window.__geogebraFrame === frame) delete window.__geogebraFrame
        }
      }, [info])

      const ggb = info?.geogebra
      const embedPath = ggb?.embedPath ?? DEFAULT_EMBED
      const missing = ggb !== undefined && ggb.available === false

      // Download straight from the pane: a person wanting the file should not
      // have to ask the agent for it. `getBase64` is the same export the tool uses.
      const download = () => {
        const api = appletNow()
        if (!api) return
        void exportBase64(api).then((data) => {
          if (typeof data !== 'string' || data === '') return
          const link = document.createElement('a')
          link.href = `data:application/vnd.geogebra.file;base64,${data}`
          link.download = `${exportStamp()}.ggb`
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
        })
      }

      const setView = (perspective) => {
        const api = appletNow()
        if (!api) return
        // GeoGebra ignores a perspective it does not know, so there is nothing to
        // report here; the tool path verifies the switch, the button just asks.
        try { api.setPerspective(perspective) } catch { /* leave the view as it was */ }
      }

      // Two steps rather than a `confirm()`: this is destructive, and a modal is
      // exactly what the pane was just freed of.
      const clearAll = () => {
        const api = appletNow()
        if (!api) return
        if (!confirmClear) {
          setConfirmClear(true)
          setTimeout(() => setConfirmClear(false), 3000)
          return
        }
        setConfirmClear(false)
        try { api.newConstruction() } catch { /* nothing to clear */ }
        // The saved drawing has to go with it, or reopening would bring it back.
        // Pass our own applet: the pane knows exactly which one it just cleared.
        void window.__geogebraForgetState?.(api)
      }

      const openFile = (event) => {
        const file = event?.target?.files?.[0]
        // Clear the input so picking the same file twice still fires a change.
        if (event?.target) event.target.value = ''
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => {
          const api = appletNow()
          if (!api) return
          const text = String(reader.result ?? '')
          // readAsDataURL gives `data:...;base64,XXXX`; setBase64 wants the tail.
          const comma = text.indexOf(',')
          const base64 = comma === -1 ? text : text.slice(comma + 1)
          if (base64 === '') return
          try { api.setBase64(base64) } catch (error) { console.warn('[geogebra-dsh] open file', error) }
        }
        reader.readAsDataURL(file)
      }

      return h('div', { className: 'ggb-pane' },
        missing
          ? null
          : h('div', { className: 'ggb-tools' },
            ...PANE_VIEWS.map((view) => h('button', {
              key: view.id,
              type: 'button',
              className: 'ggb-tool',
              onClick: () => setView(view.perspective),
              title: view.title,
            }, view.label)),
            h('span', { className: 'ggb-sep' }),
            h('button', { type: 'button', className: 'ggb-tool', onClick: () => fileRef.current?.click(), title: '打开 .ggb 文件' }, '打开文件'),
            h('input', { ref: fileRef, type: 'file', accept: '.ggb,application/vnd.geogebra.file', className: 'ggb-file', onChange: openFile }),
            h('button', {
              type: 'button',
              className: confirmClear ? 'ggb-tool ggb-danger' : 'ggb-tool',
              onClick: clearAll,
              title: '删除所有元素',
            }, confirmClear ? '确认删除？' : '删除所有元素'),
            h('span', { className: 'ggb-spacer' }),
            h('button', { type: 'button', className: 'ggb-tool', onClick: download, title: '下载 .ggb 文件' }, '⤓ 下载 .ggb'),
          ),
        missing
          ? h('div', { className: 'ggb-note' },
            h('div', null, '未找到本地 GeoGebra 资源。'),
            h('code', null, ggb.dir),
          )
          : h('iframe', { ref: frameRef, className: 'ggb-frame', src: embedPath, title: 'GeoGebra' }),
        // Only present when the frame stayed empty long enough to be worth
        // explaining; normally the pane is just GeoGebra.
        diag ? h('div', { className: 'ggb-diag' }, `诊断（${window.location.origin}）：${diag}`) : null,
      )
    }

    // GeoGebra's own views, as the DOM names them. Read from the applet's
    // document (same origin), so "did the perspective actually change?" has a real
    // answer — `setPerspective` reports nothing and, like `evalCommand`, stays
    // silent about a perspective it does not recognise.
    const VIEW_CLASSES = [
      ['algebra', 'algebraView'],
      ['graphics', 'graphicsView'],
      ['graphics2d', 'euclidianView'],
      ['graphics3d', 'euclidianView3D'],
      ['spreadsheet', 'spreadsheetView'],
      ['cas', 'casView'],
      ['probability', 'probabilityCalculator'],
    ]

    /** Every pane frame currently mounted; with `keepMounted` that can be several. */
    function mountedFrames() {
      const map = window.__geogebraFrames
      if (map !== undefined && map.size > 0) return [...map.values()]
      return window.__geogebraFrame ? [window.__geogebraFrame] : []
    }

    /** The GeoGebra document behind one applet handle, matched by identity. */
    function documentOf(api) {
      for (const frame of mountedFrames()) {
        try {
          const inner = frame.contentDocument?.querySelector('#applet iframe')
          if (inner && inner.contentWindow?.ggbApplet === api) return inner.contentDocument
        } catch { /* a detached or unreadable frame: try the next */ }
      }
      return null
    }

    /**
     * Read the error dialog GeoGebra puts on screen when a command fails.
     *
     * The applet API has no error channel: of its 2120 exported methods, the only
     * two names that touch errors are `setErrorDialogsActive` (a setter) and
     * `getFileLoadingError` (files only). There is no getter for the last error.
     *
     * The dialog is real though, and the applet is same-origin, so it can be read
     * off the DOM. The markup is stable enough to match on: GeoGebra builds every
     * dialog around a `dialogContent` panel and splits the message on newlines into
     * one label per line, so `textContent` reconstructs the message.
     */
    function watchErrors(api) {
      // Never let interception break execution: no observer, no interception.
      try {
        const doc = documentOf(api)
        if (doc?.body === null || doc?.body === undefined) return null
        // Take the constructor from the applet's own window — the observer must
        // belong to the document it watches, not to the DSH page above it.
        const Observer = doc.defaultView?.MutationObserver ?? window.MutationObserver
        if (typeof Observer !== 'function') return null

        const captured = []
        const observer = new Observer((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node?.nodeType !== 1) continue
              const panel = node.classList?.contains('dialogContent')
                ? node
                : node.querySelector?.('.dialogContent')
              if (panel === null || panel === undefined) continue
              const text = String(panel.textContent ?? '').trim()
              if (text === '') continue
              captured.push(text)
              // Dismiss it. The message is on its way to the caller, and a modal
              // left standing would block the pane for every later command.
              try {
                const button = node.querySelector?.('.gwt-Button') ?? panel.querySelector?.('.gwt-Button')
                button?.click?.()
              } catch { /* an undismissable dialog beats a lost message */ }
            }
          }
        })
        observer.observe(doc.body, { childList: true, subtree: true })
        return { captured, stop: () => observer.disconnect() }
      } catch (error) {
        console.warn('[geogebra-dsh] error watcher unavailable', error)
        return null
      }
    }

    /**
     * Which views are actually on screen, as a sorted list. Null when the applet
     * document cannot be read — the caller must not read that as "no views".
     */
    function viewSignature(api) {
      const doc = documentOf(api)
      if (!doc) return null
      const visible = []
      for (const [label, className] of VIEW_CLASSES) {
        let seen = false
        for (const element of doc.querySelectorAll(`.${className}`)) {
          const box = element.getBoundingClientRect()
          if (box.width > 20 && box.height > 20) { seen = true; break }
        }
        if (seen) visible.push(label)
      }
      return visible.join('+')
    }

    /** `geogebra-20261012-183045`, matching the host tool's default name. */
    function exportStamp() {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      return `geogebra-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
        + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    }

    /**
     * The whole applet as a `.ggb`, base64-encoded.
     *
     * `getBase64` has several shapes; the two-argument one returns synchronously
     * (`b === false` / `b === true` take the sync branch, only a function argument
     * goes through the callback). `true` is the variant the reference project
     * downloads — it carries the views as well as the construction — so that is
     * tried first, and the callback form stays as a fallback for other builds.
     */
    async function exportBase64(api) {
      const attempts = [
        () => api.getBase64(undefined, true),
        () => api.getBase64(),
        () => api.getBase64(undefined, false),
      ]
      for (const attempt of attempts) {
        try {
          const value = attempt()
          if (typeof value === 'string' && value.length > 0) return value
        } catch { /* this build does not answer that way */ }
      }
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), EXPORT_TIMEOUT_MS)
        try {
          api.getBase64((data) => {
            clearTimeout(timer)
            resolve(typeof data === 'string' && data.length > 0 ? data : null)
          })
        } catch {
          clearTimeout(timer)
          resolve(null)
        }
      })
    }

    // -- the applet bridge -------------------------------------------------
    // The agent reaches GeoGebra through the host: a tool queues commands, this
    // half polls for them, runs them on the applet, and reports the result. Edits
    // the user makes by hand travel the same way, told apart from the agent's own
    // work by a depth guard held around every command batch.
    const POLL_MS = 1200
    const SETTLE_MS = 500
    // Each command gets its own settle so the per-command diff attributes the
    // change to the right command; the batch-level settle then catches stragglers.
    const PER_COMMAND_SETTLE_MS = 220
    // A perspective change rebuilds view canvases, so it needs longer than a command.
    const VIEW_SETTLE_MS = 900
    // Saving walks the whole construction to XML, so coalesce bursts of edits.
    const SAVE_DEBOUNCE_MS = 900
    // Building a .ggb zips the whole applet; give a slow machine room.
    const EXPORT_TIMEOUT_MS = 20000
    const DETECT_DEBOUNCE_MS = 400

    function postHost(endpoint, payload) {
      return fetch(INFO_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload }),
      }).then((r) => r.json()).catch(() => null)
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    function createBridge(opener, currentSessionId) {
      let aiDepth = 0
      let lastJson = ''
      let boundTo = null
      let pendingChanges = []
      let stopping = false
      let pollTimer = null
      let settleTimer = null

      // The applet lives one iframe down; same origin, so it is reachable. With
      // the pane kept mounted, several Sessions' panes can be alive at once, so
      // this resolves the one belonging to the Session on screen — and returns
      // null (rather than another Session's applet) when that Session has none
      // open yet, letting ensureApplet open one.
      function applet() {
        const map = window.__geogebraFrames
        const handle = (frame) => {
          if (!frame) return null
          try { return frame.contentWindow?.ggbApplet ?? null } catch { return null }
        }
        // Before the pane registry exists there is nothing to route by and nothing
        // mounted, so the single-pane fallback is safe.
        if (map === undefined || map.size === 0) return handle(window.__geogebraFrame)

        // With several panes alive (`keepMounted`) the on-screen Session is the only
        // correct key. `mounted` is `undefined` in three documented cases — no Session
        // on screen, its store not yet minted, or before its first open — and the
        // last two are exactly what a Session switch looks like. Picking "some mounted
        // pane" there is how a command lands on the Session the user just left.
        //
        // So no answer means no applet, which makes `ensureApplet` open the right one.
        // The sidebar's own public face refuses the same way rather than writing into
        // a surface nobody is drawing.
        const wanted = currentSessionId?.()
        if (wanted === undefined || wanted === null) return null
        return handle(map.get(wanted))
      }

      // -- construction persistence ---------------------------------------
      // The applet lives inside the pane, so closing the pane's tab tears it down
      // and takes the drawing with it. The host keeps the last XML per Session, so
      // reopening — or reloading the page — restores what was there.
      const restored = new WeakSet()
      let lastPerspective = null
      let saveTimer = null
      /** What persistence did, newest last: the only way a silent failure shows. */
      const persistLog = []
      function notePersist(entry) {
        persistLog.push({ ...entry, at: Date.now() })
        if (persistLog.length > 12) persistLog.shift()
      }

      /**
       * Which Session's drawing this is.
       *
       * Taken from the frame that owns this applet, because the pane knows its own
       * Session for certain. Asking a service "which Session is on screen" can
       * answer differently at save time and at restore time, and that mismatch
       * costs the drawing silently — which is exactly the bug this replaced.
       */
      const stateKeyFor = (api) => {
        const owners = window.__geogebraFrameSessions
        if (owners !== undefined) {
          for (const frame of mountedFrames()) {
            try {
              if (frame.contentWindow?.ggbApplet === api) {
                const owner = owners.get(frame)
                if (owner !== undefined && owner !== null) return String(owner)
                break
              }
            } catch { /* a detached frame: keep looking */ }
          }
        }
        const wanted = currentSessionId?.()
        return wanted === undefined || wanted === null ? 'global' : String(wanted)
      }

      function captureState(api) {
        try {
          const xml = api.getXML?.()
          return typeof xml === 'string' && xml.length > 0 ? xml : null
        } catch { return null }
      }

      function scheduleSave() {
        clearTimeout(saveTimer)
        saveTimer = setTimeout(() => { void saveNow() }, SAVE_DEBOUNCE_MS)
      }

      /** Write the construction now. Also the pane's last act before it unmounts. */
      async function saveNow() {
        clearTimeout(saveTimer)
        const refuse = (reason) => {
          notePersist({ what: 'save', ok: false, reason })
          return { ok: false, reason }
        }
        const api = applet()
        if (api === null) return refuse('没有 applet')
        const xml = captureState(api)
        if (xml === null) return refuse('没有可保存的作画')
        // A drawing that is only a view change still has objects; nothing to say
        // about an empty one, and saving it would erase a good earlier state.
        let count = 0
        try { count = api.getObjectNumber() || 0 } catch { count = 0 }
        if (count === 0) return refuse('作图是空的，保留上一次的状态')
        const key = stateKeyFor(api)
        const answer = await postHost('save-state', { key, xml, perspective: lastPerspective })
        const value = answer?.value
        const ok = value?.ok === true
        notePersist({ what: 'save', key, ok, bytes: xml.length, objects: count, ...ok ? {} : { reason: value?.reason ?? answer?.error?.message ?? '宿主没有接受' } })
        if (!ok) console.warn('[geogebra-dsh] save rejected', key, value ?? answer)
        return { ok, key, value }
      }

      /**
       * Drop this Session's saved drawing.
       *
       * Separate from saving an empty construction, which is refused on purpose:
       * that rule protects a good drawing from a closed pane, so an explicit clear
       * has to say so in its own words.
       */
      async function forget(explicit) {
        clearTimeout(saveTimer)
        // The caller passes its own applet when it has one: the button knows which
        // pane it belongs to, so there is no reason to ask "which is on screen".
        const api = explicit ?? applet()
        if (api === null || api === undefined) return { ok: false, reason: '没有 applet' }
        const key = stateKeyFor(api)
        const answer = await postHost('clear-state', { key })
        const ok = answer?.value?.ok === true
        notePersist({ what: 'forget', key, ok, ...ok ? {} : { reason: '宿主没有接受' } })
        return { ok, key }
      }

      /**
       * Put back what the host remembers, once per applet instance.
       *
       * Only into an empty applet: a live drawing is the truth, and a stale save
       * must never overwrite it.
       */
      async function restoreIfNeeded(api) {
        if (restored.has(api)) return
        restored.add(api)
        let count = 0
        try { count = api.getObjectNumber() || 0 } catch { count = 0 }
        if (count > 0) {
          notePersist({ what: 'restore', ok: true, skipped: `applet 里已有 ${count} 个对象，不覆盖` })
          return
        }
        const key = stateKeyFor(api)
        const answer = await postHost('load-state', { key })
        const saved = answer?.value
        if (saved === null || saved === undefined) {
          notePersist({ what: 'restore', key, ok: false, reason: answer === null ? '宿主没有响应（端点不存在？需要重启 DSH）' : '宿主里没有这个会话的存档' })
          return
        }
        if (typeof saved.xml !== 'string' || saved.xml === '') {
          notePersist({ what: 'restore', key, ok: false, reason: '存档是空的' })
          return
        }
        aiDepth += 1
        try {
          api.setXML(saved.xml)
          if (typeof saved.perspective === 'string' && saved.perspective !== '') {
            try { api.setPerspective(saved.perspective) } catch { /* the layout may be gone */ }
            lastPerspective = saved.perspective
          }
          await sleep(VIEW_SETTLE_MS)
          // Re-baseline: a restore is not something the user did.
          lastJson = JSON.stringify(snapshotOf(api))
          notePersist({ what: 'restore', key, ok: true, bytes: saved.xml.length, objects: (snapshotOf(api) ?? []).length })
        } catch (error) {
          notePersist({ what: 'restore', key, ok: false, reason: String(error?.message ?? error) })
          console.warn('[geogebra-dsh] restore construction', error)
        } finally {
          aiDepth -= 1
        }
      }

      function snapshotOf(api) {
        let count = 0
        try { count = api.getObjectNumber() || 0 } catch { count = 0 }        const out = []
        for (let index = 0; index < count; index += 1) {
          let name = ''
          try { name = api.getObjectName(index) || '' } catch { name = '' }
          if (!name) continue
          let definition = ''
          let value = ''
          // Not every build exposes both; an absent reader is not a failure.
          try { definition = api.getCommandString(name) || '' } catch { definition = '' }
          try { value = api.getValueString(name) || '' } catch { value = '' }
          // Style lives outside definition/value. `SetColor`, `SetLineThickness`,
          // `SetPointSize` and `SetFilling` change nothing else, so without these
          // a style command that worked leaves the fingerprint identical — and the
          // verdict below would have nothing to fall back on.
          let style = ''
          try {
            style = [
              api.getColor?.(name), api.getLineThickness?.(name),
              api.getPointSize?.(name), api.getFilling?.(name),
            ].join(',')
          } catch { style = '' }
          out.push({ name, definition, value, style })
        }
        return out
      }

      function diff(previous, next) {
        const before = new Map(previous.map((o) => [o.name, o]))
        const after = new Map(next.map((o) => [o.name, o]))
        const changes = []
        for (const [name, object] of after) {
          const old = before.get(name)
          if (old === undefined) changes.push({ kind: 'added', name, definition: object.definition })
          else if (old.definition !== object.definition || old.value !== object.value) {
            changes.push({ kind: 'updated', name, from: old.value, to: object.value, definition: object.definition })
          }
        }
        for (const [name, object] of before) {
          if (!after.has(name)) changes.push({ kind: 'removed', name, definition: object.definition })
        }
        return changes
      }

      async function flushChanges() {
        if (pendingChanges.length === 0) return
        const batch = pendingChanges
        pendingChanges = []
        await postHost('changes', { changes: batch })
      }

      /** Compare the construction against the last baseline, attributing the delta to the user. */
      function checkUserChanges() {
        if (stopping || aiDepth > 0) return
        const api = applet()
        if (api === null) return
        let next
        try { next = snapshotOf(api) } catch { return }
        const json = JSON.stringify(next)
        if (json === lastJson) return
        let previous = []
        try { previous = JSON.parse(lastJson || '[]') } catch { previous = [] }
        lastJson = json
        const changes = diff(previous, next)
        if (changes.length === 0) return
        pendingChanges.push(...changes)
        void flushChanges()
        // A hand edit is worth keeping too, not just the agent's work.
        scheduleSave()
      }

      /** Attach the change listeners once, per applet instance. */
      function bind(api) {
        if (boundTo === api) return
        boundTo = api
        // Baseline taken now: anything already drawn is not a "change".
        try { lastJson = JSON.stringify(snapshotOf(api)) } catch { lastJson = '' }
        // Coalesce bursts (a dragged slider fires on every frame).
        const check = () => {
          clearTimeout(settleTimer)
          settleTimer = setTimeout(checkUserChanges, DETECT_DEBOUNCE_MS)
        }
        for (const name of ['registerAddListener', 'registerRemoveListener', 'registerUpdateListener', 'registerClickListener']) {
          try { api[name]?.(check) } catch { /* this build may not offer it */ }
        }
      }

      /** Reach the applet, opening the pane first if it was never opened. */
      async function ensureApplet() {
        const now = applet()
        if (now !== null) return now
        const deadline = Date.now() + 30000
        let attempt = 0
        while (!stopping && Date.now() < deadline) {
          // Re-ask every few tries. A brand-new session mints the column's
          // per-session store only once its own seat renders, so the first
          // openTab can fail through no fault of the caller's.
          if (attempt % 4 === 0) opener()
          attempt += 1
          await sleep(400)
          const api = applet()
          if (api !== null) return api
        }
        return null
      }

      /**
       * Run one batch with the depth guard held, then re-baseline.
       *
       * GeoGebra's `evalCommand` does NOT throw on a bad command — it quietly
       * leaves the construction alone. Success is judged from three signals: the
       * error dialog GeoGebra puts on screen (see `watchErrors`), the labels
       * `evalCommandGetLabels` reports, and whether the construction changed.
       */
      async function runBatch(batch, api) {
        aiDepth += 1
        const watcher = watchErrors(api)
        try {
          const results = []
          // `evalCommand` returns whether evaluation succeeded — the manual says so
          // and the build agrees (`return eSl(...)`, and `eSl` returns `e != null`).
          // `evalCommandGetLabels` returns the labels *instead* and drops that
          // verdict, so the boolean is preferred and labels come from the diff.
          const canJudge = typeof api.evalCommand === 'function'
          const canReadLabels = typeof api.evalCommandGetLabels === 'function'
          let previous = snapshotOf(api)
          for (const command of batch.commands ?? []) {
            const text = String(command)
            const before = JSON.stringify(previous)
            const seen = watcher?.captured.length ?? 0
            let labels = ''
            let verdict = null
            let threw = null
            try {
              if (canJudge) {
                const outcome = api.evalCommand(text)
                // Only a real boolean is a verdict. A build that returns nothing
                // tells us nothing — reading `undefined` as "refused" would fail
                // every single command.
                verdict = typeof outcome === 'boolean' ? outcome : null
              } else if (canReadLabels) {
                labels = String(api.evalCommandGetLabels(text) ?? '')
              } else {
                threw = '这个 build 既没有 evalCommand 也没有 evalCommandGetLabels，无法执行'
              }
            } catch (error) {
              threw = String(error?.message ?? error)
            }
            // Give GeoGebra a beat to apply, so the diff below sees this command.
            await sleep(PER_COMMAND_SETTLE_MS)
            const next = snapshotOf(api)
            const changed = JSON.stringify(next) !== before
            // Labels are the objects that appeared — the same thing
            // `evalCommandGetLabels` would have named, and free from the diff.
            const appeared = next
              .filter((object) => !previous.some((was) => was.name === object.name))
              .map((object) => object.name)
              .join(',')
            const created = labels.trim() !== '' ? labels.trim() : appeared
            // A dialog raised while this command ran is GeoGebra saying why it
            // refused — a direct signal, better than inferring from side effects.
            const dialogs = watcher === null ? [] : watcher.captured.slice(seen)
            const said = dialogs.join(' / ')
            // `verdict === true` is authoritative. `verdict === false` is NOT: for
            // the style/scripting commands GeoGebra returns false even when the
            // command applied. Verified against the exported XML — after
            // `SetColor(c,"red")` and `SetLineThickness(c,13)` were both reported
            // false, the XML showed objColor r=255 g=0 b=0 and thickness="13".
            // So a false verdict only stands when nothing actually moved.
            const changedSomething = created !== '' || changed
            const effective = threw === null && dialogs.length === 0
              && (verdict === true || changedSomething)
            // The boolean disagreeing with the observed effect is worth saying out
            // loud: it is the difference between "your command is wrong" and "the
            // style applied, GeoGebra just does not report success for it".
            const disagree = verdict === false && changedSomething
            results.push({
              command: text,
              ok: effective,
              ...created !== '' ? { labels: created } : {},
              ...verdict === null ? {} : { accepted: verdict },
              ...disagree ? { note: 'GeoGebra 的返回值为 false，但图形确实变了 —— 样式类指令不返回成功' } : {},
              ...dialogs.length > 0 ? { geogebraError: said } : {},
              ...threw !== null ? { error: threw }
                : effective ? {}
                : dialogs.length > 0 ? { error: `GeoGebra 报错：${said}` }
                : verdict === false ? { error: 'GeoGebra 判定这条命令无效（evalCommand 返回 false）' }
                : { error: '没有任何效果：没有创建对象，也没有改动现有对象（命令语法可能有误）' },
            })
            previous = next
          }
          // GeoGebra keeps applying after the last command too; baseline after it.
          await sleep(SETTLE_MS)
          const objects = snapshotOf(api)
          lastJson = JSON.stringify(objects)
          // Keep the agent's work across a pane close, like the user's own edits.
          scheduleSave()
          // Carried with every report so `geogebra_state` can show what
          // persistence has been doing — a silent failure here is invisible.
          return {
            id: batch.id,
            results,
            objects,
            persist: persistLog.slice(-6),
            // `session` is the Session this applet belongs to; `onScreen` is what the
            // sidebar says is on screen. They must agree — showing both is how a
            // routing mistake stops being invisible.
            session: stateKeyFor(api),
            onScreen: currentSessionId?.() ?? null,
          }
        } finally {
          watcher?.stop()
          aiDepth -= 1
        }
      }

      /**
       * Switch the perspective. Verified the same way commands are: GeoGebra
       * accepts an unknown perspective in silence, so success is judged by
       * whether the set of visible views actually changed.
       */
      async function runView(batch, api) {
        aiDepth += 1
        try {
          const perspective = String(batch.view?.perspective ?? '')
          const before = viewSignature(api)
          let threw = null
          try { api.setPerspective(perspective) } catch (error) { threw = String(error?.message ?? error) }
          // Switching views re-lays-out and rebuilds the 3D canvas; give it room.
          await sleep(VIEW_SETTLE_MS)
          const after = viewSignature(api)
          // Remember it only when it actually took, so a restore replays a layout
          // that worked rather than one GeoGebra ignored.
          if (before !== null && after !== null && before !== after) {
            lastPerspective = perspective
            scheduleSave()
          }
          const objects = snapshotOf(api)
          lastJson = JSON.stringify(objects)
          return {
            id: batch.id,
            results: [],
            objects,
            session: stateKeyFor(api),
            view: {
              perspective,
              before,
              after,
              // Null on either side means the applet document was unreadable, not
              // that nothing changed.
              changed: before !== null && after !== null && before !== after,
              ...threw !== null ? { error: threw } : {},
            },
          }
        } finally {
          aiDepth -= 1
        }
      }

      /** Hand the applet's bytes back to the host, which writes the file. */
      async function runExport(batch, api) {
        aiDepth += 1
        try {
          const format = batch.export?.format === 'xml' ? 'xml' : 'ggb'
          const objects = snapshotOf(api)
          let data = null
          let error
          if (format === 'xml') {
            try { data = api.getXML?.() ?? null } catch (cause) { error = String(cause?.message ?? cause) }
          } else {
            data = await exportBase64(api)
          }
          if (typeof data !== 'string' || data === '') {
            error = error ?? `GeoGebra 没有返回 ${format.toUpperCase()} 内容（该 build 可能不支持导出）`
          }
          return { id: batch.id, results: [], objects, session: stateKeyFor(api), export: { format, data, ...error === undefined ? {} : { error } } }
        } finally {
          aiDepth -= 1
        }
      }

      async function tick() {
        // Name the Sessions that have a live pane on every poll. The host uses it
        // to decide whether this plugin's guidance belongs in a Session's system
        // prompt at all — a Session that never opened GeoGebra should not carry it.
        const sessions = window.__geogebraFrames === undefined ? [] : [...window.__geogebraFrames.keys()]
        const answer = await postHost('poll', { sessions })
        const batches = answer?.value?.commands ?? []
        for (const batch of batches) {
          if (stopping) return
          const api = await ensureApplet()
          if (api === null) {
            // Carry the opener's own complaint back: "no session on screen" and
            // "the column has not minted this session's store yet" need very
            // different fixes, and only the opener knows which happened.
            const why = window.__geogebraOpenError
            await postHost('report', {
              id: batch.id,
              error: `没能打开 GeoGebra pane${why ? `：${why}` : ''}。确认当前会话在屏幕上、右侧栏可以打开，然后重试。`,
            })
            continue
          }
          bind(api)
          const report = batch.export !== undefined ? await runExport(batch, api)
            : batch.view === undefined ? await runBatch(batch, api)
            : await runView(batch, api)
          await postHost('report', report)
        }
      }

      async function loop() {
        if (stopping) return
        // Listen for hand edits even while no command is in flight.
        const api = applet()
        if (api !== null) {
          bind(api)
          // A freshly mounted pane starts empty; put back what the host remembers.
          try { await restoreIfNeeded(api) } catch (error) { console.warn('[geogebra-dsh] restore', error) }
        }
        try { checkUserChanges() } catch { /* a transient applet state is not fatal */ }
        try { await tick() } catch (error) { console.warn('[geogebra-dsh] bridge poll', error) }
      }

      return {
        start() {
          stopping = false
          pollTimer = setInterval(loop, POLL_MS)
          void loop()
        },
        stop() {
          stopping = true
          clearInterval(pollTimer)
          clearTimeout(settleTimer)
          clearTimeout(saveTimer)
          // The pane is going away and the applet with it: keep the drawing.
          void saveNow()
        },
        // For the pane's own unmount, which does not stop the bridge. The capture
        // is synchronous, so it is safe to call just before the frame is dropped.
        flush: saveNow,
        forget,
      }
    }

    /**
     * Renders nothing, on purpose. It occupies the `main` key that the sidebar's
     * panel icon dispatches, so the seat exists and the icon stays live — the
     * selection is bounced away again by an effect before anyone sees it.
     */
    function Nothing() {
      return null
    }

    // -- registration -----------------------------------------------------
    const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'layout']

    function apply(ctx) {
      console.log('[geogebra-dsh] apply called')
      ctx.effect(() => {
        const style = installStyles(CSS, 'page')
        return () => style.remove()
      }, 'geogebra-dsh: styles')

      // The tab type. `title` names the chip; `guide` adds the entry box the
      // column's guide page lists, which is the discoverable way in.
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        multiple: false,
        // Without this the pane is torn down on every Session change, and the
        // applet — plus the drawing — reloads from scratch each time. Keep the
        // visited body mounted through hiding, Session changes and docking.
        keepMounted: true,
        priority: 'extension',
        title: () => 'GeoGebra',
        guide: [{
          id: 'geogebra',
          order: 30,
          title: () => 'GeoGebra',
          description: () => '在右侧栏打开 GeoGebra 绘图区',
        }],
      }), 'geogebra-dsh: geogebra tab type')

      // The pane body, dispatched with the type's own id.
      //
      // `inject` is the seat's way of handing the body its Session: the slot calls
      // it with the session id and the returned object becomes the component's
      // props. `renderSlot` passes `{}` on its own, so without this the pane has no
      // idea which Session it belongs to — and the frame registry below, which is
      // keyed by Session, would stay empty forever.
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        inject: (sessionId) => ({ sessionId }),
      }, GeogebraTab))

      // Bringing the pane up is two steps, and the order matters: the right
      // column mints each session's store when its own seat renders, and
      // `openTab` acts through that store — so it fails loudly while the column
      // is still closed, which is exactly the state a fresh session starts in.
      // Both steps can legitimately fail on a first try, so the failure reason is
      // kept where the bridge can report it.
      const reveal = () => {
        try { ctx.layout.openRightbar(true, false) } catch (error) {
          window.__geogebraOpenError = String(error?.message ?? error)
          console.warn('[geogebra-dsh] openRightbar', error)
          return
        }
        try {
          ctx.sidebarRight.openTab(TAB_KIND, { revealIfOpened: true })
          delete window.__geogebraOpenError
        } catch (error) {
          window.__geogebraOpenError = String(error?.message ?? error)
          console.warn('[geogebra-dsh] openTab', error)
        }
      }
      // The entry sits in the sidebar's global panel row, right after the RSS
      // reader — the same seat the shipped panel icons use.
      //
      // That seat's click belongs to the sidebar: it calls `selectPanel(id)`, and
      // the registered component is only the glyph. So the icon is paired with a
      // deliberately empty `main` panel, and the bounce below turns the click into
      // what we actually want — the right-hand GeoGebra pane.
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: 'GeoGebra',
      }, GeoGebraIcon))

      // The empty seat the icon dispatches to. Without an occupant the sidebar has
      // no panel for the id to address.
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, Nothing))

      // The bounce: the moment our panel is selected, give the centre back to
      // whatever was showing and open the pane instead. Restoring first keeps the
      // empty panel from staying visible beyond a frame.
      ctx.effect(() => {
        let previous = null
        const sync = () => {
          let active = null
          try { active = ctx.layout?.panelInfo?.getSnapshot?.()?.activePanelId ?? null } catch { return }
          if (active !== PANEL_ID) { previous = active; return }
          try { ctx.layout.selectPanel(previous) } catch (error) {
            console.warn('[geogebra-dsh] selectPanel', error)
          }
          reveal()
        }
        const off = ctx.layout?.panelInfo?.subscribe?.(sync)
        sync()
        return () => { if (typeof off === 'function') off() }
      }, 'geogebra-dsh: panel entry')

      // The agent's way in: a tool asks for work and this half opens the pane
      // itself when the applet is not up yet.
      ctx.effect(() => {
        window.__geogebraOpenTab = reveal
        return () => {
          delete window.__geogebraOpenTab
          delete window.__geogebraOpenError
        }
      }, 'geogebra-dsh: open handler')

      // The Session the right sidebar is drawing. Its own `mounted` observable is
      // the authority — it is the same Session `openTab` acts on — with the main
      // column as a fallback for the moment before the service has named one.
      const currentSessionId = () => {
        try {
          const mounted = ctx.sidebarRight?.mounted?.getSnapshot?.()
          if (mounted !== undefined && mounted !== null) return mounted
        } catch { /* fall through to the session list */ }
        const byId = ctx.sessions?.list?.getSnapshot?.()?.byId ?? {}
        for (const session of Object.values(byId)) {
          if ((session?.retainedBy?.mainView ?? 0) > 0) return session.id
        }
        return null
      }

      const bridge = createBridge(() => window.__geogebraOpenTab?.(), currentSessionId)
      ctx.effect(() => {
        window.__geogebraFlushState = () => bridge.flush()
        // An explicit "clear everything" must drop the saved drawing too, or the
        // next open would faithfully restore what the user just deleted.
        window.__geogebraForgetState = (api) => bridge.forget(api)
        bridge.start()
        return () => {
          bridge.stop()
          delete window.__geogebraFlushState
          delete window.__geogebraForgetState
        }
      }, 'geogebra-dsh: geogebra bridge')
    }

    const module = { exports: {} }
    module.exports.PANEL_ID = PANEL_ID
    module.exports.TAB_ID = TAB_ID
    module.exports.inject = inject
    module.exports.apply = apply
    return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: 'Module' })
  },
})
