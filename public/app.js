/**
 * O ponto de entrada — e só isso.
 *
 * Monta a moldura, liga o hash ao roteador e é o **controlador do painel direito**: acha
 * o nó da rota atual varrendo `state.boards[ns].tree` e chama quem sabe desenhá-lo — o
 * grafo para `type:'dir'`, o viewer para `type:'file'`.
 */
import { renderShell, paneLeft, paneRight } from './shell.js'
import { route, activeNs, activeRel, connect } from './router.js'
import { state } from './state.js'
import { renderTree } from './tree.js'
import { showFile } from './viewer.js'
import { showFolder } from './graph.js'

function findNode(nodes, rel) {
  for (const node of nodes) {
    if (node.rel === rel) return node
    if (node.type === 'dir') {
      const hit = findNode(node.children, rel)
      if (hit) return hit
    }
  }
  return null
}

function render() {
  route()
  const ns = activeNs()
  const board = ns ? state.boards[ns] : null
  if (!board) return

  const rel = activeRel()
  const node = rel ? findNode(board.tree, rel) : { type: 'dir', name: ns, path: board.root, ref: board.ref, rel: '' }

  renderTree(paneLeft, ns, board, node?.path ?? null)
  if (!node) return
  node.type === 'dir' ? showFolder(paneRight, ns, node) : showFile(paneRight, ns, node)
}

renderShell()

addEventListener('hashchange', render)
addEventListener('board:push', (ev) => {
  if (ev.detail.ns === activeNs()) render()
})

connect()
render()
