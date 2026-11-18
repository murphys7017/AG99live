"use strict";
(() => {
  const shell = document.getElementById("subtitle");
  const text = document.getElementById("text");
  const speaker = document.getElementById("speaker");
  const status = document.getElementById("status");
  const preview = new URLSearchParams(location.search).get("preview") === "1";
  const readingKey = preview ? "" : new URLSearchParams(location.hash.slice(1)).get("reading") || "";
  const renderer = readingKey ? crypto.randomUUID() : "";
  const readingCard = document.getElementById("reading");
  const readingText = document.getElementById("reading-text");
  const customCss = document.getElementById("custom-css");
  let rendered = null;
  let pendingReading = null;
  let lastReportedVisible = false;
  let readingSequence = 0;
  let cssRevision = -1;
  let latestRevision = -1;

  function hide() { shell.hidden = true; text.textContent = ""; }
  function display(caption) {
    if (caption.state === "idle" || !caption.text) { hide(); return; }
    // Text is data, including model output. It is never interpreted as HTML.
    text.textContent = caption.text;
    speaker.textContent = caption.speaker;
    status.textContent = caption.state === "speaking" ? "正在说话" : caption.state === "text" ? "文字回复" : "说话结束";
    shell.dataset.state = caption.state;
    shell.hidden = false;
  }
  if (preview) {
    display({ state: "speaking", speaker: "Alice", text: "这个动作怎么样？你们可以发送加号或者减号来评价一下哦。" });
    document.getElementById("footer").textContent = "字幕示例，后续可根据 TTS 播放进度更新。";
  }

  function isReadingVisible() {
    if (document.hidden || readingCard.hidden || getComputedStyle(readingText).visibility !== "visible") return false;
    const bounds = readingText.getBoundingClientRect();
    if (!bounds.width || !bounds.height || bounds.bottom <= 0 || bounds.right <= 0 ||
        bounds.top >= window.innerHeight || bounds.left >= window.innerWidth) return false;
    for (let element = readingText; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (Number(style.opacity) === 0 || style.contentVisibility === "hidden") return false;
    }
    return true;
  }
  async function acknowledgeReading(forceHidden = false) {
    if (!rendered) return;
    const visible = !forceHidden && isReadingVisible();
    if (!visible && !lastReportedVisible) return;
    lastReportedVisible = visible;
    try {
      await fetch("/subtitle/reading/rendered", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...rendered, key: readingKey, renderer, visible, sequence: ++readingSequence }),
        cache: "no-store",
        keepalive: !visible,
      });
    } catch { /* The display lease expires when the host is unreachable. */ }
  }
  function refreshReadingVisibility() {
    if (isReadingVisible()) requestAnimationFrame(() => void acknowledgeReading());
    else void acknowledgeReading(true);
  }
  function displayReading(reading) {
    if (!reading || typeof reading.text !== "string" || !reading.text) {
      void acknowledgeReading(true);
      rendered = null;
      pendingReading = null;
      readingCard.hidden = true;
      readingText.textContent = "";
      return;
    }
    const previousReading = pendingReading || rendered;
    if (previousReading?.session_id === reading.session_id &&
        previousReading?.display_revision === reading.display_revision) return;
    const current = {
      session_id: reading.session_id, visit_id: reading.visit_id, display_revision: reading.display_revision,
    };
    rendered = null;
    lastReportedVisible = false;
    document.getElementById("reading-title").textContent = reading.title;
    document.getElementById("reading-progress").textContent = `${reading.position} / ${reading.total}`;
    readingText.textContent = reading.text;
    readingCard.hidden = false;
    pendingReading = current;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (readingCard.hidden || pendingReading !== current) return;
      pendingReading = null;
      rendered = current;
      void acknowledgeReading();
    }));
  }
  const eventPath = readingKey
    ? "/subtitle/events?" + new URLSearchParams({ reading: readingKey, renderer })
    : "/subtitle/events";
  const events = new EventSource(eventPath);
  const heartbeat = readingKey ? setInterval(() => void acknowledgeReading(), 2500) : null;
  if (readingKey) {
    document.addEventListener("visibilitychange", refreshReadingVisibility);
    window.addEventListener("resize", refreshReadingVisibility);
    customCss.addEventListener("load", refreshReadingVisibility);
  }
  events.onopen = () => { latestRevision = -1; cssRevision = -1; };
  events.onmessage = (event) => {
    try {
      const snapshot = JSON.parse(event.data);
      if (!Number.isInteger(snapshot.revision) || snapshot.revision <= latestRevision) return;
      latestRevision = snapshot.revision;
      if (snapshot.css_revision !== cssRevision) {
        cssRevision = snapshot.css_revision;
        customCss.href = `/subtitle/custom.css?v=${cssRevision}&t=${Date.now()}`;
      }
      if (!preview) display(snapshot.caption);
      if (readingKey) displayReading(snapshot.reading);
    } catch (error) { console.error("Subtitle update rejected", error); if (!preview) hide(); }
  };
  events.onerror = () => {
    if (!preview) hide();
    if (readingKey) displayReading(null);
  };
  // The editor previews drafts locally. They never affect an OBS source until saved.
  window.addEventListener("message", (event) => {
    if (!preview || event.origin !== location.origin || event.source !== window.parent || event.data?.type !== "subtitle.css-preview") return;
    customCss.disabled = true;
    let draft = document.getElementById("draft-css");
    if (!draft) { draft = document.createElement("style"); draft.id = "draft-css"; document.head.append(draft); }
    draft.textContent = String(event.data.css || "");
  });
  window.addEventListener("pagehide", () => {
    void acknowledgeReading(true);
    events.close();
    if (heartbeat !== null) clearInterval(heartbeat);
  });
})();
