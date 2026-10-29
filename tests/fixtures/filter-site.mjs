export const filterAccounts = [
  { id: "11", username: "CompteTest_A" },
  { id: "12", username: "CompteTest_B" },
];
export function tweet(
  id,
  author,
  body = "Une publication de démonstration.",
  extra = "",
) {
  return `<div data-testid="cellInnerDiv" id="cell-${id}"><article data-testid="tweet" id="${id}" role="article"><div data-testid="User-Name"><a href="/${author}">Nom de démonstration</a><a href="/${author}"><span>@${author}</span></a><a href="/${author}/status/123"><time>1 h</time></a></div><div data-testid="tweetText">${body}</div>${extra}<button data-testid="like" onclick="document.body.dataset.likes=String(Number(document.body.dataset.likes||0)+1)">J’aime</button></article></div>`;
}
export function filterPage() {
  const quote =
    '<div id="quote-card" role="link" tabindex="0"><div data-testid="User-Name"><span>Auteur cité</span><span>@CompteTest_B</span><span>2 h</span></div><div data-testid="tweetText">Une citation native sans lien de profil.</div></div>';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Fil de démonstration</title><style>body{margin:0;background:#f7f6f1;font:15px system-ui;color:#173e35}main{width:540px;max-width:100%;margin:auto}header{padding:24px}article{padding:22px;background:white;border-bottom:1px solid #deded8}a{color:#375d52}button{margin-top:14px}#timeline{min-height:200px}</style></head><body data-likes="0"><nav><a href="/CompteTest_A" id="own-profile">Mon profil</a></nav><main data-testid="primaryColumn"><header><h1>Votre fil de démonstration</h1><p>Profils fictifs · aucune interaction avec X</p></header><section id="timeline">
    ${tweet("target", "CompteTest_A")}
    ${tweet("safe", "AuteurVisible", "Cette publication reste visible.")}
    ${tweet("mention", "AutreAuteur", 'Une simple mention <a href="/CompteTest_A">@CompteTest_A</a> reste visible.')}
    ${tweet("prefix", "CompteTest_ABC", "Un pseudo plus long reste visible.")}
    ${tweet("quote", "AuteurCitation", "Une publication avec une citation ciblée.", quote)}
    ${tweet("repost", "CompteTest_B", "Une publication repartagée, auteur original ciblé.", '<div data-testid="socialContext"><a href="/ReposteurVisible">Reposté</a></div>')}
    ${tweet("ambiguous", "CompteTest_A").replace('</div><div data-testid="tweetText">', '<a href="/AuteurDifferent">@AuteurDifferent</a></div><div data-testid="tweetText">')}
    ${tweet("foreign", "AuteurEtranger").replaceAll("/AuteurEtranger", "https://example.invalid/CompteTest_A")}
    ${tweet("reply", "AuteurReponse", '<div>En réponse à <a href="/CompteTest_A">@CompteTest_A</a></div>Un autre auteur.')}
  </section></main></body></html>`;
}
