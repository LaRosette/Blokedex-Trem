export const accounts = [
  { id: "11", username: "CompteTest_A" },
  { id: "12", username: "CompteTest_B" },
  { id: "13", username: "CompteTest_C" },
];
export const addedAccount = { id: "14", username: "CompteTest_D" };
const profileAccounts = [...accounts, addedAccount];

export const fixtureOwners = {
  CompteDeTest: "1234567890",
  AutreCompte: "9876543210",
  CompteSansCache: "1122334455",
};

export function releaseFixturesFor(currentVersion) {
  const next = currentVersion.split(".").map(Number);
  for (let index = next.length - 1; index >= 0; index--) {
    if (next[index] < 65535) {
      next[index]++;
      const version = next.join(".");
      return {
        current: { schemaVersion: 1, version: currentVersion },
        available: { schemaVersion: 1, version },
        injected: {
          schemaVersion: 1,
          version:
            version +
            '"><img src=x onerror="globalThis.__releaseInjection=true">',
          url: "javascript:globalThis.__releaseInjection=true",
        },
      };
    }
    next[index] = 0;
  }
  throw Error("Le manifeste utilise déjà la version maximale autorisée.");
}

function profileMarkup(handle, options) {
  const account = profileAccounts.find((a) => a.username === handle);
  if (!account)
    return '<main data-testid="primaryColumn">Accueil de test</main>';
  if (handle === "CompteTest_C")
    return '<main data-testid="primaryColumn"><div data-testid="emptyState">Ce compte n’existe pas</div></main>';
  const id = options.profileIds?.[handle] || account.id;
  const genericUnblock = options.genericUnblockHandles?.includes(handle);
  const already =
    genericUnblock ||
    handle === "CompteTest_B" ||
    options.blocked?.includes(handle);
  const articleId = options.articleFollowIds?.[handle];
  const headerUsername = options.headerUsernames?.[handle] || handle;
  const menuUsername = options.menuUsernames?.[handle] || handle;
  const dialogUsername = options.dialogUsernames?.[handle] || handle;
  return `<main data-testid="primaryColumn">
    <div data-testid="UserName">Compte de test @${headerUsername}</div>
    <div data-testid="profileActions">
      <button id="state" data-testid="${genericUnblock ? "unblock" : `${id}-${already ? "unblock" : "follow"}`}">${already ? "Bloqué" : "Suivre"}</button>
      <button id="more" data-testid="userActions">Plus</button>
    </div>
    <div id="menu" role="menu" hidden><button id="action" role="menuitem" data-testid="block">${already ? "Débloquer" : "Bloquer"} @${menuUsername}</button></div>
    <div id="dialog" role="alertdialog" hidden>Bloquer @${dialogUsername} ?<button id="confirm" data-testid="confirmationSheetConfirm">Bloquer</button></div>
    ${handle === "CompteTest_A" ? '<div data-testid="emptyState">Aucun post pour le moment.</div>' : ""}
    ${articleId ? `<article><div data-testid="UserCell"><button data-testid="${articleId}-follow">Suivre une suggestion</button></div></article>` : ""}
  </main>`;
}

export function sitePage(url, owner = "CompteDeTest", options = {}) {
  const avatarOrigin = options.avatarOrigin || "https://pbs.twimg.com";
  const avatarId = fixtureOwners[owner] || "1122334455";
  const avatar = `${avatarOrigin}/profile_images/${avatarId}/${owner}_normal.png`;
  const pages = Object.fromEntries(
    ["home", ...profileAccounts.map((a) => a.username)].map((handle) => [
      "/" + handle,
      profileMarkup(handle, options),
    ]),
  );
  const handle = new URL(url).pathname.slice(1);
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <nav>
      <a href="/${owner}" data-testid="AppTabBar_Profile_Link">Profil</a>
      <button data-testid="SideNav_AccountSwitcher_Button"><img width="32" height="32" src="${avatar}" alt="Compte connecté"></button>
    </nav>
    ${profileMarkup(handle, options)}
    <script>
      const pages = ${JSON.stringify(pages).replaceAll("<", "\\u003c")};
      const accounts = ${JSON.stringify(profileAccounts)};
      const owner = ${JSON.stringify(owner)};
      const options = ${JSON.stringify(options).replaceAll("<", "\\u003c")};
      function wire() {
        const handle = location.pathname.slice(1);
        const account = accounts.find(a => a.username === handle);
        const more = document.getElementById('more');
        if (!more) return;
        more.onclick = () => document.getElementById('menu').hidden = false;
        document.getElementById('action').onclick = async () => {
          document.getElementById('menu').hidden = true;
          if (options.holdDialogHandles?.includes(handle))
            await fetch('/__test__/dialog?username=' + handle + '&owner=' + owner);
          if (options.confirmationIds?.[handle])
            document.getElementById('state').dataset.testid = options.confirmationIds[handle] + '-follow';
          document.getElementById('dialog').hidden = false;
          if (options.holdDialogHandles?.includes(handle)) {
            const ownerLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
            if (options.holdOwnerAfterDialog) ownerLink.hidden = true;
            await fetch('/__test__/shown?username=' + handle + '&owner=' + owner);
            if (options.holdOwnerAfterDialog) {
              await fetch('/__test__/owner?owner=' + owner);
              ownerLink.hidden = false;
            }
          }
        };
        document.getElementById('confirm').onclick = async () => {
          document.getElementById('dialog').hidden = true;
          await fetch('/__test__/blocked?username=' + handle + '&owner=' + owner);
          const state = document.getElementById('state');
          state.dataset.testid = account.id + '-unblock'; state.textContent = 'Bloqué';
        };
      }
      addEventListener('popstate', () => {
        const html = pages[location.pathname];
        if (!html) return;
        const next = new DOMParser().parseFromString(html, 'text/html');
        document.querySelector('main').replaceWith(next.querySelector('main'));
        wire();
      });
      wire();
    </script>
  </body></html>`;
}
