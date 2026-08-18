/**
 * A árvore de arquivos de uma origem — o painel esquerdo (`#pane-left`).
 *
 * STUB (tarefa 03): só prova que o fio chega até aqui. `renderTree()` recebe o board
 * inteiro e o `path` selecionado, mas ainda não desenha a árvore de verdade — a tarefa
 * seguinte substitui este corpo pelo desenho real (pastas, arquivos, seleção, contagem).
 *
 * A assinatura é o contrato: `renderTree(container, ns, board, selectedPath)`.
 * `selectedPath` é o `path` (vocabulário do container) do nó atualmente aberto, para
 * quem for desenhar o realce de seleção — nunca o `ref` nem o `rel`, que são os
 * vocabulários que a UI e a rota usam.
 */
import { el, esc } from './dom.js'

export function renderTree(container, ns, board, selectedPath) {
  container.replaceChildren(
    el(`<div class="stub">árvore: ${esc(ns)}${selectedPath ? ' · ' + esc(selectedPath) : ''}</div>`),
  )
}
