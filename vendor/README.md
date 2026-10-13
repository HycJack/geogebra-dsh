# vendor/GeoGebra — 内嵌的 GeoGebra 构建

这个目录是一份 GeoGebra 官方构建，随插件一起分发，让插件**离线自足**：
不依赖 CDN，也不依赖仓库外的任何路径。

## 来源

| | |
| --- | --- |
| 版本 | **5.2.888.1**（applet 的 `getVersion()` 返回值） |
| 取自 | `geogebra-chat/public/GeoGebra`（本地参考项目里的一份官方构建） |
| GWT 排列哈希 | `E458EE8230F30B4009D07A14F378128D` |
| 体积 / 文件数 | 约 45 MB / 206 个 |

## 装了什么

```
vendor/GeoGebra/
├── deployggb.js                 ← applet 加载器（40K）
└── HTML5/5.0/
    ├── GeoGebra.html            ← 内嵌页（348K）
    ├── css/
    └── web/                     ← Classic 构建本体（44M，含 3D 视图）
```

**只装 `web/`。** 这不是随意裁的，依据有两条：

1. `deployggb.js` 按 **codebase 的文件夹名**选构建：只有路径里出现 `webSimple` 才换脚本。
   本插件的 codebase 固定指向 `HTML5/5.0/`，所以加载的是 `web.nocache.js`。
2. `web/` 里对 `web3d` / `webSimple` 的引用数是 **0**，也没有 `../` 跳出目录的路径 ——
   不存在「点到 3D 才去懒加载另一个构建」的隐藏依赖。Classic 的 3D 视图本来就编译在 `web/` 里
   （`euclidianView3D` 就在 `web/*.cache.js` 内）。

### 没装的两个构建

| 目录 | 体积 | 什么时候才需要 |
| --- | --- | --- |
| `web3d` | 45 MB | 只要独立的 **3D 计算器应用**（`appName: "3d"`）才需要 |
| `webSimple` | 17 MB | 只要 **Notes / 简易版** 才需要 |

本插件的 `appName` 写死是 `classic`，所以两个都用不上。要加回来：

```bash
cp -R <原构建>/HTML5/5.0/web3d     vendor/GeoGebra/HTML5/5.0/
cp -R <原构建>/HTML5/5.0/webSimple vendor/GeoGebra/HTML5/5.0/
```

再把 `src/host/index.js` 里 embed 页的 `appName` 改成对应值。

## 怎么用

宿主半边的 `DEFAULT_GGB_DIR` **从模块位置反推**（`import.meta.url` → 包的 `vendor/GeoGebra`），
不是绝对路径，所以插件装到哪儿都能找到：

```js
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_GGB_DIR = join(PACKAGE_ROOT, 'vendor', 'GeoGebra')
```

想换成别的构建（更新的版本、或带 `web3d` 的完整树），改 profile 配置即可，不用动代码：

```yaml
- id: geogebra-dsh
  config:
    geogebraDir: /path/to/another/GeoGebra
```

## 服务方式

宿主用 `webServer` 的 **prefix 路由**把整棵树挂在 `/geogebra-dsh-ggb` 下，
并按扩展名给 MIME（js / mjs / css / html / txt / php / gif），带路径穿越防护。

内嵌页里那个会拉 Google Analytics 的 `<script id="fbase">` 在服务时被剥掉 —— 见
[`docs/geogebra.md`](../docs/geogebra.md) 的嵌入那节。

## 许可 ⚠️

**这份代码不是本项目的 —— 是 GeoGebra 的（© GeoGebra GmbH）。** 把 45 MB 构建提交进仓库，
等于你在分发它，因此适用 GeoGebra 自己的条款：

| 部分 | 许可 |
| --- | --- |
| 安装包 / Web 服务 / Materials（**本目录就是这一类**） | GeoGebra 非商业许可 —— **仅限非商业**，须署名 |
| 语言文件 / 文档 / UI 图像与样式 | CC BY-NC-SA 4.0 |
| GeoGebra 源码 | EUPL v1.2 |

**官方仓库里没有 LICENSE 文件** —— 它的 README 指向 <https://www.geogebra.org/license>。
本仓库把相关条款摘录在根目录的 [`LICENSE`](../LICENSE) 里。

⚠️ 两个后果：

1. **本仓库整体只能用于非商业目的**，商业用途需另与 office@geogebra.org 签约。
   因此它**不是 OSI 意义上的开源项目**（NC 限制与开源定义冲突）。
2. 随附字体另有许可：`web/fonts/licences/` 下有 **OFL**、**Knuth License**、**dsrom** 三份原文。

想彻底回避，另一条路是**不提交 `vendor/`**，改用 `config.geogebraDir` 指向本地构建 ——
代价是插件不再自足，换台机器要重新准备这份构建，而**那份 GeoGebra 仍受同样的条款约束**。
