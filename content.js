// 内容脚本：跑在 gemini.google.com 页面里。
// 职责：悬浮面板 UI + 自动化状态机（Drive 取原图 -> 注入输入框 -> 填提示词 -> 发送 -> 等生成 -> 收图上传）。
// 所有 Drive 网络操作都转发给 background.js。

// ---------- 消息封装 ----------

function bg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res || !res.ok) return reject(new Error(res ? res.error : "background 无响应"));
      resolve(res);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 常量配置 ----------

const MAX_SEND_RETRY = 3;        // 发送环节重试轮数
const MAX_COLLECT_RETRY = 3;     // 收图环节重试次数
const MAX_SCAN_RETRY = 3;        // Drive 扫描重试次数
const MAX_FILL_PROMPT_RETRY = 3; // 提示词填入重试次数
const SEND_BUTTON_WAIT_SEC = 60;
const SEND_BUTTON_CHECK_INTERVAL_MS = 1000;
const SEND_EMPTY_CHECK_SEC = 10;
const SEND_EMPTY_CHECK_INTERVAL_MS = 500;
const GENERATED_TIMEOUT_MS = 900000; // 15 分钟
const CANDIDATE_LOAD_TIMEOUT_MS = 30000;
const CANDIDATE_CHECK_INTERVAL_MS = 1000;
const CANDIDATE_STABLE_MS = 5000;
const IMG_MIN_SIZE = 300;
const SCROLL_INTERVAL_TICK = 10;
const SLEEP_AFTER_SEND_MS = 2000;    // 发送后等页面进入生成态
const SLEEP_AFTER_COLLECT_MS = 3000; // 分享收图重试间隔
const SLEEP_BETWEEN_PAGES_MS = 3000; // 页与页之间的喘息
const SLEEP_RETRY_MS = 5000;         // 扫描重试间隔
const RESUME_DELAY_MS = 10000;       // 续跑前等页面稳定
const LOG_MAX_LINES = 60;
const FILL_PROMPT_HEAD_LEN = 30;
const FILL_PROMPT_TAIL_LEN = 40;
const FILL_PROMPT_SLEEP_BEFORE_MS = 500;
const FILL_PROMPT_CLEAR_SLEEP_MS = 300; // 清空编辑器后的等待
const FILL_PROMPT_SLEEP_AFTER_MS = 1500;
const INJECT_IMG_CHECK_MAX_ITER = 20;
const INJECT_IMG_CHECK_INTERVAL_MS = 500;

// 生图专用入口（用户指定），每次新会话都回到这里
const IMAGES_URL = "https://gemini.google.com/images";

// ---------- 全局状态 ----------

const S = {
  folderId: "",
  editedFolderId: "",
  images: [],        // [{id, name, base}] 原图，自然排序
  completed: new Set(), // 已完成页码（1-based）
  sessionCompleted: new Set(), // 本会话内刚收图成功的页码（防 Drive 列表滞后重跑）
  skipped: new Set(),   // 当前文件夹的手动跳过页码（切换文件夹时自动清空）
  prompts: {},       // {页码: 提示词}
  current: 1,
  total: 1,
  running: false,
  stopFlag: false,
  autoMode: false,
  sentImageElements: new Set(), // 发送前页面里已有的 img 元素，用于识别新生成图（记元素而非 URL）
  resumeTimer: null,   // 待触发的自动续跑定时器（点停止/手动单页时必须取消）
  localDone: new Set(),   // 本地完成标记（当前文件夹，chrome.storage 持久化）
  doneByFolder: {},       // 按文件夹记账的本地完成页码，换文件夹互不污染且各自保留
  promptsCacheId: "",  // 提示词手册缓存键（按文件 id，避免每页重复下载）
  promptsCache: null,
};

// ---------- DOM 选择器（Gemini DOM 常变，全部多路兜底） ----------

function findEditor() {
  return (
    document.querySelector("rich-textarea .ql-editor[contenteditable='true']") ||
    document.querySelector(".ql-editor[contenteditable='true']") ||
    document.querySelector("div[contenteditable='true'][role='textbox']")
  );
}

function findFileInput() {
  const inputs = [...document.querySelectorAll("input[type='file']")];
  return (
    inputs.find((i) => (i.accept || "").includes("image")) ||
    inputs[0] || null
  );
}

function findSendButton() {
  // 多路兜底：先按 aria-label / tooltip / 文本找
  const all = [...document.querySelectorAll("button")];
  const notDisabled = (b) => !b.disabled && b.getAttribute("aria-disabled") !== "true";
  const labelOf = (b) => `${b.getAttribute("aria-label") || ""}${b.getAttribute("title") || ""}${b.getAttribute("mattooltip") || ""}`.toLowerCase();
  const looksLikeSend = (b) =>
    /send|发送|提交|送信/.test(labelOf(b)) ||
    (/send|发送|提交/.test(b.textContent.trim().toLowerCase()) && b.textContent.trim().length < 20);

  const byLabel = all.find((b) => notDisabled(b) && looksLikeSend(b));
  if (byLabel) return byLabel;

  // 兜底：从输入框向上最多 4 层找"输入行"容器，取容器内最后一个可用按钮。
  // 绝不放宽到 main 整页——那会点到麦克风/设置/账号等无关按钮（实测踩过）
  const dangerous = /mic|麦克风|setting|设置|upload|上传|help|帮助|account|账号|theme|主题|menu|菜单/i;
  const editor = findEditor();
  let scope = editor;
  for (let i = 0; i < 4 && scope; i++) {
    scope = scope.parentElement;
    if (!scope) break;
    const btns = [...scope.querySelectorAll("button")].filter((b) => notDisabled(b) && !dangerous.test(labelOf(b)));
    if (btns.length) return btns[btns.length - 1];
  }
  return null;
}

// ---------- Drive 数据加载 ----------

function naturalBase(name) {
  return name.replace(/\.[^.]+$/, "");
}

function naturalSort(a, b) {
  const pa = a.name.split(/(\d+)/), pb = b.name.split(/(\d+)/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn && +x !== +y) return +x - +y;
    if (x !== y) return xn ? -1 : yn ? 1 : x.localeCompare(y);
  }
  return 0;
}

// 页面是否已处理（Drive 历史成图 / 本会话刚完成 / 本地完成标记 / 手动跳过，任一即算）
function isDone(p) {
  return S.completed.has(p) || S.sessionCompleted.has(p) || S.localDone.has(p) || S.skipped.has(p);
}

async function loadFolderData() {
  if (!S.folderId) throw new Error("未配置 Drive 文件夹 ID，请点扩展图标在弹窗里粘贴文件夹 ID");
  log("📂 正在扫描 Drive 文件夹...", "blue");

  const { files } = await bg({ type: "listFolder", folderId: S.folderId });

  const editedDir = files.find(
    (f) => f.name === "edited" && f.mimeType === "application/vnd.google-apps.folder"
  );
  S.editedFolderId = editedDir ? editedDir.id : "";

  S.images = files
    .filter((f) => /^image\//.test(f.mimeType) && !/^edited[_-]?/i.test(f.name))
    .map((f) => ({ id: f.id, name: f.name, base: naturalBase(f.name) }))
    .sort(naturalSort);
  S.total = S.images.length;

  // 已完成 = edited/ 目录里有对应成图。两种命名都认：
  // ① 扩展自动存的「原图名.png」（如 i-212.png）；② 手工补的「页码.png」（如 001.png）
  S.completed = new Set();
  if (editedDir) {
    const { files: done } = await bg({ type: "listFolder", folderId: editedDir.id });
    const byLeadingDigit = new Map();
    done.forEach((f) => {
      const m = f.name.match(/^(\d+)/);
      if (m) byLeadingDigit.set(+m[1], f.name);
    });
    S.images.forEach((img, i) => {
      const idx = i + 1;
      if (byLeadingDigit.has(idx) || done.some((f) => f.name.startsWith(img.base + "."))) {
        S.completed.add(idx);
      }
    });
  }

  // 提示词手册：按文件 id 缓存，避免每页重复下载；下载失败时沿用缓存，别让瞬时网络错误断链
  const mdFile = files.find((f) => f.name === "GEMINI_WEB_PROMPTS.md");
  if (!mdFile) {
    S.prompts = {};
    const others = files
      .filter((f) => !/^image\//.test(f.mimeType) && f.mimeType !== "application/vnd.google-apps.folder")
      .map((f) => `${f.name} [${f.mimeType}]`);
    log("⚠️ 未找到 GEMINI_WEB_PROMPTS.md。文件夹里现有的非图片文件：" +
      (others.length ? others.join("、") : "（一个都没有）"), "amber");
  } else if (S.promptsCacheId === mdFile.id && S.promptsCache) {
    S.prompts = S.promptsCache;
  } else {
    const { data } = await bg({ type: "download", fileId: mdFile.id });
    S.promptsCache = parsePromptsMd(base64ToText(data));
    S.promptsCacheId = mdFile.id;
    S.prompts = S.promptsCache;
    if (Object.keys(S.prompts).length === 0) {
      log("⚠️ 找到了 GEMINI_WEB_PROMPTS.md 但一条都没解析出来，文件开头内容：" + JSON.stringify(base64ToText(data).slice(0, 200)), "amber");
    }
  }

  // 定位最新未处理页：Drive 历史成图 / 本会话刚完成 / 本地完成标记 / 手动跳过 都算"已处理"
  S.current = 1;
  for (let p = 1; p <= S.total; p++) {
    if (!isDone(p)) { S.current = p; break; }
    if (p === S.total) S.current = S.total;
  }
  let handled = 0;
  for (let p = 1; p <= S.total; p++) if (isDone(p) && !S.skipped.has(p)) handled++;

  const skipExtra = S.skipped.size ? `（另有手动跳过 ${S.skipped.size} 页）` : "";
  log(`✅ 共 ${S.total} 页，已处理 ${handled} 页${skipExtra}，当前第 ${S.current} 页（提示词 ${Object.keys(S.prompts).length} 条）`, "green");
  render();
}

function base64ToText(b64) {
  return new TextDecoder().decode(
    Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  );
}

// 与 gemini_web_helper.pyw 的 load_prompts 保持同一解析规则。
// 注意：Windows 生成的手册是 CRLF 行尾，Python 文本模式读入时会自动归一成 \n，
// JS 侧必须手动归一，否则 ```text\r\n 围栏匹配不上。
function parsePromptsMd(md) {
  md = md.replace(/\r\n?/g, "\n");
  const prompts = {};
  for (const block of md.split("\n## ")) {
    const m = block.match(/📄 第 (\d+) 页/);
    if (!m) continue;
    const mm = block.match(/```text\n([\s\S]*?)```/);
    if (mm) prompts[+m[1]] = mm[1].trim();
  }
  return prompts;
}

// ---------- 注入图片 ----------

async function injectImage(imageItem) {
  log(`⬇️ 从 Drive 下载 ${imageItem.name} ...`, "blue");
  const { data } = await bg({ type: "download", fileId: imageItem.id });
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const mime = imageItem.name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  const file = new File([bytes], imageItem.name, { type: mime });

  const editor = findEditor();

  // 主路径：直接往隐藏的 <input type=file> 塞文件（等价于点"上传图片"按钮，走原生上传通道）
  const input = findFileInput();
  if (input) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    log("📎 已通过文件通道注入图片", "blue");
  } else if (editor) {
    // 兜底：模拟 paste 事件
    editor.focus();
    const dt = new DataTransfer();
    dt.items.add(file);
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    log("📎 已通过 paste 事件注入图片", "blue");
  } else {
    throw new Error("找不到输入框，无法注入图片");
  }

  // 等附件缩略图出现。关键：以粘贴前已有的 img 为基线，只认"新增"的图——
  // 否则兜底到 main 范围时会匹配到历史图片，假阳性放行纯文字请求
  const composer = editor ? (editor.closest("form") || editor.closest("main") || document) : document;
  const beforeImgs = new Set(composer.querySelectorAll("img"));
  for (let i = 0; i < INJECT_IMG_CHECK_MAX_ITER; i++) {
    await sleep(INJECT_IMG_CHECK_INTERVAL_MS);
    const newImg = [...composer.querySelectorAll("img")].some((im) => !beforeImgs.has(im));
    if (newImg || composer.querySelector("[data-test-id='file-upload-container'], .attachment-preview")) {
      log("✅ 附件已就绪", "green");
      return;
    }
  }
  log("⚠️ 未确认到附件缩略图，仍继续尝试发送（若发出的是纯文字请检查粘贴是否成功）", "amber");
}

// ---------- 填提示词 + 发送 ----------

// 把最新的模型回复滚进视口（触发懒加载 + 让元素可被检测）
function scrollToLatestResponse() {
  // Gemini 聊天主容器选择器，兜底用 body
  const scroller =
    document.querySelector("main, .conversation-container, .chat-scroll, [data-test-id='conversation']") ||
    document.documentElement;
  scroller.scrollTop = scroller.scrollHeight;
  window.scrollTo(0, document.body.scrollHeight);
}

function normalizeText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

async function fillPrompt(prompt) {
  // 每页提示词开头相同、末尾台词不同——必须同时校验首尾，
  // 否则上一页残留的提示词会被"已存在守卫"误判通过，导致把旧台词发给新图
  const head = normalizeText(prompt.slice(0, FILL_PROMPT_HEAD_LEN));
  const tail = normalizeText(prompt.slice(-FILL_PROMPT_TAIL_LEN));
  const hasPrompt = (editor) => {
    const t = normalizeText(editor.innerText);
    return t.includes(head) && t.includes(tail);
  };

  for (let attempt = 0; attempt < MAX_FILL_PROMPT_RETRY; attempt++) {
    const editor = findEditor();
    if (!editor) {
      await sleep(FILL_PROMPT_SLEEP_AFTER_MS);
      continue;
    }
    if (hasPrompt(editor)) {
      log("✅ 提示词已存在，跳过重复填入", "green");
      return;
    }
    editor.focus();
    editor.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(FILL_PROMPT_SLEEP_BEFORE_MS);
    // 可靠清空（残留的可能是上一页的提示词，必须清掉）
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    await sleep(FILL_PROMPT_CLEAR_SLEEP_MS);
    document.execCommand("insertText", false, prompt);
    await sleep(FILL_PROMPT_SLEEP_AFTER_MS);
    if (hasPrompt(editor)) {
      log(`✅ 提示词已填入（第 ${attempt + 1} 次）`, "green");
      return;
    }
    log(`⚠️ 填入后验证未通过，重试（${attempt + 1}/${MAX_FILL_PROMPT_RETRY}）`, "amber");
  }
  throw new Error("提示词未能填入输入框（已重试 3 次）");
}

async function clickSend() {
  const editor = findEditor();
  if (editor) editor.scrollIntoView({ block: "center", behavior: "instant" });
  await sleep(SEND_EMPTY_CHECK_INTERVAL_MS);

  // 轮询等按钮出现，最多 60 秒（附件上传完成前按钮常未渲染）
  let btn = null;
  for (let i = 0; i < SEND_BUTTON_WAIT_SEC; i++) {
    btn = findSendButton();
    if (btn) break;
    await sleep(SEND_BUTTON_CHECK_INTERVAL_MS);
  }
  if (!btn) throw new Error("找不到发送按钮（已等 60 秒，Gemini DOM 可能已更新，请把页面截图发我）");
  btn.click();
  log("🚀 已点击发送", "blue");
  // 验证编辑器清空（请求真正发出），最多等 10 秒
  for (let i = 0; i < SEND_EMPTY_CHECK_SEC * 2; i++) {
    await sleep(SEND_EMPTY_CHECK_INTERVAL_MS);
    const ed = findEditor();
    const empty = !ed || (ed.innerText || "").trim().length === 0;
    if (empty) { log("✅ 请求已发出", "green"); return; }
  }
  log("⚠️ 未确认请求发出，继续监听", "amber");
}

// ---------- 等待生成 + 收图 ----------

// 候选生成图：只在最新一条模型回复里找、发送前不存在的 img 元素。
// 关键：
//   ① 按元素本身判定（不是 URL），避免页面重渲染 URL 变化导致旧图被误判
//   ② 只取最后一条模型回复，左侧历史回复里的成图一律不收
//   ③ 懒加载图片 naturalWidth 可能为 0，要先滚入视口等它加载
function lastModelResponse() {
  const responses = [...document.querySelectorAll("model-response, .model-response, message-content, .response-container, [data-test-id='model-response']")];
  return responses[responses.length - 1] || null;
}

function findGeneratedCandidates() {
  const latest = lastModelResponse();
  const imgs = latest ? [...latest.querySelectorAll("img")] : [...document.querySelectorAll("img")];
  return imgs.filter((img) => {
    if (S.sentImageElements.has(img)) return false; // 发送前就有的元素，排除
    const src = img.currentSrc || img.src || "";
    if (!src) return false;
    return true;
  });
}

// 等候选图加载完成（处理懒加载），返回真正的大图
async function waitForCandidatesLoaded(timeoutMs = CANDIDATE_LOAD_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cands = findGeneratedCandidates();
    // 把每张候选图依次滚入视口触发加载
    for (const img of cands) {
      if ((img.naturalWidth || 0) < IMG_MIN_SIZE) {
        img.scrollIntoView({ block: "center", behavior: "instant" });
      }
    }
    await sleep(CANDIDATE_CHECK_INTERVAL_MS);
    const loaded = cands.filter((img) => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      return w >= IMG_MIN_SIZE && h >= IMG_MIN_SIZE;
    });
    if (loaded.length > 0) return loaded;
  }
  return [];
}

async function waitForGenerated(timeoutMs = GENERATED_TIMEOUT_MS) {
  log(`👀 监听生成结果中（候选图稳定 ${CANDIDATE_STABLE_MS/1000} 秒即收，最长等 ${GENERATED_TIMEOUT_MS/60000} 分钟）...`, "blue");
  const start = Date.now();
  let lastSrcKey = "";
  let stableSince = 0;
  let tick = 0;
  while (Date.now() - start < timeoutMs) {
    if (S.stopFlag) throw new Error("已手动停止");
    tick++;
    // 每 SCROLL_INTERVAL_TICK 秒滚一次底触发懒加载即可，别跟用户抢滚动条
    if (tick % SCROLL_INTERVAL_TICK === 1) scrollToLatestResponse();
    await sleep(CANDIDATE_CHECK_INTERVAL_MS);
    const loaded = await waitForCandidatesLoaded(CANDIDATE_LOAD_TIMEOUT_MS / 4);
    const key = loaded.map((i) => i.currentSrc || i.src).sort().join("|");
    if (key && key === lastSrcKey) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince > CANDIDATE_STABLE_MS) {
        return [...new Set(loaded.map((i) => i.currentSrc || i.src))];
      }
    } else {
      lastSrcKey = key;
      stableSince = 0;
    }
  }
  throw new Error(`等待生成超时（${GENERATED_TIMEOUT_MS/60000} 分钟），若图已生成请在日志排查`);
}

// ---------- 收图：分享链接方案 ----------

function findShareButton() {
  const root = lastModelResponse() || document;
  const btns = [...root.querySelectorAll("button, a[role='button']")];
  const matches = btns.filter((b) =>
    /share|分享/i.test(`${b.getAttribute("aria-label") || ""}${b.getAttribute("mattooltip") || ""}${b.getAttribute("title") || ""}`) ||
    b.querySelector("[class*='share' i], [data-icon*='share' i]")
  );
  return matches[matches.length - 1] || null;
}

function closeOverlays() {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  const closeBtn = document.querySelector("[aria-label*='关闭'], [aria-label*='Close'], [data-test-id='dialog-close-button']");
  if (closeBtn) closeBtn.click();
}

async function clickShareAndGetLink() {
  const btn = findShareButton();
  if (!btn) throw new Error("找不到分享按钮");
  btn.scrollIntoView({ block: "center", behavior: "instant" });
  await sleep(500);
  btn.click();
  log("🔗 已点击分享", "blue");

  // 多策略拿链接，最多 15 秒
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    // 策略1：弹层里的输入框/文本域已带链接值
    const inputs = [...document.querySelectorAll("input[type='text'], textarea")]
      .map((el) => (el.value || "").trim())
      .filter((v) => /^https?:\/\//.test(v));
    if (inputs.length) {
      closeOverlays();
      return inputs.sort((a, b) => b.length - a.length)[0];
    }
    // 策略2：分享链接锚点。实测弹层链接域名为 share.gemini.google（注意
    // 不能用 share.google 匹配——"share.gemini.google" 里不含 "share.google" 子串）
    const anchors = [...document.querySelectorAll("a[href]")]
      .map((a) => a.href)
      .filter((h) => /share\.gemini\.google|share\.google|gemini\.google\.com\/share/i.test(h));
    if (anchors.length) {
      closeOverlays();
      return anchors[anchors.length - 1];
    }
    // 策略2b：锚点可见文本是链接形态（href 被前端改写时的兜底）
    const textLinks = [...document.querySelectorAll("a")]
      .map((a) => (a.textContent || "").trim())
      .filter((t) => /^(https?:\/\/)?(share\.gemini\.google|share\.google)\/\S+/i.test(t))
      .map((t) => (t.startsWith("http") ? t : `https://${t}`));
    if (textLinks.length) {
      closeOverlays();
      return textLinks[textLinks.length - 1];
    }
    // 策略3：Gemini 可能在点击时直接复制到剪贴板（无用户激活时可能被拒，尽力而为）
    if (i === 6) {
      try {
        const clip = await navigator.clipboard.readText();
        if (/^https?:\/\//.test(clip.trim())) {
          closeOverlays();
          return clip.trim();
        }
      } catch (e) { /* 剪贴板权限被拒，继续其他策略 */ }
    }
  }
  throw new Error("点击分享后 15 秒内未拿到链接（弹层若已打开则是提取策略未覆盖该 DOM，请截图发我）");
}

async function collectShareLink(page) {
  const shareUrl = await clickShareAndGetLink();
  log(`🔗 分享链接：${shareUrl}`, "green");

  const target = S.images[page - 1];
  const markerBody = `${target.name}\t${shareUrl}\n`;

  // 本地存档：Downloads/gemini_share_links/{原图名}.txt（本地下载脚本的输入）
  try {
    const blob = new Blob([markerBody], { type: "text/plain" });
    const objUrl = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url: objUrl,
      filename: `gemini_share_links/${target.base}.txt`,
      conflictAction: "overwrite",
      saveAs: false,
    });
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
    log("💾 链接已存本地: Downloads/gemini_share_links/", "green");
  } catch (e) {
    log(`⚠️ 本地存档失败：${e.message}`, "amber");
  }

  // 本地完成标记（按文件夹记账，持久化），下次扫描直接跳过
  S.localDone.add(page);
  S.sessionCompleted.add(page);
  const map = S.doneByFolder;
  const arr = new Set(map[S.folderId] || []);
  arr.add(page);
  map[S.folderId] = [...arr].sort((a, b) => a - b);
  S.doneByFolder = map;
  chrome.storage.local.set({ donePagesByFolder: map });
  log(`✅ 第 ${page} 页已本地标记完成`, "green");
}

// 注：整话跑在同一个 Gemini 会话里（用户指定），所有分享链接都留在该会话历史中，
// 不再自动开新对话——会话长度换来的代价由用户接受。

// ---------- 主流程 ----------

async function runPage(page) {
  const img = S.images[page - 1];
  if (!img) throw new Error(`第 ${page} 页不存在`);
  const prompt = S.prompts[page];
  if (!prompt) throw new Error(`提示词手册缺少第 ${page} 页（检查 Drive 里的 GEMINI_WEB_PROMPTS.md）`);

  // 发送前快照：记 img 元素本身（而非 URL），避免页面重渲染后 URL 变化导致旧图被误判为新图
  S.sentImageElements = new Set(document.querySelectorAll("img"));

  // 每一步之间给 UI 留出渲染时间，避免"上一个还没处理完就被误判"
  await injectImage(img);
  if (S.stopFlag) throw new Error("已手动停止");
  await sleep(1500);

  // fillPrompt 内部自带重试 + "已存在就跳过"守卫，此处只兜底发送按钮环节
  await fillPrompt(prompt);
  await sleep(1000);

  for (let attempt = 0; attempt < MAX_SEND_RETRY; attempt++) {
    try {
      await clickSend();
      break;
    } catch (e) {
      log(`⚠️ 发送失败：${e.message}（第 ${attempt + 1} 次）`, "amber");
      if (attempt === MAX_SEND_RETRY - 1) throw new Error(`发送环节连续失败（已重试 ${MAX_SEND_RETRY} 轮）`);
      await sleep(2000);
    }
  }

  await sleep(SLEEP_AFTER_SEND_MS); // 等请求真正发出、页面进入生成态

  const srcs = await waitForGenerated();
  if (!srcs.length) log("⚠️ 未检测到新图（可能判定失误），仍尝试走分享流程", "amber");

  // 收图改走分享链接：点分享 -> 拿公开链接 -> 云端标记 + 本地存档。
  // 重试时先关掉可能残留的弹层再重新找按钮
  for (let attempt = 0; attempt < MAX_COLLECT_RETRY; attempt++) {
    if (attempt > 0) {
      log(`🔄 分享收图重试（${attempt + 1}/${MAX_COLLECT_RETRY}）...`, "amber");
      closeOverlays();
      await sleep(SLEEP_AFTER_COLLECT_MS);
    }
    try {
      await collectShareLink(page);
      break;
    } catch (e) {
      log(`⚠️ ${e.message}`, "amber");
      if (attempt === MAX_COLLECT_RETRY - 1) throw new Error(`分享收图连续失败（已重试 ${MAX_COLLECT_RETRY} 次）`);
    }
  }
}

async function autoRun() {
  if (S.running) return;
  S.running = true;
  S.stopFlag = false;
  // autoResume 标记：整页跳转/崩溃导致脚本中断时，重启后自动续跑
  chrome.storage.local.set({ autoResume: true });
  render();
  try {
    while (!S.stopFlag) {
      // 扫描加重试：瞬时 Drive 网络错误不该杀掉整条链
      let loaded = false;
      for (let i = 0; i < MAX_SCAN_RETRY && !S.stopFlag; i++) {
        try { await loadFolderData(); loaded = true; break; }
        catch (e) { log(`⚠️ 扫描失败：${e.message}（${i + 1}/${MAX_SCAN_RETRY}，${SLEEP_RETRY_MS / 1000} 秒后重试）`, "amber"); await sleep(SLEEP_RETRY_MS); }
      }
      if (!loaded) { log(`❌ 连续 ${MAX_SCAN_RETRY} 次扫描失败，已暂停。`, "red"); break; }
      let remaining = 0;
      for (let p = 1; p <= S.total; p++) if (!isDone(p)) remaining++;
      if (remaining === 0) { log("🎊 全部完成！", "green"); break; }
      const page = S.current;
      try {
        await runPage(page);
        log("📌 收图完成，继续下一页（整话同一会话）", "blue");
      } catch (e) {
        log(`❌ 第 ${page} 页失败：${e.message}`, "red");
        log("已暂停。排查后可再点「发送本页」重试。", "amber");
        break;
      }
      await sleep(SLEEP_BETWEEN_PAGES_MS); // 给 Gemini 一点喘息
    }
  } finally {
    S.running = false;
    chrome.storage.local.set({ autoResume: false });
    render();
  }
}

async function runSingle() {
  if (S.running) return;
  S.running = true;
  S.stopFlag = false;
  if (S.resumeTimer) { clearTimeout(S.resumeTimer); S.resumeTimer = null; } // 用户选择单页，取消待触发的续跑
  render();
  try {
    await loadFolderData();
    await runPage(S.current);
  } catch (e) {
    log(`❌ ${e.message}`, "red");
  } finally {
    S.running = false;
    render();
  }
}

// ---------- UI ----------

function log(text, color = "text") {
  const box = document.querySelector(".gmh-panel .gmh-log");
  if (!box) return console.log("[助手]", text);
  const line = document.createElement("div");
  line.className = `gmh-line gmh-${color}`;
  line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  box.prepend(line);
  while (box.children.length > LOG_MAX_LINES) box.lastChild.remove();
}

function render() {
  const panel = document.querySelector(".gmh-panel");
  if (!panel) return;
  panel.querySelector(".gmh-page-input").value = String(S.current).padStart(3, "0");
  panel.querySelector(".gmh-total").textContent = `/ ${String(S.total).padStart(3, "0")}`;
  let handled = 0;
  for (let p = 1; p <= S.total; p++) if (isDone(p) && !S.skipped.has(p)) handled++;
  const pct = S.total ? Math.round((handled / S.total) * 100) : 0;
  const skipExtra = S.skipped.size ? ` +跳过${S.skipped.size}` : "";
  panel.querySelector(".gmh-progress-num").textContent = `${handled}/${S.total} (${pct}%)${skipExtra}`;
  panel.querySelector(".gmh-progress-fill").style.width = `${pct}%`;
  const img = S.images[S.current - 1];
  const state = S.skipped.has(S.current) ? "⏭ 已跳过" : isDone(S.current) ? "✓ 已完成" : "⏳ 待改图";
  panel.querySelector(".gmh-badge").textContent = `${state}${img ? ` (${img.name})` : ""}`;
  panel.querySelector(".gmh-btn-run").disabled = S.running;
  panel.querySelector(".gmh-btn-stop").disabled = !S.running;
}

function buildPanel() {
  if (document.querySelector(".gmh-root")) return;

  const ball = document.createElement("div");
  ball.className = "gmh-root gmh-ball";
  ball.textContent = "🎨";
  ball.title = "漫画改图助手";

  const panel = document.createElement("div");
  panel.className = "gmh-root gmh-panel gmh-hidden";
  panel.innerHTML = `
    <div class="gmh-head">
      <span class="gmh-title">🎨 漫画改图助手</span>
      <span class="gmh-auto-wrap"><label><input type="checkbox" class="gmh-auto"> 全自动连跑</label></span>
      <span class="gmh-collapse">—</span>
    </div>
    <div class="gmh-progress-row">
      <span class="gmh-progress-num">0/0 (0%)</span>
    </div>
    <div class="gmh-progress-bar"><div class="gmh-progress-fill"></div></div>
    <div class="gmh-nav">
      <button class="gmh-btn gmh-prev">◀</button>
      <input class="gmh-page-input" value="001">
      <span class="gmh-total">/ 000</span>
      <button class="gmh-btn gmh-next">▶</button>
      <span class="gmh-badge gmh-text">-</span>
    </div>
    <div class="gmh-actions">
      <button class="gmh-btn gmh-btn-primary gmh-btn-run">⚡ 发送本页</button>
      <button class="gmh-btn gmh-btn-danger gmh-btn-stop" disabled>⏹ 停止</button>
      <button class="gmh-btn gmh-btn-refresh">🔄 重新扫描</button>
      <button class="gmh-btn gmh-btn-skip" title="当前页我已手动处理，不计入流程">⏭ 跳过</button>
    </div>
    <div class="gmh-log"></div>
  `;

  ball.addEventListener("click", () => {
    panel.classList.toggle("gmh-hidden");
    ball.classList.toggle("gmh-ball-active");
    if (!panel.classList.contains("gmh-hidden") && !S.images.length) loadFolderData().catch((e) => log(`❌ ${e.message}`, "red"));
  });
  panel.querySelector(".gmh-collapse").addEventListener("click", () => panel.classList.add("gmh-hidden"));
  panel.querySelector(".gmh-prev").addEventListener("click", () => { S.current = Math.max(1, S.current - 1); render(); });
  panel.querySelector(".gmh-next").addEventListener("click", () => { S.current = Math.min(S.total || 1, S.current + 1); render(); });
  panel.querySelector(".gmh-page-input").addEventListener("change", (e) => {
    const v = parseInt(e.target.value, 10);
    if (v >= 1) S.current = Math.min(S.total || v, v);
    render();
  });
  panel.querySelector(".gmh-auto").addEventListener("change", (e) => { S.autoMode = e.target.checked; });
  panel.querySelector(".gmh-btn-refresh").addEventListener("click", () => loadFolderData().catch((e) => log(`❌ ${e.message}`, "red")));
  panel.querySelector(".gmh-btn-skip").addEventListener("click", () => {
    const page = S.current;
    if (S.skipped.has(page)) {
      S.skipped.delete(page);
      log(`↩️ 已取消跳过第 ${page} 页`, "amber");
    } else {
      S.skipped.add(page);
      log(`⏭ 第 ${page} 页已标记跳过（我已手动处理）`, "amber");
    }
    chrome.storage.local.set({ skippedPages: [...S.skipped], skippedFolderId: S.folderId });
    loadFolderData().catch((e) => log(`❌ ${e.message}`, "red"));
  });
  panel.querySelector(".gmh-btn-run").addEventListener("click", () => (S.autoMode ? autoRun() : runSingle()));
  panel.querySelector(".gmh-btn-stop").addEventListener("click", () => {
    S.stopFlag = true;
    if (S.resumeTimer) { clearTimeout(S.resumeTimer); S.resumeTimer = null; } // 停止要连待触发的续跑一起取消
    chrome.storage.local.set({ autoResume: false });
    log("⏹ 已请求停止（等当前步骤结束）", "amber");
  });

  document.body.appendChild(ball);
  document.body.appendChild(panel);
  render();
}

// ---------- 启动 ----------

chrome.storage.local.get(["folderId", "autoResume", "skippedPages", "skippedFolderId", "donePagesByFolder"], (cfg) => {
  S.folderId = cfg.folderId || "";
  S.doneByFolder = cfg.donePagesByFolder || {};
  S.localDone = new Set(S.doneByFolder[S.folderId] || []);
  if (cfg.skippedFolderId === S.folderId) {
    S.skipped = new Set(cfg.skippedPages || []);
  } else {
    S.skipped = new Set();
    chrome.storage.local.set({ skippedPages: [], skippedFolderId: S.folderId });
  }
  buildPanel();
  if (S.folderId) {
    loadFolderData().catch((e) => log(`❌ ${e.message}`, "red"));
    if (cfg.autoResume) {
      log("🔁 检测到上次全自动运行被页面跳转中断，10 秒后自动续跑...", "amber");
      S.resumeTimer = setTimeout(() => { if (!S.stopFlag) autoRun(); }, RESUME_DELAY_MS);
    }
  } else {
    log("⚠️ 尚未配置 Drive 文件夹 ID：点浏览器右上角扩展图标进行配置", "amber");
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.folderId) {
    S.folderId = changes.folderId.newValue || "";
    S.skipped.clear();
    S.sessionCompleted.clear();
    // 本地完成账本按文件夹各自保留，只切换视图，不清除
    S.localDone = new Set((S.doneByFolder || {})[S.folderId] || []);
    S.promptsCacheId = "";
    S.promptsCache = null;
    chrome.storage.local.set({ skippedPages: [], skippedFolderId: S.folderId });
    if (S.folderId) loadFolderData().catch((e) => log(`❌ ${e.message}`, "red"));
  }
});
