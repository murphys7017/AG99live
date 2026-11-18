"use strict";
(() => {
  const css = document.getElementById("css");
  const save = document.getElementById("save");
  const result = document.getElementById("result");
  const preview = document.getElementById("preview");
  const url = document.getElementById("obs-url");
  url.value = `${location.origin}/subtitle/`;
  const example = ":root {\n  --subtitle-font-size: clamp(26px, 5.3vw, 64px);\n  --subtitle-card-background: #2c2345;\n  --subtitle-color: #faf8ff;\n}\n";
  let saved = "";
  function showDraft() { preview.contentWindow?.postMessage({ type: "subtitle.css-preview", css: css.value }, location.origin); }
  css.addEventListener("input", () => { result.textContent = "预览已更新，尚未保存"; showDraft(); });
  preview.addEventListener("load", showDraft);
  document.getElementById("example").onclick = () => { css.value += `\n${example}`; css.dispatchEvent(new Event("input")); };
  document.getElementById("reset").onclick = () => { css.value = ""; css.dispatchEvent(new Event("input")); result.textContent = "已预览默认样式，点击保存后应用"; };
  save.onclick = async () => {
    const submitted = css.value;
    save.disabled = true;
    result.textContent = "正在保存…";
    try {
      const response = await fetch("/subtitle/custom.css", { method: "PUT", headers: { "Content-Type": "text/css; charset=utf-8" }, body: submitted });
      if (!response.ok) throw new Error(`保存失败（${response.status}）`);
      saved = submitted;
      result.textContent = css.value === saved ? "已保存，OBS 字幕样式已更新" : "已保存上一版，当前还有未保存的修改";
    } catch (error) { result.textContent = error.message; }
    finally { save.disabled = false; }
  };
  document.getElementById("copy").onclick = async () => {
    try { await navigator.clipboard.writeText(url.value); result.textContent = "已复制 OBS 地址"; }
    catch { url.focus(); url.select(); result.textContent = "请复制选中的地址"; }
  };
  fetch("/subtitle/config").then(async (response) => {
    if (!response.ok) throw new Error("无法加载字幕配置，请刷新重试");
    const config = await response.json();
    css.value = saved = config.css;
    document.getElementById("css-path").textContent = config.css_path;
    css.disabled = save.disabled = false;
    result.textContent = "已加载当前样式";
    showDraft();
  }).catch((error) => { result.textContent = error.message; });
  window.addEventListener("beforeunload", (event) => { if (css.value !== saved) { event.preventDefault(); event.returnValue = ""; } });
})();
