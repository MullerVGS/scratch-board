/**
 * O board que o cliente tem na mão — **um por origem**, e o último payload de cada um.
 *
 * `boards` guarda o board de cada origem pelo nome; `active` é a origem que está na
 * tela agora. As chaves de `boards` nascem do snapshot do SSE (`router.js`, `connect()`):
 * um `message` por origem, casa-primeiro — é dali que a fileira de abas se monta, sem
 * precisar de um endpoint que liste as origens.
 *
 * É *um* objeto mutável e não um `let` exportado de propósito: um binding exportado é
 * cópia viva só para quem já importou o módulo, e reatribuí-lo do roteador não chegaria
 * em quem já leu. Com o contêiner, todo mundo — `shell.js`, `router.js`, `app.js` — vê a
 * mesma referência.
 *
 * A tela redesenha **só se `ns === state.active`**: um board novo de uma origem inativa
 * fica guardado, calado, e só aparece quando você troca de aba.
 */
export const state = { boards: {}, active: null }
