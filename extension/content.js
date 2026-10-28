(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  let running = null;
  const visible = (element) => element && element.getClientRects().length > 0;
  const find = (selector) =>
    Array.from(document.querySelectorAll(selector)).find(visible);
  const owner = () => {
    const link = find('a[data-testid="AppTabBar_Profile_Link"]');
    return link
      ? new URL(link.href).pathname.split("/").filter(Boolean)[0]
      : null;
  };
  const failure = (code, message) =>
    Object.assign(new Error(message), { code });
  const assertActive = (task) => {
    if (running !== task || task.controller.signal.aborted)
      throw failure("cancelled", "Blocage arrêté.");
    if (Date.now() >= task.deadline)
      throw failure("loading", "X ne répond pas. Le blocage est en pause.");
  };
  const targetsUsername = (text, username) => {
    const handles = text.match(/@[A-Za-z0-9_]+/g) || [];
    return (
      handles.length > 0 &&
      handles.every(
        (handle) => handle.slice(1).toLowerCase() === username.toLowerCase(),
      )
    );
  };
  const click = (element, task) => {
    assertActive(task);
    if (!element?.isConnected || !visible(element))
      throw failure("identity", "Le profil affiché a changé.");
    element.click();
  };
  async function ownerKey(username) {
    const avatar = find('[data-testid="SideNav_AccountSwitcher_Button"] img');
    if (!avatar || !username) return null;
    try {
      const url = new URL(avatar.currentSrc || avatar.src);
      if (
        url.hostname !== "pbs.twimg.com" ||
        !/^\/profile_images\/\d+\//.test(url.pathname)
      )
        return null;
      const reference =
        username.toLowerCase() +
        "|" +
        url.pathname.replace(/_(normal|bigger|mini)(?=\.)/, "");
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(reference),
      );
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    } catch {
      return null;
    }
  }
  function siteIssue() {
    if (/^\/(login|i\/flow\/(login|challenge))\b/.test(location.pathname)) {
      return failure("auth", "Connectez-vous à X, puis reprenez le blocage.");
    }
    const notices = Array.from(
      document.querySelectorAll(
        '[role="alert"],[data-testid="toast"],[data-testid="error-detail"],[data-testid="emptyState"]',
      ),
    ).filter(visible);
    if (
      notices.some((el) =>
        /rate limit|too many requests|limite de (?:taux|requetes)|trop de (?:requetes|demandes)|limite.{0,25}atteinte/.test(
          normalize(el.textContent),
        ),
      )
    ) {
      return failure(
        "rate",
        "X limite les requêtes. La progression est conservée.",
      );
    }
    return null;
  }
  function waitFor(fn, task, timeout = 12000) {
    return new Promise((resolve, reject) => {
      let observer, timer;
      const stop = () => {
        observer?.disconnect();
        clearTimeout(timer);
        task.controller.signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        stop();
        reject(failure("cancelled", "Blocage arrêté."));
      };
      const check = () => {
        try {
          assertActive(task);
          const issue = siteIssue();
          if (issue) throw issue;
          const value = fn();
          if (value) {
            stop();
            resolve(value);
            return true;
          }
        } catch (error) {
          stop();
          reject(error);
          return true;
        }
        return false;
      };
      task.controller.signal.addEventListener("abort", onAbort, {
        once: true,
      });
      if (check()) return;
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      timer = setTimeout(
        () => {
          stop();
          reject(
            failure(
              "loading",
              "X ne répond pas correctement ou limite les requêtes. La progression est conservée. Attendez avant de reprendre avec « Vérifier X ».",
            ),
          );
        },
        Math.max(1, Math.min(timeout, task.deadline - Date.now())),
      );
      check();
    });
  }
  const normalize = (value) =>
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  const unblocks = (value) => /^(debloquer|unblock)\b/.test(normalize(value));
  const blockedButton = (element) =>
    element &&
    /^(debloquer|unblock|bloque|blocked)\b/.test(
      normalize(element.textContent + " " + element.getAttribute("aria-label")),
    );
  function assertProfile(message) {
    if (
      location.pathname.toLowerCase() !==
      `/${message.account.username.toLowerCase()}`
    )
      throw Error("Le profil affiché a changé. Cliquez pour reprendre.");
    if (owner()?.toLowerCase() !== message.owner.toLowerCase())
      throw Error(
        "Le compte X connecté a changé. Revenez au compte utilisé au lancement.",
      );
  }
  async function verifySession(message, task) {
    assertActive(task);
    assertProfile(message);
    if (
      message.ownerKey &&
      (await ownerKey(message.owner)) !== message.ownerKey
    )
      throw failure(
        "identity",
        "L’identité du compte connecté a changé. Le blocage est en pause.",
      );
    assertActive(task);
    assertProfile(message);
  }
  function profileControls(account) {
    const column =
      document.querySelector('[data-testid="primaryColumn"]') ||
      document.querySelector("main");
    const more = Array.from(
      column?.querySelectorAll('[data-testid="userActions"]') || [],
    ).find(
      (el) => visible(el) && !el.closest('article,[data-testid="UserCell"]'),
    );
    if (!more) return false;
    for (
      let group = more.parentElement, depth = 0;
      group && group !== column && depth < 3;
      group = group.parentElement, depth++
    ) {
      const buttons = Array.from(
        group.querySelectorAll("button[data-testid]"),
      ).filter(
        (el) => visible(el) && !el.closest('article,[data-testid="UserCell"]'),
      );
      const ids = buttons
        .map(
          (el) =>
            /^(\d+)-(?:follow|unfollow|unblock)$/.exec(
              el.getAttribute("data-testid"),
            )?.[1],
        )
        .filter(Boolean);
      if (!ids.length) {
        const generic = buttons.find(
          (el) =>
            el.getAttribute("data-testid") === "unblock" && blockedButton(el),
        );
        // Aucun clic ni cache d’identifiant si X masque l’identité numérique.
        if (generic) return { more, group, identityVerified: false };
        continue;
      }
      if (ids.length !== 1 || ids[0] !== account.id)
        throw failure(
          "identity",
          "X ne permet pas de vérifier l’identité de ce profil. Le blocage est en pause.",
        );
      return { more, group, identityVerified: true };
    }
    return false;
  }
  function verifiedControls(message) {
    assertProfile(message);
    const name = find('[data-testid="UserName"]');
    const controls = profileControls(message.account);
    if (
      !name ||
      !targetsUsername(name.textContent, message.account.username) ||
      !controls ||
      !controls.identityVerified
    )
      throw failure("identity", "L’identité du profil affiché a changé.");
    return controls;
  }
  async function block(message, task) {
    const account = message.account;
    const logged = await waitFor(owner, task);
    await verifySession(message, task);
    if (logged.toLowerCase() === account.username.toLowerCase())
      return "unavailable";
    const header = await waitFor(() => {
      const name = find('[data-testid="UserName"]');
      if (name) return { name };
      const empty = find('[data-testid="emptyState"]');
      if (
        empty &&
        /(?:ce compte n.existe pas|compte suspendu|account (?:doesn.t exist|suspended)|this account doesn.t exist)/i.test(
          empty.textContent,
        )
      )
        return { unavailable: true };
      return null;
    }, task);
    if (header.unavailable) return "unavailable";
    if (!targetsUsername(header.name.textContent, account.username))
      throw Error("Le profil affiché ne correspond pas à la liste.");
    // L’identifiant stable empêche de bloquer le nouveau propriétaire d’un pseudo.
    await waitFor(() => profileControls(account), task, 8000);
    await verifySession(message, task);
    const controls = profileControls(account);
    if (!controls)
      throw failure("identity", "L’identité du profil affiché a changé.");
    const already = Array.from(
      controls.group.querySelectorAll(
        `[data-testid="${account.id}-unblock"],[data-testid="unblock"]`,
      ),
    ).find(visible);
    if (blockedButton(already))
      return controls.identityVerified === false
        ? { outcome: "already", identityVerified: false }
        : "already";
    await verifySession(message, task);
    click(verifiedControls(message).more, task);
    const action = await waitFor(
      () => find('[role="menuitem"][data-testid="block"]'),
      task,
    );
    await verifySession(message, task);
    verifiedControls(message);
    const text = normalize(action.textContent);
    if (!targetsUsername(text, account.username))
      throw failure("identity", "Le menu ne correspond pas au profil ciblé.");
    if (unblocks(text)) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      return "already";
    }
    if (!/^(bloquer|block)\b/.test(text))
      throw Error("Commande de blocage non reconnue.");
    click(action, task);
    const confirm = await waitFor(
      () => find('[data-testid="confirmationSheetConfirm"]'),
      task,
    );
    await verifySession(message, task);
    verifiedControls(message);
    const dialog = confirm.closest(
      '[role="alertdialog"],[role="dialog"],[aria-modal="true"]',
    );
    if (
      !dialog ||
      !targetsUsername(dialog.textContent, account.username) ||
      !/^(bloquer|block)$/.test(normalize(confirm.textContent))
    )
      throw Error("Confirmation de blocage inattendue.");
    // Identité, session et tâche sont revérifiées dans le même tour que le clic.
    click(confirm, task);
    await waitFor(
      () => {
        assertProfile(message);
        const current = profileControls(account);
        const button = Array.from(
          current?.group.querySelectorAll(
            `[data-testid="${account.id}-unblock"],[data-testid="unblock"]`,
          ) || [],
        ).find(visible);
        if (blockedButton(button)) return true;
        const notices = Array.from(
          document.querySelectorAll('[role="alert"],[data-testid="toast"]'),
        ).filter(visible);
        return notices.some((el) => {
          const text = normalize(el.textContent);
          return (
            targetsUsername(text, account.username) &&
            /a ete bloque|has been blocked|you blocked/.test(text)
          );
        });
      },
      task,
      12000,
    );
    await verifySession(message, task);
    return "blocked";
  }
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id === api.runtime.id && message?.type === "abort") {
      if (
        running &&
        running.jobId === message.jobId &&
        running.attempt === message.attempt
      ) {
        const task = running;
        running = null;
        task.controller.abort();
      }
      respond({ aborted: !running });
      return;
    }
    if (sender.id === api.runtime.id && message?.type === "probe") {
      respond({ owner: owner(), url: location.href });
      return;
    }
    if (
      sender.id !== api.runtime.id ||
      !["inspect", "block", "navigate"].includes(message?.type)
    )
      return;
    if (running) {
      respond({
        accepted:
          running.jobId === message.jobId &&
          running.attempt === message.attempt &&
          running.type === message.type,
      });
      return;
    }
    const task = {
      jobId: message.jobId,
      attempt: message.attempt,
      type: message.type,
      controller: new AbortController(),
      deadline: Date.now() + 18000,
    };
    running = task;
    respond({ accepted: true });
    (async () => {
      if (message.type === "navigate") {
        let type = "ready";
        try {
          if (!/^[A-Za-z0-9_]{1,15}$/.test(message.account?.username))
            throw Error("Profil incorrect.");
          if (owner()?.toLowerCase() !== message.owner?.toLowerCase())
            throw Error("Session différente.");
          const path = "/" + message.account.username;
          const changed =
            location.pathname.toLowerCase() !== path.toLowerCase();
          const previousEmpty = find('[data-testid="emptyState"]');
          if (changed) {
            // Le routeur de X réutilise la page, la session et les scripts chargés.
            history.pushState(null, "", path);
            window.dispatchEvent(
              new PopStateEvent("popstate", { state: null }),
            );
          }
          await waitFor(
            () => {
              const name = find('[data-testid="UserName"]');
              const empty = find('[data-testid="emptyState"]');
              return (
                location.pathname.toLowerCase() === path.toLowerCase() &&
                ((empty && (!changed || empty !== previousEmpty)) ||
                  (name &&
                    targetsUsername(
                      name.textContent,
                      message.account.username,
                    )))
              );
            },
            task,
            10000,
          );
        } catch (error) {
          type = "navigateFailed";
          message.code = error.code;
          message.error = error.message;
        } finally {
          if (running === task) running = null;
        }
        if (task.controller.signal.aborted) return;
        await api.runtime
          .sendMessage({
            type,
            jobId: message.jobId,
            attempt: message.attempt,
            url: location.href,
            code: message.code,
            error: message.error,
          })
          .catch(() => {});
        return;
      }
      const result = {
        jobId: message.jobId,
        attempt: message.attempt,
        type: message.type === "inspect" ? "sessionResult" : "blockResult",
      };
      try {
        if (message.type === "inspect") {
          result.owner = await waitFor(owner, task);
          result.ownerKey = await ownerKey(result.owner);
          assertActive(task);
        } else {
          const outcome = await block(message, task);
          Object.assign(
            result,
            typeof outcome === "string" ? { outcome } : outcome,
          );
        }
      } catch (error) {
        result.outcome = "error";
        result.error = error.message;
        result.code = error.code || "interface";
      } finally {
        if (running === task) running = null;
      }
      if (task.controller.signal.aborted) return;
      await api.runtime.sendMessage(result).catch(() => {});
    })();
  });
  api.runtime
    .sendMessage({ type: "ready", url: location.href })
    .catch(() => {});
})();
