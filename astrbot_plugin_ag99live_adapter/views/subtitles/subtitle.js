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
  let captionId = "";
  let captionTimer;
  let pageTimer;
  let material = null;
  let captionValue = null;
  let layout = "";
  if (readingKey) document.body.classList.add("co-reading");

  // Measure using the OBS source's actual font, custom CSS and viewport.
  function pageOf(node, value, height) {
    const characters = Array.from(value);
    let lo = 1, hi = characters.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      node.textContent = characters.slice(0, mid).join("");
      if (node.getBoundingClientRect().height <= height + 1) lo = mid;
      else hi = mid - 1;
    }
    let part = characters.slice(0, lo).join("");
    if (lo < characters.length) {
      const breaks = [...part.matchAll(/[。！？；，、,.!?\n]\s*/gu)];
      const end = breaks.at(-1);
      if (end && end.index >= part.length / 2) part = part.slice(0, end.index + end[0].length);
    }
    node.textContent = part;
    return value.slice(part.length).trimStart();
  }

  function showCaptionPage(value) {
    const line = parseFloat(getComputedStyle(text).lineHeight);
    const rest = pageOf(text, value, line * 2);
    if (rest) captionTimer = setTimeout(() => showCaptionPage(rest),
      Math.max(900, Array.from(text.textContent).length * 150));
  }

  function showReadingPage(value) {
    const room = window.innerHeight - readingText.getBoundingClientRect().top
      - parseFloat(getComputedStyle(readingCard).paddingBottom) - 12;
    const rest = pageOf(readingText, value, room);
    if (rest) pageTimer = setTimeout(() => showReadingPage(rest),
      Math.max(1100, Array.from(readingText.textContent).length * 100));
  }

  function excerpt(passage, speech) {
    const sentences = passage.match(/[^。！？!?\n]+[。！？!?]*/gu) || [passage];
    // Use only words from the visible passage, including when the AI paraphrases.
    const pairs = new Set(Array.from(speech).slice(1).map((_, i) => speech.slice(i, i + 2)));
    const score = sentence => [...pairs].filter(pair => sentence.includes(pair)).length;
    let best = sentences[0], max = score(best);
    for (const sentence of sentences.slice(1)) {
      const weight = score(sentence);
      if (weight > max) { best = sentence; max = weight; }
    }
    return best;
  }

  function hide() {
    clearTimeout(captionTimer);
    captionId = "";
    captionValue = null;
    shell.hidden = true;
    text.textContent = "";
  }
  function display(caption) {
    if (caption.state === "idle" || !caption.text || (readingKey && caption.state === "ended")) { hide(); return; }
    // Text is data, including model output. It is never interpreted as HTML.
    speaker.textContent = caption.speaker;
    status.textContent = caption.state === "speaking" ? "正在说话" : caption.state === "text" ? "文字回复" : "说话结束";
    shell.dataset.state = caption.state;
    shell.hidden = false;
    if (!readingKey) { text.textContent = caption.text; return; }
    captionValue = caption;
    const id = JSON.stringify([caption.turn_id, caption.segment_id, caption.text]);
    if (id !== captionId) {
      clearTimeout(captionTimer);
      captionId = id;
      showCaptionPage(caption.text);
    }
  }
  if (preview) {
    display({ state: "speaking", speaker: "Alice", text: "这个动作怎么样？你们可以发送加号或者减号来评价一下哦。" });
    document.getElementById("footer").textContent = "字幕示例，后续可根据 TTS 播放进度更新。";
  }

  function isReadingVisible() {
    if (document.hidden || readingCard.hidden || layout === "bookmark" ||
        (layout === "quote" && material?.mode !== "quote") ||
        getComputedStyle(readingText).visibility !== "visible") return false;
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
  function displayReading(reading, force = false) {
    const old = material;
    material = reading;
    if (!reading || typeof reading.text !== "string") {
      clearTimeout(pageTimer);
      void acknowledgeReading(true);
      rendered = null;
      pendingReading = null;
      readingCard.hidden = true;
      readingText.textContent = "";
      return;
    }
    const mode = reading.mode || "passage";
    const nextLayout = mode === "passage" && captionValue ? "quote" : mode;
    if (!force && old?.session_id === reading.session_id &&
        old.display_revision === reading.display_revision && layout === nextLayout &&
        (nextLayout !== "quote" || mode === "quote" || readingCard.dataset.caption === captionId)) return;
    void acknowledgeReading(true);
    clearTimeout(pageTimer);
    layout = nextLayout;
    readingCard.dataset.mode = layout;
    readingCard.dataset.caption = captionId;
    const current = {
      session_id: reading.session_id, visit_id: reading.visit_id, display_revision: reading.display_revision,
    };
    rendered = null;
    lastReportedVisible = false;
    document.getElementById("reading-title").textContent = reading.title;
    document.getElementById("reading-progress").textContent = `${reading.position} / ${reading.total}`;
    readingCard.hidden = false;
    readingText.hidden = layout === "bookmark";
    if (layout === "passage") showReadingPage(reading.text);
    else if (layout === "quote") {
      const quote = mode === "quote" ? reading.text : excerpt(reading.text, captionValue.text);
      const line = parseFloat(getComputedStyle(readingText).lineHeight);
      pageOf(readingText, quote, Math.min(line * 3, window.innerHeight * 0.36));
    } else readingText.textContent = "";
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
    let lastWidth = innerWidth, lastHeight = innerHeight;
    window.addEventListener("resize", () => {
      if (innerWidth !== lastWidth || innerHeight !== lastHeight) {
        lastWidth = innerWidth; lastHeight = innerHeight;
        if (captionValue) { captionId = ""; display(captionValue); }
        if (material) displayReading(material, true);
      }
      refreshReadingVisibility();
    });
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
