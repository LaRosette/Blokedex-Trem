(() => {
  "use strict";

  if (window.top !== window) return;
  const api = globalThis.browser ?? globalThis.chrome;
  const core = globalThis.BlokedexFilter;
  if (!api?.runtime?.id || !core) return;

  const ARTICLE = 'article[data-testid="tweet"]';
  const HEADER = '[data-testid="User-Name"]';
  const CELL = '[data-testid="cellInnerDiv"]';
  const HIDDEN = "data-blokedex-hidden";
  const hidden = new Set();
  const collapsed = new Set();
  const pendingArticles = new Set();
  const pendingCells = new Set();
  let enabled = false;
  let revision = -1;
  let usernames = new Set();
  let observer = null;
  let queued = false;
  let connection = null;

  const elementOf = (node) =>
    node?.nodeType === 1 ? node : node?.parentElement;
  const anchorsOf = (header) =>
    [...header.querySelectorAll("a[href]")]
      .filter((link) => link.closest(HEADER) === header)
      .map((link) => link.getAttribute("href"));

  function headersOf(article) {
    const headers = [...article.querySelectorAll(HEADER)].filter(
      (header) => header.closest(ARTICLE) === article,
    );
    const groups = headers.map((header) => ({ links: anchorsOf(header) }));
    for (let index = 0; index < headers.length; index++) {
      const header = headers[index];
      const quote = header.closest('div[role="link"]');
      // A quotation lives inside the same article, with a separately identified
      // main author outside it. An unhydrated main header is not a quotation.
      if (
        !quote ||
        quote.hasAttribute("href") ||
        quote.closest(ARTICLE) !== article ||
        !headers.some(
          (other, otherIndex) =>
            !quote.contains(other) &&
            core.headerUsername(groups[otherIndex], location.origin).username,
        )
      )
        continue;
      groups[index].quote = true;
      if (groups[index].links.length) continue;
      groups[index].handles = [...header.querySelectorAll("span")]
        .filter(
          (span) => !span.children.length && span.closest(HEADER) === header,
        )
        .map((span) => span.textContent.trim())
        .filter((text) => /^@[A-Za-z0-9_]{1,15}$/.test(text));
    }
    return groups;
  }

  function matches(article) {
    return core.matchesArticle(headersOf(article), usernames, location.origin);
  }

  function setHidden(element, hide, collection) {
    if (hide) {
      if (element.getAttribute(HIDDEN) !== "true")
        element.setAttribute(HIDDEN, "true");
      collection.add(element);
    } else {
      element.removeAttribute(HIDDEN);
      collection.delete(element);
    }
  }

  function updateArticle(article) {
    const current = article.isConnected && article.matches(ARTICLE);
    const hide = current && matches(article);
    setHidden(article, hide, hidden);
    if (hide) {
      for (const media of article.querySelectorAll("video,audio")) {
        if (!media.paused) media.pause();
      }
    }
    const cell = article.closest(CELL);
    if (cell) pendingCells.add(cell);
  }

  function updateCell(cell) {
    if (!cell.isConnected || !cell.matches(CELL)) {
      setHidden(cell, false, collapsed);
      return;
    }
    const articles = [...cell.querySelectorAll(ARTICLE)].filter((article) => {
      const outer = article.parentElement?.closest(ARTICLE);
      return (
        article.closest(CELL) === cell && (!outer || !cell.contains(outer))
      );
    });
    setHidden(
      cell,
      articles.length > 0 && articles.every((article) => hidden.has(article)),
      collapsed,
    );
  }

  function flush() {
    queued = false;
    if (!enabled) return;
    const articles = [...pendingArticles];
    pendingArticles.clear();
    for (const article of hidden) {
      if (!article.isConnected || !article.matches(ARTICLE)) {
        setHidden(article, false, hidden);
        const cell = article.closest(CELL);
        if (cell) pendingCells.add(cell);
      }
    }
    for (const article of articles) updateArticle(article);
    for (const cell of collapsed) {
      if (!cell.isConnected || !cell.matches(CELL))
        setHidden(cell, false, collapsed);
    }
    for (const cell of pendingCells) updateCell(cell);
    pendingCells.clear();
  }

  function enqueue() {
    if (queued || !enabled) return;
    queued = true;
    queueMicrotask(flush);
  }

  function touch(node, descendants = false) {
    const element = elementOf(node);
    if (!element) return;
    if (hidden.has(element)) pendingArticles.add(element);
    const article = element.closest(ARTICLE);
    if (article) pendingArticles.add(article);
    const cell = element.closest(CELL);
    if (cell) pendingCells.add(cell);
    if (descendants) {
      for (const child of element.querySelectorAll(ARTICLE))
        pendingArticles.add(child);
    }
  }

  function observe() {
    if (observer) return;
    observer = new MutationObserver((records) => {
      for (const record of records) {
        touch(record.target);
        if (record.type === "childList") {
          for (const node of record.addedNodes) touch(node, true);
        }
      }
      enqueue();
    });
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["href", "data-testid"],
    });
  }

  function restore() {
    observer?.disconnect();
    observer = null;
    pendingArticles.clear();
    pendingCells.clear();
    for (const article of hidden) article.removeAttribute(HIDDEN);
    for (const cell of collapsed) cell.removeAttribute(HIDDEN);
    hidden.clear();
    collapsed.clear();
  }

  function applySettings(value) {
    const settings = core.normalizeSettings(value);
    if (!settings || settings.revision < revision) return false;
    revision = settings.revision;
    enabled = settings.enabled;
    usernames = new Set(settings.usernames);
    if (!enabled) {
      restore();
      return true;
    }
    observe();
    // Full scans happen only when a configuration snapshot arrives. Mutations
    // are processed through the sets of affected articles and cells above.
    for (const article of document.querySelectorAll(ARTICLE))
      pendingArticles.add(article);
    flush();
    return true;
  }

  function guard(event) {
    if (!enabled) return;
    let article = elementOf(event.target)?.closest(ARTICLE);
    let matched = false;
    while (article) {
      updateArticle(article);
      if (hidden.has(article)) matched = true;
      article = article.parentElement?.closest(ARTICLE);
    }
    for (const cell of pendingCells) updateCell(cell);
    pendingCells.clear();
    if (matched) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }
  for (const type of ["click", "auxclick", "pointerdown", "keydown"]) {
    document.addEventListener(type, guard, true);
  }
  document.addEventListener(
    "play",
    (event) => {
      if (!enabled) return;
      const article = elementOf(event.target)?.closest(ARTICLE);
      if (
        article &&
        matches(article) &&
        typeof event.target.pause === "function"
      )
        event.target.pause();
    },
    true,
  );

  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender?.id !== api.runtime.id) return;
    if (message?.type === "applyFilter") {
      respond({ ok: applySettings(message.settings) });
    } else if (message?.type === "filterStats") {
      flush();
      respond({ version: 3, hidden: hidden.size, active: enabled });
    }
  });

  function withTimeout(promise) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Configuration indisponible")),
          2500,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function requestSettings() {
    if (connection) return connection;
    connection = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt)
          await new Promise((resolve) => setTimeout(resolve, attempt * 400));
        try {
          const reply = await withTimeout(
            api.runtime.sendMessage({ type: "filterConfig" }),
          );
          if (reply?.ok === true && core.normalizeSettings(reply.data)) {
            applySettings(reply.data);
            return;
          }
        } catch {
          // A missing initial snapshot leaves the page visible. A future
          // pageshow or an extension broadcast can reconnect without a reload.
        }
      }
    })().finally(() => {
      connection = null;
    });
    return connection;
  }
  window.addEventListener("pageshow", requestSettings);
  requestSettings();
})();
