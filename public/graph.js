/**
 * O grafo de uma pasta — o painel direito (`#pane-right`) quando o alvo da rota é um
 * `type:'dir'`.
 *
 * Busca `/api/graph?ns=&path=`, que decide sozinho o modo sobre a subárvore da pasta:
 * `deps` — o DAG do `Blocked by:` — quando algum `.md` o declara; `links` — quem cita quem por
 * link relativo — senão. O layout é puro (`graph-layout.js`, generalizado na tarefa 06 para
 * `nodes`+`edges` genéricos); aqui só o desenho, com a mesma separação do resto do cliente: **os
 * nós são HTML posicionado** (chip de status, foco por teclado, clique que abre o arquivo no
 * viewer) e **as curvas são SVG**, montadas com `svg()` — um `<marker>` construído por `el()`
 * nasceria fora do namespace SVG e sumiria sem erro nenhum.
 *
 * A assinatura é o contrato (tarefa 03): `showFolder(container, ns, node)`.
 */
import { el, esc, svg, pressable, api, statusChip } from './dom.js'
import { graphLayout, edgePath, NODE_W, NODE_H } from './graph-layout.js'
import { edgeDefs, edgeEl } from './edges.js'
import { isClosed } from '../shared/parse.js'

/**
 * Um nó: o nome do arquivo, o título quando o `.md` tem um (clampado a duas linhas — é por
 * isso que `NODE_H` é fixo, ele entra no cálculo das curvas), o selo de status. Clicar navega
 * para o arquivo no viewer — nunca no `path` do container, sempre no `rel`, a chave de rota.
 */
function graphNode(ns, n, closed, at) {
  const article = el(`
    <article class="gnode ${closed ? 'is-closed' : ''}"
             style="left:${at.x}px; top:${at.y}px; width:${NODE_W}px; height:${NODE_H}px"
             tabindex="0" role="button" title="${esc(n.ref)}">
      <div class="gnode-title"><b>${esc(n.name)}</b>${n.title ? `<span>${esc(n.title)}</span>` : ''}</div>
    </article>
  `)
  if (n.status) article.append(statusChip(n.status))
  return pressable(article, () => {
    location.hash = `#/${ns}/${n.rel}`
  })
}

/**
 * Desenha o grafo já resolvido (`{mode, nodes, edges}`) dentro de `container`.
 *
 * Pasta sem `.md` nenhum: nada a desenhar, e o estado vazio diz isso — nunca um grafo de
 * zero nós, que `graphLayout` nem sabe medir (`Math.max` de uma lista vazia é `-Infinity`).
 * Pasta com `.md` mas sem aresta nenhuma (soltas por si, ou toda aresta descartada por
 * referência morta/auto-referência): os nós aparecem soltos, com uma nota — nunca um desenho
 * fingido.
 */
function render(container, ns, node, data) {
  if (!data.nodes.length) {
    // Devolve o próprio nó vazio como `wrap`: é ele que fica no `container`, e é contra ele
    // que `onPush`/`showFolder` testam `isConnected` para saber se o painel ainda é nosso. Um
    // `null` aqui faria uma pasta sem `.md` nunca se atualizar ao vivo quando o primeiro
    // arquivo nascesse dentro dela — a checagem de posse acharia sempre "não sou dono".
    const empty = el(`<div class="empty">Pasta sem <code>.md</code> — nada para desenhar.</div>`)
    container.replaceChildren(empty)
    return empty
  }

  const wrap = el('<div class="graph"></div>')
  const { at, width, height } = graphLayout(data.nodes, data.edges)
  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  const closed = new Set(data.nodes.filter((n) => n.status && isClosed(n.status)).map((n) => n.id))

  const canvas = el(`<div class="graph-canvas" style="width:${width}px; height:${height}px"></div>`)
  const edgesSvg = svg('svg', { class: 'graph-edges', width, height })
  // Os marcadores e o traço com tooltip vêm do `edges.js` — `svg()` por dentro, porque um
  // `<marker>` montado pelo `el()` some sem erro nenhum.
  edgesSvg.append(edgeDefs('graph'))

  let drawn = 0
  for (const edge of data.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    // Referência morta (o servidor já filtra, mas o layout também guarda) ou auto-referência:
    // não há para onde apontar, ou não há dependência de um nó para si mesmo.
    if (!from || !to || from === to) continue
    edgesSvg.append(
      edgeEl('graph', {
        d: edgePath(at(from), at(to)),
        // deps: o que ainda segura alguém é sólido e vermelho; o que já foi cumprido (o
        // bloqueante fechou) vira história tracejada. links: uma citação não bloqueia
        // ninguém — sempre o traço neutro.
        blocking: data.mode === 'deps' && !closed.has(from.id),
        from: { number: from.name },
        to: { number: to.name },
        note: edge.note,
        raw: edge.note ?? '',
      }),
    )
    drawn++
  }

  canvas.append(edgesSvg)
  for (const n of data.nodes) canvas.append(graphNode(ns, n, closed.has(n.id), at(n)))
  wrap.append(canvas)

  if (!drawn) {
    const msg =
      data.mode === 'deps'
        ? 'Nenhum arquivo desta pasta declara Blocked by: — sem dependências.'
        : 'Nenhum arquivo desta pasta cita outro por link relativo — sem links.'
    wrap.prepend(el(`<p class="viewnote">${esc(msg)}</p>`))
  }

  container.replaceChildren(wrap)
  return wrap
}

/**
 * A sessão de leitura: o `#pane-right`, a origem e o nó de pasta da rota. `wrap` é o que
 * `render()` acabou de montar — guardado para o `onPush` saber se o painel ainda é nosso
 * (`wrap.isConnected`): uma pasta reaberta depois que o viewer tomou o painel não pode achar
 * que ainda está montada.
 */
let open = null

/**
 * Busca o grafo da pasta em `open` e desenha. `session` trava a identidade de `open` no
 * instante da chamada: se a rota mudar (outra pasta, ou o viewer) enquanto o fetch está em
 * voo, `open !== session` na volta e o resultado é descartado — sem isso, um fetch lento da
 * pasta antiga pintaria por cima da pasta nova.
 */
async function load() {
  const session = open
  const { container, ns, node } = session

  if (!session.wrap) container.replaceChildren(el('<div class="empty">carregando…</div>'))

  let data
  try {
    data = await api(`/api/graph?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(node.path)}`)
  } catch (err) {
    if (open !== session) return
    const bad = el(`<div class="empty bad">Falha ao montar o grafo: ${esc(err.message)}</div>`)
    container.replaceChildren(bad)
    // Registrado como `wrap` pela mesma razão do estado vazio: sem isso, o próximo
    // `board:push` desta origem — afete ou não esta pasta — sempre pareceria "não sou dono"
    // e `showFolder` tentaria de novo do zero a cada push, mesmo os que não têm nada a ver.
    session.wrap = bad
    return
  }
  if (open !== session) return

  session.wrap = render(container, ns, node, data)
}

/**
 * Liga o painel aos dois eventos do fio — **uma vez**. O `app.js` também chama `showFolder`
 * de novo a cada `board:push` da origem ativa, mas `showFolder` reconhece a mesma pasta e não
 * faz nada (só guarda o nó fresco) — é este ouvinte que decide se a mudança **afeta a pasta
 * aberta** e refaz o fetch. Sem essa distinção, toda escrita em qualquer lugar da origem
 * refaria o grafo de uma pasta que ela nem toca.
 *
 * `changed` vazio quer dizer "não sei o que mudou" (varredura de segurança, reconexão) — relê
 * no escuro, como o resto do cliente já faz. Uma lista não-vazia só afeta a pasta se algum
 * caminho estiver **sob** ela (o próprio `node.path`, ou algo dentro dele).
 */
let installed = false
function installLive() {
  if (installed) return
  installed = true

  const onPush = (ev) => {
    if (!open || ev.detail.ns !== open.ns || !open.wrap?.isConnected) return
    const changed = ev.detail.changed
    const under = (p) => p === open.node.path || p.startsWith(open.node.path + '/')
    if (changed?.length && !changed.some(under)) return
    load()
  }

  addEventListener('board:push', onPush)
  addEventListener('file:push', onPush)
}

/**
 * O contrato da tarefa 03. Chamada pelo `app.js`: numa pasta nova (ou a primeira vez, ou
 * depois que outra tela tomou o painel), busca e desenha do zero; na re-chamada com a **mesma**
 * pasta ainda montada — o caso de um `board:push` que o `app.js` propaga sem saber se afeta
 * esta pasta —, só atualiza o nó guardado e sai: o `onPush` acima é quem decide se há mesmo o
 * que refazer.
 */
export function showFolder(container, ns, node) {
  installLive()

  if (open && open.container === container && open.ns === ns && node.path === open.node.path && open.wrap?.isConnected) {
    open.node = node
    return
  }

  open = { container, ns, node, wrap: null }
  load()
}
