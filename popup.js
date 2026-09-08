const $ = (sel) => document.querySelector(sel);
const status = $("#status");

function setStatus(text, cls = "") {
  status.innerHTML = `<span class="${cls}">${text}</span>`;
}

chrome.storage.local.get(["folderId"], (cfg) => {
  $("#folderId").value = cfg.folderId || "";
});

$("#auth").addEventListener("click", () => {
  setStatus("正在请求授权（会弹出 Google 登录/授权窗口）...");
  chrome.runtime.sendMessage({ type: "pingAuth" }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      setStatus(`授权失败：${(res && res.error) || chrome.runtime.lastError.message}`, "err");
      return;
    }
    setStatus("授权成功 ✓", "ok");
  });
});

$("#save").addEventListener("click", () => {
  const id = $("#folderId").value.trim();
  if (!id) { setStatus("请先粘贴文件夹 ID", "err"); return; }
  chrome.storage.local.set({ folderId: id, skippedPages: [], skippedFolderId: id, autoResume: false }, () => {
    setStatus("已保存 ✓ 打开 gemini.google.com 即可使用（页面会自动扫描）", "ok");
  });
});
