/**
 * O grafo de uma pasta — o painel direito (`#pane-right`) quando o alvo é um
 * `type:'dir'`.
 *
 * STUB (tarefa 03): só prova que o controlador do painel direito (`app.js`) chama quem
 * deve. Uma tarefa seguinte substitui este corpo pelo desenho real, sobre `/api/graph` e
 * `graph-layout.js` (que já existe, puro, e continua intacto para essa tarefa reusar).
 *
 * A assinatura é o contrato: `showFolder(container, ns, node)`.
 */
import { el, esc } from './dom.js'

export function showFolder(container, ns, node) {
  container.replaceChildren(el(`<div class="stub">pasta: ${esc(node?.ref ?? '')}</div>`))
}
