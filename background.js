// 后台 Service Worker：负责 Google OAuth 令牌与全部 Drive API 通信。
// 内容脚本不直接碰 Drive，一律通过 chrome.runtime.sendMessage 走这里。

const SCOPES = ["https://www.googleapis.com/auth/drive"];
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

// ---------- CORS 修复 ----------
// MV3 Service Worker 的 fetch 跟随 302 重定向后 CORS 校验会重新生效，
// 而 lh3.googleusercontent.com 的生成图下载链（/gg-dl/ -> /rd-gg-dl/）不返回 CORS 头。
// 用 declarativeNetRequest 给所有 googleusercontent 的响应强制注入 ACAO 头，一劳永逸。
const CORS_RULE = {
  id: 1,
  priority: 1,
  action: {
    type: "modifyHeaders",
    responseHeaders: [
      { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
    ],
  },
  condition: {
    urlFilter: "||googleusercontent.com/",
    resourceTypes: ["xmlhttprequest", "image"],
    // 只放行两类发起方，不影响其他网站的同源保护：
    //   ① 本扩展（后台 fetchImage）
    //   ② gemini.google.com 页面（canvas 抓图在页面里发起，initiator 是页面而非扩展——
    //      只写 chrome.runtime.id 的话这条通道会被切断，403 复现）
    initiatorDomains: [chrome.runtime.id, "gemini.google.com"],
  },
};

async function ensureCorsRule() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [CORS_RULE.id],
    addRules: [CORS_RULE],
  });
}
chrome.runtime.onInstalled.addListener(ensureCorsRule);
chrome.runtime.onStartup.addListener(ensureCorsRule);
ensureCorsRule(); // Service Worker 每次冷启动也确保一遍（幂等）

// ---------- OAuth ----------

async function getToken(interactive = true) {
  const res = await chrome.identity.getAuthToken({ interactive });
  // 新版 Chrome 的 Promise 版返回对象 {token, grantedScopes}，旧版返回纯字符串
  return typeof res === "string" ? res : (res && res.token);
}

async function authedFetch(url, options = {}) {
  let token = await getToken(false);
  let res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  // 令牌过期则清缓存重取一次
  if (res.status === 401) {
    await chrome.identity.removeCachedAuthToken({ token });
    token = await getToken(true);
    res = await fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
    });
  }
  return res;
}

// ---------- Drive 操作 ----------

async function listFolder(folderId) {
  const q = `'${folderId}' in parents and trashed=false`;
  const files = [];
  let pageToken = "";
  do {
    const url = `${API}/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,size)` +
      (pageToken ? `&pageToken=${pageToken}` : "");
    const res = await authedFetch(url);
    if (!res.ok) throw new Error(`Drive 列表失败: ${res.status} ${await res.text()}`);
    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return files;
}

async function findByName(folderId, name) {
  const q = `'${folderId}' in parents and name='${name.replace(/'/g, "\\'")}' and trashed=false`;
  const url = `${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)`;
  const res = await authedFetch(url);
  if (!res.ok) throw new Error(`Drive 查询失败: ${res.status}`);
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

async function ensureFolder(parentId, name) {
  const existing = await findByName(parentId, name);
  if (existing && existing.mimeType === "application/vnd.google-apps.folder") {
    return existing.id;
  }
  const res = await authedFetch(`${API}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  if (!res.ok) throw new Error(`建目录失败: ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

async function downloadFile(fileId) {
  const res = await authedFetch(`${API}/files/${fileId}?alt=media`);
  if (!res.ok) throw new Error(`Drive 下载失败: ${res.status}`);
  const buf = await res.arrayBuffer();
  return arrayBufferToBase64(buf);
}

async function uploadFile(folderId, name, mimeType, base64) {
  const bytes = base64ToUint8Array(base64);
  const boundary = "gmh" + Date.now() + "xx";
  const meta = JSON.stringify({ name, parents: [folderId] });
  const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const post = `\r\n--${boundary}--`;
  // 关键：偏移必须用 UTF-8 字节长度。pre 含文件名，中文文件名时
  // pre.length（UTF-16 单位）≠ 实际字节数，直接用会写歪请求体
  const preBytes = new TextEncoder().encode(pre);
  const postBytes = new TextEncoder().encode(post);
  const body = new Uint8Array(preBytes.length + bytes.length + postBytes.length);
  body.set(preBytes, 0);
  body.set(bytes, preBytes.length);
  body.set(postBytes, preBytes.length + bytes.length);

  const res = await authedFetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive 上传失败: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---------- base64 工具 ----------

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToUint8Array(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------- 消息路由 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "pingAuth": {
          await getToken(true); // 首次会弹授权窗
          sendResponse({ ok: true });
          break;
        }
        case "listFolder": {
          sendResponse({ ok: true, files: await listFolder(msg.folderId) });
          break;
        }
        case "findByName": {
          sendResponse({ ok: true, file: await findByName(msg.folderId, msg.name) });
          break;
        }
        case "ensureFolder": {
          sendResponse({ ok: true, id: await ensureFolder(msg.parentId, msg.name) });
          break;
        }
        case "download": {
          sendResponse({ ok: true, data: await downloadFile(msg.fileId) });
          break;
        }
        // 抓取页面里的生成图（googleusercontent）。必须在后台做：
        // MV3 中 content script 的 fetch 受页面 CORS 约束，host_permissions 只豁免扩展上下文
        case "fetchImage": {
          // 带 cookie：gg-dl 下载链是 cookie 门禁的，无 cookie 直接 403。
          // host_permissions 已授予 googleusercontent，include 会附上用户会话
          const res = await fetch(msg.url, { credentials: "include" });
          if (!res.ok) throw new Error(`抓图失败: ${res.status}`);
          const buf = await res.arrayBuffer();
          sendResponse({
            ok: true,
            data: arrayBufferToBase64(buf),
            mime: res.headers.get("content-type") || "image/png",
            size: buf.byteLength,
          });
          break;
        }
        case "upload": {
          sendResponse({ ok: true, file: await uploadFile(msg.folderId, msg.name, msg.mime, msg.data) });
          break;
        }
        default:
          sendResponse({ ok: false, error: `未知消息类型 ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // 异步响应
});
