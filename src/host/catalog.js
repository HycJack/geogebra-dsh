// The GeoGebra reference this plugin validates against, kept offline.
//
// Two catalogs, both embedded so validation costs no network round trip:
//
//   COMMANDS        — GeoGebra's own command names (see catalog-commands.js)
//   APP_PARAMETERS  — the GGBApplet parameters, from
//                     https://geogebra.github.io/docs/reference/en/GeoGebra_App_Parameters/
//
// and the perspective grammar, from
// https://geogebra.github.io/docs/manual/en/commands/SetPerspective/ — which the
// App Parameters page names as the authority for the `perspective` parameter.
//
// Docs live at https://geogebra.github.io/docs/manual/en/commands/<Name>/; the
// lookup tools hand that URL out rather than guessing at syntax.

import { COMMANDS, COMMAND_INDEX, COMMAND_COUNT } from './catalog-commands.js'

export { COMMANDS, COMMAND_INDEX, COMMAND_COUNT }

export const COMMAND_DOCS_BASE = 'https://geogebra.github.io/docs/manual/en/commands/'

/** The manual page for one command name. */
export function commandDocUrl(name) {
  return `${COMMAND_DOCS_BASE}${encodeURIComponent(String(name ?? ''))}/`
}

// ---------------------------------------------------------------------------
// Perspectives

/**
 * View letters, from the SetPerspective manual page. The value is the view each
 * letter shows; `note` covers the ones whose letter is not the obvious one.
 */
export const VIEW_LETTERS = {
  A: { view: 'Algebra', label: '代数' },
  B: { view: 'Probability Calculator', label: '概率计算器', note: '不是 P —— P 是属性面板' },
  C: { view: 'CAS', label: 'CAS' },
  D: { view: 'Graphics 2', label: '绘图区 2' },
  G: { view: 'Graphics', label: '绘图区' },
  L: { view: 'Construction Protocol', label: '作图过程' },
  P: { view: 'Properties', label: '属性面板' },
  R: { view: 'Data analysis', label: '数据分析（仅桌面版）' },
  S: { view: 'Spreadsheet', label: '表格区' },
  T: { view: '3D Graphics', label: '3D 绘图区' },
}

/** Predefined perspectives, selected by a single digit. */
export const STANDARD_PERSPECTIVES = {
  1: { label: '代数 & 图形', equivalent: 'AG' },
  2: { label: '几何', equivalent: 'G' },
  3: { label: '表格', equivalent: 'SG' },
  4: { label: 'CAS', equivalent: 'CG' },
  5: { label: '3D 绘图', equivalent: 'AT' },
  6: { label: '概率', equivalent: 'B' },
}

/**
 * The perspective string grammar, so a caller can compose rather than guess.
 * `Tools` and `Table` only exist outside GeoGebra Classic.
 */
export const PERSPECTIVE_SYNTAX = [
  '并列 = 水平排列，例如 "AGS" = 代数 + 绘图 + 表格 横排',
  '斜杠 = 上下分割，例如 "S/G" = 表格在上、绘图在下',
  '括号 = 分组，例如 "S/(GA)" = 下方再左右分成绘图与代数',
  '前缀 + / - = 单个视图的开与关，例如 "+D" 增加绘图区 2、"-D" 移除',
  '"+Tools" / "+Table" = 在非 Classic 应用里打开侧栏的工具页 / 数值表（"-Tools" 关闭）',
  '单个数字 = 预定义视角（1 代数&图形 / 2 几何 / 3 表格 / 4 CAS / 5 3D / 6 概率）',
]

// ---------------------------------------------------------------------------
// Applet parameters
//
// name -> [value shape, description, since]. Ported from the App Parameters
// reference; descriptions are condensed, and `default:` mirrors the manual.

export const APP_PARAMETERS = {
  appName: ['eg "graphing"', '应用名，默认 "classic"。可选 graphing / geometry / 3d / classic / suite / evaluator / scientific / notes', '6.0'],
  width: ['eg 800', '宽度（用了 scaleContainerClass 则可不填）', ''],
  height: ['eg 600', '高度（用了 scaleContainerClass 则可不填）', ''],
  material_id: ['eg "RHYH3UQ8"', '要载入的 GeoGebra Materials id', '5.0'],
  filename: ['eg "myFile.ggb"', '要载入的文件 URL', '4.0'],
  ggbBase64: ['base64 .ggb', '直接载入编码后的 .ggb', '4.0'],
  borderColor: ['hex，如 #FFFFFF', '外框颜色。默认 gray', '3.0'],
  borderRadius: ['number', '圆角半径（px）', '6.0'],
  enableRightClick: ['true | false', '右键是否交给 applet；false 会禁用右键菜单与右键缩放。默认 true', '3.0'],
  enableLabelDrags: ['true | false', '标签是否可拖动。默认 true', '3.2'],
  enableShiftDragZoom: ['true | false', 'Shift+拖拽平移 / Shift+滚轮缩放。默认 true', '3.0'],
  showZoomButtons: ['true | false', '是否显示放大/缩小/复位按钮。默认 false', '6.0'],
  errorDialogsActive: ['true | false', '**输入无效时是否弹错误对话框**（输入栏与 JavaScript 都算）。默认 true', '3.2'],
  showMenuBar: ['true | false', '菜单栏。默认 false', '2.5'],
  showToolBar: ['true | false', '工具栏。默认 false', '2.5'],
  showToolBarHelp: ['true | false', '工具栏右侧的帮助文字', '3.0'],
  customToolBar: ['如 "0 1 2 3 , 4 5 6 7"', '自定义工具栏字符串，会覆盖 .ggb 里保存的', '2.5'],
  customToolbox: ['如 "pen, shapes.line"', 'Notes 应用的工具栏内容', '6.0'],
  showAlgebraInput: ['true | false', '代数输入行。默认 false', '2.5'],
  showResetIcon: ['true | false', '右上角复位图标。默认 false', '2.5'],
  language: ['ISO 语言码', '手动指定语言', '2.5'],
  country: ['ISO 国家码，如 AT', '配合 language 使用', '2.5'],
  id: ['eg applet2', '传给 ggbOnInit() 的参数名，一页多个 applet 时有用', '3.2'],
  allowStyleBar: ['true | false', '样式栏。默认 false', '4.0'],
  randomize: ['true | false', '载入时是否重新随机。默认 true', '6.0'],
  randomSeed: ['eg 33', '随机数种子', '5.0'],
  appletOnLoad: ['function(api){…}', 'applet 初始化完成（且文件载入完）后执行', '5.0'],
  useBrowserForJS: ['true | false', 'true 时跑 HTML 里的 ggbOnInit 并忽略文件里的脚本。默认 false', '4.0'],
  showLogging: ['true | false', '是否往浏览器控制台打日志。默认 false', '4.2'],
  capturingThreshold: ['integer', '选取灵敏度，默认 3；调大更好点选拖动', '4.4'],
  enableFileFeatures: ['true | false', '文件保存/载入/登录等。默认 true（菜单栏不显示时忽略）', '5.0'],
  enableUndoRedo: ['true | false', '撤销/重做按钮。默认 true（工具栏不显示时忽略）', '6.0'],
  perspective: ['string', '**初始布局；取值见 SetPerspective 指令**。只用于空白起始，别和 material_id / filename / ggbBase64 同用', '5.0'],
  enable3d: ['true | false | 空', '是否启用 3D（考试模式）。留空则弹窗让用户选', '5.0'],
  enableCAS: ['true | false | 空', '是否启用 CAS（考试模式）。留空则弹窗让用户选', '5.0'],
  algebraInputPosition: ['algebra | top | bottom', '输入栏位置。留空由文件决定', '5.0'],
  preventFocus: ['true | false', '启动时不自动获取焦点。默认 false', '5.0'],
  scaleContainerClass: ['String', '用作容器的 CSS 类名，applet 会缩放填满', '5.0'],
  autoHeight: ['boolean', 'true 时限制宽度、自动算高度', '5.0'],
  allowUpscale: ['true | false', '自动缩放是否允许放大。默认 false', '5.0'],
  playButton: ['true | false', '用预览图 + 播放按钮代替 applet，点击才初始化。默认 false', '5.0'],
  scale: ['number', '整体缩放比例（含文字与 UI）。默认 1', '5.0'],
  showAnimationButton: ['true | false', '动画按钮是否可见', '5.0'],
  showFullscreenButton: ['true | false', '全屏按钮是否可见', '6.0'],
  showSuggestionButtons: ['true | false', '代数区的建议按钮（特殊点、解方程）是否可见', '6.0'],
  showStartTooltip: ['true | false', '是否显示欢迎提示', '5.0'],
  rounding: ['string', '"10" = 10 位小数，"10s" = 10 位有效数字，"10r" = 有理数', '6.0'],
  buttonShadows: ['true | false', '按钮是否有阴影', '6.0'],
  buttonRounding: ['0 – 0.9', '按钮圆角相对半径，默认 0.2', '6.0'],
  buttonBorderColor: ['hex', '绘图区按钮边框色', '6.0'],
  editorBackgroundColor: ['hex', 'evaluator 应用的背景色', '6.0'],
  editorForegroundColor: ['hex', 'evaluator 应用的前景色', '6.0'],
  textmode: ['true | false', '编辑器是否文本模式（evaluator）。默认 false', '6.0'],
  showKeyboardOnFocus: ['false | true | auto', '聚焦输入时是否弹键盘', '6.0'],
  keyboardType: ['scientific | normal | notes', 'evaluator 的键盘类型', '6.0'],
  transparentGraphics: ['true | false', '绘图区 1/2 是否透明', '6.0'],
  disableJavaScript: ['true | false', '是否禁止素材文件里的 JavaScript', '6.0'],
  detachKeyboard: ['true | false | auto', '键盘是否与 applet 分离。默认 auto', '6.0'],
  detachedKeyboardParent: ['String', '键盘挂到第一个匹配选择器的元素上', '6.0'],
}

// ---------------------------------------------------------------------------
// Command-name extraction and validation

const IDENTIFIER_CALL = /([A-Za-z][A-Za-z0-9_]*)\s*\(/g

/** Index of the `)` matching the `(` at `openIndex`, skipping string literals. */
function matchingParen(source, openIndex) {
  let depth = 0
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"') {
      index += 1
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') index += 1
        index += 1
      }
      continue
    }
    if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Blank out string literals, keeping every index in place.
 *
 * Without this, text *inside* a string reads as code: `Text("Hi (there)")` would
 * offer `Hi` as a command name.
 */
function maskStrings(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    if (source[index] !== '"') {
      out += source[index]
      index += 1
      continue
    }
    out += ' '
    index += 1
    while (index < source.length && source[index] !== '"') {
      if (source[index] === '\\' && index + 1 < source.length) {
        out += '  '
        index += 2
        continue
      }
      out += ' '
      index += 1
    }
    if (index < source.length) {
      out += ' '
      index += 1
    }
  }
  return out
}

/**
 * The command names a line plausibly calls.
 *
 * Heuristic, and honest about it: GeoGebra has no "parse the commands in this
 * string" API, so this looks for `Name(` and filters the shapes that are not
 * commands — a function definition (`f(x)=…`, which GeoGebra lets you write with
 * a single letter), a bare coordinate list like `(1,2)`, which never starts with
 * an identifier, and anything inside a string literal.
 */
/**
 * GeoGebra's **predefined functions** — called with parentheses, but not commands.
 *
 * They are not in the 549-command table, so without this list `sqrt(3)` and
 * `f(x)=sin(x)` look like mistyped command names and get refused. That is a false
 * positive that blocks working input, which is worse than the miss it guards
 * against: a name that really is wrong is silently ignored by GeoGebra and caught
 * by the per-command verdict afterwards.
 *
 * Taken from the official manual page "Predefined Functions and Operators"
 * (https://geogebra.github.io/docs/manual/en/Predefined_Functions_and_Operators/),
 * plus the logic operators documented under "Boolean values".
 */
const FUNCTIONS = new Set([
  'ABS', 'ALT', 'ARG', 'CONJUGATE', 'IMAGINARY', 'REAL', 'SGN', 'SIGN',
  'CEIL', 'FLOOR', 'ROUND', 'SQRT', 'CBRT', 'NROOT',
  'EXP', 'LD', 'LG', 'LN', 'LOG', 'RANDOM', 'NPR',
  'ACOS', 'ACOSD', 'ACOSH', 'ACOT', 'ACSC', 'ASEC', 'ASIN', 'ASIND', 'ASINH',
  'ATAN', 'ATAN2', 'ATAN2D', 'ATAND', 'ATANH', 'ARCCOS', 'ARCCOSH', 'ARCSIN',
  'ARCSINH', 'ARCTAN', 'ARCTANH',
  'COS', 'COSEC', 'COSH', 'COT', 'COTAN', 'COTANH', 'COTH', 'CSC', 'CSCH',
  'SEC', 'SECH', 'SIN', 'SINH', 'TAN', 'TANH',
  'BETA', 'BETAREGULARIZED', 'ERF', 'GAMMA', 'GAMMAREGULARIZED', 'LAMBERTW',
  'POLYGAMMA', 'PSI', 'ZETA', 'COSINTEGRAL', 'EXPINTEGRAL', 'SININTEGRAL',
  'IF', 'NOT', 'AND', 'OR', 'XOR',
])


export function extractCommandNames(text) {
  const source = maskStrings(String(text ?? ''))
  const found = []
  IDENTIFIER_CALL.lastIndex = 0
  let match
  while ((match = IDENTIFIER_CALL.exec(source)) !== null) {
    const name = match[1]
    const open = match.index + match[0].length - 1
    const close = matchingParen(source, open)
    // `Name(…) = …` defines a function; it is not a call to a command.
    if (close !== -1 && /^\s*=/.test(source.slice(close + 1))) continue
    // Single letters are how GeoGebra writes user functions and variables.
    if (name.length === 1) continue
    // Predefined functions are called the same way but are not commands.
    if (FUNCTIONS.has(name.toUpperCase())) continue
    if (!found.includes(name)) found.push(name)
  }
  return found
}

/** Bounded Levenshtein distance; `max` lets it bail early on hopeless pairs. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let previous = new Array(b.length + 1)
  let current = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) previous[j] = j
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    let best = current[0]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      if (current[j] < best) best = current[j]
    }
    if (best > max) return max + 1
    const swap = previous
    previous = current
    current = swap
  }
  return previous[b.length]
}

/** Catalog names closest to a mistyped one: the whole point of the check. */
export function suggestCommand(name, limit = 5) {
  const wanted = String(name ?? '').toUpperCase()
  if (wanted === '') return []
  const scored = []
  for (const candidate of COMMANDS) {
    const upper = candidate.toUpperCase()
    let score = null
    if (upper === wanted) score = 0
    else if (upper.startsWith(wanted) || wanted.startsWith(upper)) score = 1
    else if (upper.includes(wanted) || wanted.includes(upper)) score = 2
    else {
      const distance = editDistance(upper, wanted, 2)
      if (distance <= 2) score = 2 + distance
    }
    if (score !== null) scored.push([score, candidate])
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || (a[1] < b[1] ? -1 : 1))
  return scored.slice(0, limit).map(([, candidate]) => candidate)
}

/**
 * Check a batch of command lines against the catalog.
 *
 * `known` carries the names already in the construction: a user-defined object
 * or function is a legitimate callee that the catalog has never heard of, and
 * flagging those would teach the caller to ignore this check.
 */
export function validateCommands(commands, known = []) {
  const knownIndex = new Set(known.map((name) => String(name ?? '').toUpperCase()))
  const lines = []
  const unknown = new Map()
  const uncertain = new Map()

  for (const raw of commands) {
    const text = String(raw ?? '')
    const names = extractCommandNames(text)
    const bad = []
    const unsure = []
    for (const name of names) {
      const upper = name.toUpperCase()
      if (COMMAND_INDEX.has(upper) || knownIndex.has(upper)) continue
      // A name with no near neighbour in the command table is far more likely to be
      // the user's own object than a typo, and refusing it blocks real work. Only a
      // plausible typo (a suggestion exists) is worth stopping the batch for.
      const target = suggestCommand(name, 1).length > 0 ? unknown : uncertain
      if (target === unknown) { if (!bad.includes(name)) bad.push(name) }
      else if (!unsure.includes(name)) unsure.push(name)
      if (target.has(upper)) target.get(upper).lines.push(text)
      else target.set(upper, { name, lines: [text] })
    }
    lines.push({ command: text, names, unknown: bad, uncertain: unsure })
  }

  return { lines, unknown: [...unknown.values()], uncertain: [...uncertain.values()] }
}

/** Split a comma-separated list, as the client sends object names. */
export function parseNames(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? ''))
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean)
  return []
}
