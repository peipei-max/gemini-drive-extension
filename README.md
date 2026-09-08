# Gemini 漫画改图助手（浏览器扩展版）

把 `gemini_web_helper.pyw` 悬浮助手的流程搬进 Chrome/Edge 扩展，走 **Google Drive** 做文件通道，
不依赖本地路径、不用 Native Messaging。

## 自动化流程

```
Drive 取原图 ──> 注入 Gemini 输入框（原生文件通道）──> 自动填提示词 ──> 自动点发送
     ▲                                                            │
     │                                                            ▼
Drive edited/001.png ◄──────── 抓取生成图并上传 ◄──────── 监听生成完成
```

人工操作只剩：每话开始前把原图 + 提示词手册拖进 Drive 文件夹，结束后把 `edited/` 拖回本地给 `build_reader.py` 编译。

## 目录结构

| 文件 | 职责 |
|---|---|
| `manifest.json` | MV3 清单，OAuth2 配置 |
| `background.js` | OAuth 令牌管理 + 全部 Drive API（列举/下载/上传/建目录） |
| `content.js` | gemini.google.com 悬浮面板 + 自动化状态机 |
| `content.css` | 面板样式（gmh- 前缀隔离） |
| `popup.html/js` | 配置 Drive 文件夹 ID、首次授权 |

## 首次搭建（一次性，约 10 分钟）

### 1. 加载扩展

1. 打开 `chrome://extensions`（Edge: `edge://extensions`），开启「开发者模式」
2. 「加载解压缩的扩展」→ 选择本目录 `gemini_drive_extension`
3. 复制扩展卡片上的 **ID**（一串小写字母，只要目录不挪位置就不会变）

### 2. 创建 OAuth Client ID

1. 打开 https://console.cloud.google.com/ → 新建项目（名字随意）
2. 「API 和服务 → 库」→ 搜索 **Google Drive API** → 启用
3. 「OAuth 同意屏幕」→ External → 填个应用名 → Test users 里**添加你自己的 Google 账号**
4. 「凭据 → 创建凭据 → OAuth 客户端 ID」→ 应用类型选 **Chrome 扩展程序** → 粘贴上面复制的扩展 ID
5. 复制生成的 Client ID，粘贴到 `manifest.json` 的 `oauth2.client_id`，然后在扩展卡片上点「重新加载」

### 3. 准备 Drive 文件夹

1. 在 Google Drive 建一个文件夹，比如 `今天女友不在`，往里放：
   - 该话原图（命名与本地一致，扩展按文件名自然排序定页码）
   - `GEMINI_WEB_PROMPTS.md`（`generate_web_prompts.py` 生成的那份，解析规则与 Python 端完全一致）
2. 从浏览器地址栏复制文件夹 ID：`https://drive.google.com/drive/folders/<这一段就是ID>`

### 4. 配置并授权

1. 点浏览器右上角扩展图标 → 粘贴文件夹 ID → 保存
2. 点「首次使用：点击授权 Google Drive」→ 在弹出的 Google 窗口里同意
   （授权范围是 `drive` 全量权限——这是刻意的：文件夹和原图是你在 Drive 网页手动上传的，
   不是扩展创建的，窄权限 `drive.file` 反而读不到它们。个人自用 + 测试模式 + 只授权给自己，风险可控）
3. 打开 https://gemini.google.com/images （生图专用入口，每次新会话都会回到这里）
   → 右下角出现悬浮球 🎨 → 点开面板
   首次会弹 Google 授权（同上），之后自动扫描文件夹

## 使用

- 面板里会显示：总页数 / 已完成数 / 当前待改图页码
- 单页：直接点「⚡ 发送本页」
- 全自动：勾选「全自动连跑」再点按钮，它会一页页跑下去（每页：传图→填词→发送→等生成→收图→**开新对话并回到 /images 生图页**→下一页），出错自动暂停
- 每页跑完自动开新对话：避免长会话内存膨胀、以及前文污染导致的连环拒答；新会话优先落在 `gemini.google.com/images` 生图页。若跳转导致页面整页刷新，扩展重启后会检测到中断标记**自动续跑**，进度不丢
- 「⏹ 停止」在当前步骤结束后停下；「🔄 重新扫描」重读 Drive（比如你在电脑上补传了文件）

## 成图回收

生成图自动存到 Drive 的 `edited/` 子目录，命名 `001.png`、`002.png`…（与本地 `edited/` 约定一致）。
一话做完后把整个 `edited/` 文件夹下载回本地漫画目录，直接跑 `python build_reader.py` 即可编译阅读器。

## 已知边界（Gemini DOM 常变）

- 输入框 / 发送按钮 / 生成图的识别都带多路兜底选择器，但 Google 改版后仍可能失效，症状是日志里报「找不到发送按钮」或「等待生成超时」，届时更新 `content.js` 里 `findEditor / findSendButton / waitForGenerated` 的选择器即可
- 生成图识别逻辑 = 「发送后新出现的、来自 googleusercontent 的大尺寸图片 + 页面静止 4 秒」，极偶尔可能抓到过程图，面板日志里会显示抓到的文件大小，异常时删掉 Drive 里那张再点重试
- OAuth 处于"测试"状态时令牌 7 天过期一次，过期后扩展会自动弹窗重新授权
