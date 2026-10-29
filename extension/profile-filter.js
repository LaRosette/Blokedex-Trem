(() => {
  "use strict";
  const core = globalThis.BlokedexFilter;
  const CARD = '[data-testid="UserCell"],[role="listbox"] [role="option"]';
  const CARD_HIDDEN = "data-blokedex-card-hidden";
  const PROFILE_HIDDEN = "data-blokedex-profile-hidden";
  const CHILD_HIDDEN = "data-blokedex-profile-child";

  function routeUsername(path) {
    const match =
      /^\/([A-Za-z0-9_]{1,15})(?:\/(with_replies|media|highlights|articles))?\/?$/.exec(
        path,
      );
    return match ? core.username(match[1]) : null;
  }
  function cardUsername(card) {
    if (
      card.closest(
        'article,nav,header[role="banner"],[data-testid="SideNav_AccountSwitcher_Button"]',
      )
    )
      return null;
    const names = new Set();
    for (const link of card.querySelectorAll("a[href]")) {
      if (link.closest(CARD) !== card) continue;
      const name = core.profileUsername(
        link.getAttribute("href"),
        location.origin,
      );
      if (name && link.textContent.trim().toLowerCase() === "@" + name)
        names.add(name);
    }
    // Search options can contain no anchors. Their avatar has a native username
    // identifier; require the same exact handle in a leaf span as a second check.
    if (!names.size && card.matches('[role="option"]')) {
      for (const avatar of card.querySelectorAll(
        '[data-testid^="UserAvatar-Container-"]',
      )) {
        const name = core.username(
          avatar.getAttribute("data-testid").slice(21),
        );
        if (
          name &&
          [...card.querySelectorAll("span")].some(
            (span) =>
              !span.children.length &&
              span.textContent.trim().toLowerCase() === "@" + name,
          )
        )
          names.add(name);
      }
      if (!names.size) {
        const shortcut = /^(?:Aller à|Go to) @([A-Za-z0-9_]{1,15})$/.exec(
          card.textContent.trim(),
        );
        if (shortcut && core.username(shortcut[1]))
          names.add(core.username(shortcut[1]));
      }
    }
    return names.size === 1 ? [...names][0] : null;
  }

  function create({ onPause } = {}) {
    let settings = { enabled: false, revision: -1, usernames: [] };
    let names = new Set(),
      observer,
      frame,
      column,
      panel;
    const hidden = new Map(),
      children = new Map();
    function conceal(node, attribute, records) {
      if (!records.has(node))
        records.set(node, {
          aria: node.getAttribute("aria-hidden"),
          inert: node.getAttribute("inert"),
        });
      if (node.getAttribute(attribute) !== "true")
        node.setAttribute(attribute, "true");
      if (node.getAttribute("aria-hidden") !== "true")
        node.setAttribute("aria-hidden", "true");
      if (!node.hasAttribute("inert")) node.setAttribute("inert", "");
    }
    function reveal(node, attribute, records) {
      const previous = records.get(node);
      node.removeAttribute(attribute);
      if (previous)
        for (const [name, value] of [
          ["aria-hidden", previous.aria],
          ["inert", previous.inert],
        ]) {
          if (value === null) node.removeAttribute(name);
          else node.setAttribute(name, value);
        }
      records.delete(node);
    }
    function clearProfile() {
      for (const node of children.keys()) reveal(node, CHILD_HIDDEN, children);
      column?.removeAttribute(PROFILE_HIDDEN);
      column = null;
      panel?.remove();
      panel = null;
    }
    function positionPanel() {
      if (!panel || !column?.isConnected) return;
      const rect = column.getBoundingClientRect();
      const left = Math.max(0, rect.left),
        right = Math.min(innerWidth, rect.right);
      panel.style.left = left + "px";
      panel.style.top = Math.max(0, Math.min(80, rect.top)) + "px";
      panel.style.width = Math.max(0, right - left) + "px";
      panel.hidden = right <= left;
    }
    function updateProfile() {
      const name = routeUsername(location.pathname);
      const current =
        settings.enabled && name && names.has(name)
          ? document.querySelector('[data-testid="primaryColumn"]')
          : null;
      if (current !== column) clearProfile();
      if (!current) return;
      column = current;
      if (column.getAttribute(PROFILE_HIDDEN) !== "true")
        column.setAttribute(PROFILE_HIDDEN, "true");
      for (const child of column.children)
        conceal(child, CHILD_HIDDEN, children);
      for (const child of children.keys())
        if (!column.contains(child)) reveal(child, CHILD_HIDDEN, children);
      if (!panel && document.body) {
        panel = document.createElement("section");
        panel.id = "blokedex-profile-panel";
        panel.setAttribute("aria-label", "Profil masqué par Blokedex-Trem");
        const title = document.createElement("h2"),
          text = document.createElement("p"),
          button = document.createElement("button");
        title.textContent = "Profil masqué";
        text.textContent =
          "Ce compte fait partie de votre liste. Son profil reste masqué tant que le filtre est actif.";
        button.textContent = "Mettre le filtre en pause";
        button.type = "button";
        button.addEventListener("click", (event) => {
          if (event.isTrusted) onPause?.();
        });
        panel.append(title, text, button);
        document.body.append(panel);
      }
      for (const media of column.querySelectorAll("video,audio"))
        if (!media.paused) media.pause();
      positionPanel();
    }
    function scan() {
      frame = null;
      if (!settings.enabled) return;
      for (const card of hidden.keys()) {
        if (
          !card.isConnected ||
          !card.matches(CARD) ||
          !names.has(cardUsername(card))
        )
          reveal(card, CARD_HIDDEN, hidden);
      }
      for (const card of document.querySelectorAll(CARD))
        if (names.has(cardUsername(card))) conceal(card, CARD_HIDDEN, hidden);
      updateProfile();
    }
    function schedule() {
      if (settings.enabled && frame == null)
        frame = requestAnimationFrame(scan);
    }
    function guard(event) {
      if (!settings.enabled) return;
      const target =
        event.target?.nodeType === 1
          ? event.target
          : event.target?.parentElement;
      const selected =
        event.type === "keydown" &&
        event.key === "Enter" &&
        target?.getAttribute("role") === "combobox"
          ? document.getElementById(
              target.getAttribute("aria-activedescendant"),
            )
          : null;
      const card = selected?.closest(CARD) || target?.closest(CARD);
      if (card && names.has(cardUsername(card))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }
    function wheel(event) {
      if (
        column &&
        (column.contains(event.target) || panel?.contains(event.target))
      )
        event.preventDefault();
    }
    for (const type of ["click", "auxclick", "pointerdown", "keydown"])
      document.addEventListener(type, guard, true);
    document.addEventListener("wheel", wheel, {
      capture: true,
      passive: false,
    });
    document.addEventListener(
      "play",
      (event) => {
        if (column?.contains(event.target)) event.target.pause?.();
      },
      true,
    );
    addEventListener("popstate", schedule);
    addEventListener("hashchange", schedule);
    addEventListener("resize", positionPanel);
    addEventListener("scroll", positionPanel, { passive: true });
    return {
      apply(value) {
        if (value.revision < settings.revision) return;
        settings = value;
        names = new Set(value.usernames);
        if (!value.enabled) {
          observer?.disconnect();
          observer = null;
          if (frame != null) cancelAnimationFrame(frame);
          frame = null;
          for (const card of hidden.keys()) reveal(card, CARD_HIDDEN, hidden);
          clearProfile();
        } else {
          if (!observer) {
            observer = new MutationObserver(schedule);
            observer.observe(document, {
              subtree: true,
              childList: true,
              characterData: true,
              attributes: true,
              attributeFilter: ["href", "data-testid", "role"],
            });
          }
          scan();
        }
      },
      stats: () => ({ cards: hidden.size, profile: !!column }),
    };
  }
  globalThis.BlokedexProfiles = Object.freeze({ create, routeUsername });
})();
