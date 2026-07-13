/**
 * A moldura: os três pontos fixos da página que toda view escreve.
 *
 * `view` é onde a tela é montada, `crumbs` é a trilha do topo e `tally` é a contagem
 * à direita. Ficam aqui porque são do *shell*, não de nenhuma view — quem for pendurar
 * estado de conexão ou botão de refresh no cabeçalho pendura nesta costura.
 */
export const view = document.getElementById('view')
export const crumbs = document.getElementById('crumbs')
export const tally = document.getElementById('tally')
