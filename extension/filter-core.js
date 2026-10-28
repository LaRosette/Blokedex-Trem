(() => {
  "use strict";

  const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
  const RESERVED = new Set([
    "i",
    "home",
    "explore",
    "search",
    "notifications",
    "messages",
    "settings",
    "compose",
    "login",
    "logout",
    "signup",
    "account",
    "accounts",
    "intent",
    "share",
    "hashtag",
    "communities",
    "jobs",
    "lists",
    "topics",
    "bookmarks",
    "premium",
    "tos",
    "privacy",
    "about",
    "download",
    "verified",
    "verification",
    "oauth",
    "connect",
    "who_to_follow",
    "widgets",
  ]);

  function username(value) {
    if (
      typeof value !== "string" ||
      value.trim() !== value ||
      !HANDLE.test(value)
    )
      return null;
    const normalized = value.toLowerCase();
    return RESERVED.has(normalized) ? null : normalized;
  }

  function profileUsername(value, base = "https://x.com") {
    if (typeof value !== "string" || !value || /[\\\s]/.test(value))
      return null;
    try {
      // Reject explicit ports (including :443, which URL would normalize away).
      const absolute = /^https:\/\/([^/?#]*)/i.exec(value);
      if (absolute && /[:@]/.test(absolute[1])) return null;
      if (!absolute && !/^\/(?!\/)/.test(value)) return null;
      const url = new URL(value, base);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        !["x.com", "twitter.com"].includes(url.hostname)
      )
        return null;
      const path = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(url.pathname);
      return path ? username(path[1]) : null;
    } catch {
      return null;
    }
  }

  function normalizeSettings(value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.enabled !== "boolean" ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Array.isArray(value.usernames) ||
      value.usernames.length > 10000
    )
      return null;
    const names = new Set();
    for (const name of value.usernames) {
      const normalized = username(name);
      if (!normalized) return null;
      names.add(normalized);
    }
    return {
      enabled: value.enabled,
      revision: value.revision,
      usernames: [...names],
    };
  }

  function headerUsername(header, base = "https://x.com") {
    if (!header || !Array.isArray(header.links))
      return { ambiguous: true, username: null };
    const names = new Set(
      header.links.map((link) => profileUsername(link, base)).filter(Boolean),
    );
    // This fallback is supplied only for the author header of a native quote,
    // whose current X markup has no profile anchors. Never pass body text here.
    if (
      !header.links.length &&
      header.quote === true &&
      Array.isArray(header.handles)
    ) {
      for (const handle of header.handles) {
        if (typeof handle !== "string" || !/^@[A-Za-z0-9_]{1,15}$/.test(handle))
          continue;
        const normalized = username(handle.slice(1));
        if (normalized) names.add(normalized);
      }
    }
    return {
      ambiguous: names.size > 1,
      username: names.size === 1 ? [...names][0] : null,
    };
  }

  function matchesArticle(headers, names, base = "https://x.com") {
    if (!Array.isArray(headers) || !(names instanceof Set)) return false;
    let matches = false;
    const primaryAuthors = new Set();
    for (const header of headers) {
      const author = headerUsername(header, base);
      // Conflicting accounts inside one author header are not a safe match.
      if (author.ambiguous) return false;
      if (author.username && header.quote !== true)
        primaryAuthors.add(author.username);
      if (primaryAuthors.size > 1) return false;
      if (author.username && names.has(author.username)) matches = true;
    }
    // A listed native quotation hides its containing post as well. Separate
    // author and quote headers may legitimately identify different accounts.
    return matches;
  }

  globalThis.BlokedexFilter = Object.freeze({
    username,
    profileUsername,
    normalizeSettings,
    headerUsername,
    matchesArticle,
  });
})();
