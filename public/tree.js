/**
 * A árvore de arquivos de uma origem — o painel esquerdo (`#pane-left`).
 *
 * `renderTree(container, ns, board, selectedPath)` é o contrato (tarefa 03): recebe o board
 * inteiro (já ordenado por `mtime` desc pelo servidor — `filter`/`map` preservam essa ordem,
 * **nunca se reordena aqui**) e o `path` (vocabulário do container) do nó selecionado, e
 * desenha pastas expansíveis e arquivos com selo, cópia e destaque de seleção.
 *
 * **Dois pedaços de estado sobrevivem a um redesenho** — porque a árvore inteira é
 * redesenhada a cada `board:push` da origem ativa, e um save da IA não pode fechar as
 * pastas nem jogar a rolagem para o topo:
 *
 *   - `expanded` — o `Set` de módulo com os `path` das pastas abertas. Não é preferência
 *     (não é `localStorage`): é estado de sessão, do mesmo jeito que a largura da gaveta
 *     antiga era preferência e a rolagem dela era estado — aqui os dois papéis, expansão e
 *     rolagem, são estado.
 *   - `container.scrollTop` — salvo antes de `replaceChildren`, restaurado depois.
 *
 * Clicar no **nome** de uma pasta ou de um arquivo seleciona (rotea para `#/<ns>/<rel>`); o
 * triângulo só abre/fecha, e nunca navega. `pressable()` (`dom.js`) dá a cada nome o
 * contrato de clique/Enter/espaço que `role="button"` promete.
 */
import { el, esc, copyBtn, pressable, statusChip } from './dom.js'

/** O que a árvore está mostrando agora — para que os handlers (triângulo, `relabel`) redesenhem sem precisar que `app.js` chame `renderTree` de novo. */
const state = { container: null, ns: null, board: null, selectedPath: null }

/** Os `path` das pastas abertas. De módulo, não de `localStorage`: some no reload, e é isso que se quer — é sessão, não preferência. */
const expanded = new Set()

/**
 * O relativo ("há 2h"), calculado no cliente a partir do `mtime` absoluto — nunca vindo do
 * servidor (uma string relativa envelheceria sozinha e empurraria o board parado). Desce de
 * unidade conforme o intervalo: dias, senão horas, senão minutos — dias em dígito plural.
 */
function ago(mtime, now = Date.now()) {
  const ms = Math.max(0, now - mtime)
  if (ms < 60_000) return 'agora'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `há ${min}min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h}h`
  const d = Math.floor(h / 24)
  return `há ${d} ${d === 1 ? 'dia' : 'dias'}`
}

/**
 * Re-rotula os relativos já desenhados, sem tocar em mais nada — nem rede, nem re-render da
 * árvore. É o único efeito do `setInterval` de 60s: o `mtime` de cada nó já está no `data-*`
 * do próprio elemento, então não há o que reconstruir, só o texto a trocar.
 */
function relabel() {
  if (!state.container) return
  for (const span of state.container.querySelectorAll('.age[data-mtime]')) {
    span.textContent = ago(Number(span.dataset.mtime))
  }
}
setInterval(relabel, 60_000)

/** `#/<ns>/<rel>` — a única forma de navegar; `rel` é a chave de rota, nunca o `path` do container. */
const navigate = (ns, rel) => {
  location.hash = `#/${ns}/${rel}`
}

/** O carimbo de hora completo, para quem passar o mouse sobre o relativo. */
const fullDate = (mtime) => new Date(mtime).toLocaleString('pt-BR')

/**
 * O bloco final da linha: o relativo e os dois `copyBtn`. Os dois moram no **mesmo canto**
 * — os botões cobrem o relativo ao aparecer, em vez de abrir espaço próprio ao lado dele —
 * porque a árvore é estreita e fica funda: uma pasta a três níveis já soma triângulo, selo
 * e nome disputando uma coluna de ~300px, e reservar mais ~50px fixos para os botões
 * (presentes mesmo invisíveis, porque `opacity` — nunca `display:none` — é o que os mantém
 * alcançáveis por teclado) era o suficiente para zerar o nome inteiro. `.meta` mede pelo
 * relativo (o que sempre está lá); `.copies` empilha por cima, `position: absolute`, e só
 * assim não conta no layout enquanto invisível.
 */
function metaEl(node) {
  const meta = el('<span class="meta"></span>')
  const age = el(
    `<span class="age" data-mtime="${node.mtime}" title="${esc(fullDate(node.mtime))}">${esc(ago(node.mtime))}</span>`,
  )
  const copies = el('<span class="copies"></span>')
  copies.append(copyBtn(node.ref, 'caminho'), copyBtn(node.name, 'nome'))
  meta.append(age, copies)
  return meta
}

/**
 * A linha de uma **pasta**: triângulo (`▸`/`▾`), nome clicável, cópia do nome e do `ref`, e o
 * relativo. Pasta sem filho nenhum (existe: um diretório vazio no disco) não ganha triângulo
 * clicável — não há o que abrir.
 */
function dirRow(node, depth, ns, selectedPath) {
  const open = expanded.has(node.path)
  const selected = node.path === selectedPath
  const hasChildren = node.children.length > 0

  const row = el(`
    <div class="row dir${selected ? ' selected' : ''}" style="--depth:${depth}">
      ${
        hasChildren
          ? `<button type="button" class="disclosure" aria-expanded="${open}"
               aria-label="${open ? 'Recolher' : 'Expandir'} ${esc(node.name)}">${open ? '▾' : '▸'}</button>`
          : `<span class="disclosure ghost" aria-hidden="true"></span>`
      }
      <span class="name" role="button" tabindex="0" title="${esc(node.name)}">${esc(node.name)}</span>
    </div>
  `)

  if (hasChildren) {
    row.querySelector('.disclosure').onclick = (ev) => {
      ev.stopPropagation()
      expanded.has(node.path) ? expanded.delete(node.path) : expanded.add(node.path)
      redraw()
    }
  }

  pressable(row.querySelector('.name'), () => navigate(ns, node.rel))
  row.append(metaEl(node))

  return row
}

/**
 * A linha de um **arquivo**: nome, o título esmaecido quando o `.md` tem um, o selo de
 * `status` quando houver, cópia do nome e do `ref`, e o relativo.
 */
function fileRow(node, depth, ns, selectedPath) {
  const selected = node.path === selectedPath

  const row = el(`
    <div class="row file${selected ? ' selected' : ''}" style="--depth:${depth}">
      <span class="disclosure ghost" aria-hidden="true"></span>
      <span class="name" role="button" tabindex="0" title="${esc(node.name)}">${esc(node.name)}</span>
      ${node.title ? `<span class="title" title="${esc(node.title)}">${esc(node.title)}</span>` : ''}
    </div>
  `)

  pressable(row.querySelector('.name'), () => navigate(ns, node.rel))

  if (node.status) row.querySelector('.name').after(statusChip(node.status))

  row.append(metaEl(node))

  return row
}

/**
 * Um nó — arquivo (uma linha) ou pasta (a linha mais, se aberta, um `.children` com os
 * filhos recursivos). Os filhos só entram no DOM quando a pasta está em `expanded`: uma
 * pasta fechada não paga o custo de montar o que não se vê, e — mais importante — não some
 * do `Set` só porque não está desenhada agora.
 */
function nodeEl(node, depth, ns, selectedPath) {
  if (node.type === 'file') return fileRow(node, depth, ns, selectedPath)

  const branch = el('<div class="branch"></div>')
  branch.append(dirRow(node, depth, ns, selectedPath))
  if (expanded.has(node.path) && node.children.length) {
    const kids = el('<div class="children"></div>')
    kids.append(...node.children.map((c) => nodeEl(c, depth + 1, ns, selectedPath)))
    branch.append(kids)
  }
  return branch
}

/**
 * Garante que o caminho até `selectedPath` esteja aberto — sem isso, uma seleção que chega
 * por rota direta (carga a frio, link colado) apareceria "selecionada" dentro de uma pasta
 * fechada, invisível. Mutação no `Set` de módulo: uma vez aberta para mostrar a seleção, a
 * pasta continua aberta como qualquer outra — é o comportamento comum de expansão.
 */
function ensureVisible(nodes, selectedPath) {
  if (!selectedPath) return
  for (const node of nodes) {
    if (node.type !== 'dir') continue
    if (selectedPath === node.path || selectedPath.startsWith(node.path + '/')) {
      expanded.add(node.path)
      ensureVisible(node.children, selectedPath)
    }
  }
}

/**
 * Redesenha a partir do estado guardado em `state` — chamada tanto por `renderTree()` quanto
 * pelo clique no triângulo, que não recebe board novo nenhum e precisa só re-mostrar a mesma
 * árvore com um `path` a mais ou a menos em `expanded`.
 *
 * **Não chama `ensureVisible` aqui.** Essa garantia é de `renderTree()`, quando uma seleção
 * *nova* chega — rodá-la a cada `redraw()` reabriria, no mesmo instante, a pasta que o
 * clique no triângulo acabou de fechar: `selectedPath` não muda num toggle manual, então
 * `ensureVisible` a reencontraria como ancestral da seleção e a devolveria a `expanded` antes
 * do próximo frame — o colapso nunca chegaria a se ver. `renderTree()` é o único ponto que
 * sabe distinguir "a seleção mudou" de "só o `Set` mudou".
 *
 * A rolagem é salva **antes** de `replaceChildren` e restaurada **depois**: sem isso, toda
 * vez que a árvore reordena (um save legítimo) ou uma pasta abre, `#pane-left` voltaria ao
 * topo — a mesma armadilha que a gaveta antiga já pagou uma vez com o `scrollTop` do corpo.
 */
function redraw() {
  const { container, ns, board, selectedPath } = state
  if (!container) return
  const savedScroll = container.scrollTop

  if (board.error) {
    container.replaceChildren(
      el(`<div class="empty bad"><strong>Falha ao ler esta origem</strong>${esc(board.error)}</div>`),
    )
  } else if (!board.tree.length) {
    container.replaceChildren(el('<div class="empty">sem arquivos</div>'))
  } else {
    const tree = el('<div class="tree"></div>')
    tree.append(...board.tree.map((n) => nodeEl(n, 0, ns, selectedPath)))
    container.replaceChildren(tree)
  }

  container.scrollTop = savedScroll
}

export function renderTree(container, ns, board, selectedPath) {
  state.container = container
  state.ns = ns
  state.board = board
  state.selectedPath = selectedPath
  if (board.tree?.length) ensureVisible(board.tree, selectedPath)
  redraw()
}
