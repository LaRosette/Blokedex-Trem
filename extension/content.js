(() => {
  "use strict";

  if (window.top !== window) return;
  const api = globalThis.browser ?? globalThis.chrome;
  const core = globalThis.BlokedexFilter;
  if (!api?.runtime?.id || !core) return;

  const ARTICLE = 'article[data-testid="tweet"]';
  const HEADER = '[data-testid="User-Name"]';
  const HIDDEN = "data-blokedex-hidden";
  const QUOTE_HIDDEN = "data-blokedex-quote-hidden";
  const hidden = new Set();
  const hiddenQuotes = new Set();
  const pendingArticles = new Set();
  let enabled = false;
  let revision = -1;
  let usernames = new Set();
  let observer = null;
  let queued = false;
  let connection = null;
  let blocking = false;
  let preferredSettings = null;
  const profiles = globalThis.BlokedexProfiles?.create({
    onPause: () =>
      api.runtime.sendMessage({ type: "pauseFilter" }).catch(() => {}),
  });

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
      groups[index].quoteElement = quote;
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

  function setHidden(element, hide, collection, attribute = HIDDEN) {
    if (hide) {
      if (element.getAttribute(attribute) !== "true")
        element.setAttribute(attribute, "true");
      collection.add(element);
    } else {
      element.removeAttribute(attribute);
      collection.delete(element);
    }
  }

  function pauseMedia(element) {
    for (const media of element.querySelectorAll("video,audio")) {
      if (!media.paused) media.pause();
    }
  }
  function updateArticle(article) {
    const current = article.isConnected && article.matches(ARTICLE);
    const headers = current ? headersOf(article) : [];
    const hide =
      current && core.matchesArticle(headers, usernames, location.origin);
    setHidden(article, hide, hidden);
    for (const quote of hiddenQuotes) {
      if (quote.closest(ARTICLE) === article || !quote.isConnected)
        setHidden(quote, false, hiddenQuotes, QUOTE_HIDDEN);
    }
    if (hide) pauseMedia(article);
    else if (current) {
      for (const header of headers) {
        if (!header.quoteElement) continue;
        const author = core.headerUsername(header, location.origin);
        if (
          !author.ambiguous &&
          author.username &&
          usernames.has(author.username)
        ) {
          setHidden(header.quoteElement, true, hiddenQuotes, QUOTE_HIDDEN);
          pauseMedia(header.quoteElement);
        }
      }
    }
  }

  function flush() {
    queued = false;
    if (!enabled) return;
    const articles = [...pendingArticles];
    pendingArticles.clear();
    for (const article of hidden) {
      if (!article.isConnected || !article.matches(ARTICLE))
        setHidden(article, false, hidden);
    }
    for (const quote of hiddenQuotes) {
      if (!quote.isConnected)
        setHidden(quote, false, hiddenQuotes, QUOTE_HIDDEN);
    }
    for (const article of articles) updateArticle(article);
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
    for (const article of hidden) article.removeAttribute(HIDDEN);
    for (const quote of hiddenQuotes) quote.removeAttribute(QUOTE_HIDDEN);
    hidden.clear();
    hiddenQuotes.clear();
  }

  function applySettings(value) {
    const settings = core.normalizeSettings(value);
    if (!settings || settings.revision < revision) return false;
    preferredSettings = settings;
    revision = settings.revision;
    enabled = settings.enabled && !blocking;
    usernames = new Set(settings.usernames);
    profiles?.apply({ ...settings, enabled });
    if (!enabled) {
      restore();
      return true;
    }
    observe();
    // Full scans happen only when a configuration snapshot arrives. Mutations
    // are processed through the set of affected articles above.
    for (const article of document.querySelectorAll(ARTICLE))
      pendingArticles.add(article);
    flush();
    return true;
  }
  globalThis.BlokedexPage = Object.freeze({
    setBlocking(value) {
      blocking = value === true;
      if (preferredSettings) applySettings(preferredSettings);
    },
  });

  function guard(event) {
    if (!enabled) return;
    let article = elementOf(event.target)?.closest(ARTICLE);
    let matched = false;
    while (article) {
      updateArticle(article);
      if (hidden.has(article)) matched = true;
      if (elementOf(event.target)?.closest(`[${QUOTE_HIDDEN}="true"]`))
        matched = true;
      article = article.parentElement?.closest(ARTICLE);
    }
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
      if (article) updateArticle(article);
      if (
        article &&
        (hidden.has(article) ||
          elementOf(event.target)?.closest(`[${QUOTE_HIDDEN}="true"]`)) &&
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
      respond({
        version: 3,
        hidden:
          hidden.size +
          [...hiddenQuotes].filter(
            (quote) => !hidden.has(quote.closest(ARTICLE)),
          ).length,
        active: enabled,
      });
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
