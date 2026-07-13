/**
 * O board que o cliente tem na mão — o último payload de `/api/board`.
 *
 * Ele é *um* objeto mutável e não um `let` exportado de propósito: um binding
 * exportado é uma cópia viva só para quem importa o módulo, e reatribuí-lo do
 * roteador não chegaria em quem já leu. Com o contêiner, todo mundo vê a mesma
 * referência, e trocar o board é trocar `state.board`.
 *
 * É daqui que as views leem `root`, `columns`, `efforts` e `archived`.
 */
export const state = { board: null }
