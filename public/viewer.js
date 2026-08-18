/**
 * O visualizador de arquivo — o painel direito (`#pane-right`) quando o alvo é um
 * `type:'file'`.
 *
 * STUB (tarefa 03): só prova que o controlador do painel direito (`app.js`) chama quem
 * deve. Uma tarefa seguinte substitui este corpo por `/api/file` de verdade — texto cru
 * monoespaçado, ou `md.js` quando o alvo é `.md`.
 *
 * A assinatura é o contrato: `showFile(container, ns, node)`.
 */
import { el, esc } from './dom.js'

export function showFile(container, ns, node) {
  container.replaceChildren(el(`<div class="stub">arquivo: ${esc(node?.ref ?? '')}</div>`))
}
