/**
 * Os boards que o cliente tem na mão — **um por origem**, e o último payload de cada um.
 *
 * `namespaces` é a ordem em que as origens aparecem (a de casa primeiro), e `boards` guarda
 * o board de cada uma pelo nome. O cliente carrega **todas** as origens, não só a que está
 * na tela: é o que permite a uma origem inativa receber o push, atualizar o seu estado sem
 * redesenhar a origem ativa, e já estar pronta quando você troca de aba.
 *
 * É *um* objeto mutável e não um `let` exportado de propósito: um binding exportado é uma
 * cópia viva só para quem importa o módulo, e reatribuí-lo do roteador não chegaria em quem
 * já leu. Com o contêiner, todo mundo vê a mesma referência.
 *
 * É daqui que as views leem `root`, `columns`, `efforts` e `archived` — sempre da origem que
 * estão desenhando, nunca de "o board".
 */
export const state = { namespaces: [], boards: {} }

/** O board de uma origem, ou `null` se ela não existe (hash colado à mão, mount removido). */
export const boardOf = (ns) => state.boards[ns] ?? null
