/**
 * O desenho do grafo: **HTML posicionado para os nós, SVG só para as curvas**.
 *
 * Assim o chip de status, o foco por teclado e o clique que abre a gaveta são os
 * mesmos da lista, sem reimplementar texto em SVG. A geometria não é decidida aqui —
 * ela vem inteira do `graph-layout.js`, que é puro e testado.
 */
import { el, esc, svg, pressable } from './dom.js'
import { cleanTitle, numberIndex, depsOf } from './issues.js'
import { graphLayout, edgePath, NODE_W, NODE_H } from './graph-layout.js'
import { edgeDefs, edgeEl } from './edges.js'
import { openIssue } from './drawer.js'

function graphNode(issue, effort, archived, at) {
  const title = cleanTitle(issue)
  const node = el(`
    <article class="gnode ${issue.closed ? 'is-closed' : ''} ${issue.blocked ? 'is-blocked' : ''}"
             style="left:${at.x}px; top:${at.y}px; width:${NODE_W}px; height:${NODE_H}px"
             tabindex="0" role="button">
      <div class="gnode-title"><b>${esc(issue.number)}</b><span>${esc(title)}</span></div>
      <span class="chip" data-s="${esc(issue.status)}">${esc(issue.status)}</span>
    </article>
  `)
  return pressable(node, () => openIssue(issue, effort, archived))
}

/**
 * O grafo mostra as issues fechadas junto das abertas: é a história de como se chegou
 * na frontier, e sem ela uma issue destravada apareceria solta, sem explicar o que a
 * soltou. Elas entram esmaecidas, e a aresta que já foi cumprida entra tracejada — o
 * que ainda segura alguém é o que fica sólido e vermelho.
 */
export function renderGraph(effort, archived) {
  const wrap = el('<div class="graph"></div>')
  if (!effort.issues.length) {
    wrap.append(el('<p class="empty">Esforço sem issues — não há dependência a desenhar.</p>'))
    return wrap
  }

  const byNumber = numberIndex(effort.issues)
  const { at, width, height } = graphLayout(effort.issues, byNumber)

  const canvas = el(`<div class="graph-canvas" style="width:${width}px; height:${height}px"></div>`)
  const edges = svg('svg', { class: 'graph-edges', width, height })

  // Os marcadores e o traço com tooltip são a maquinaria compartilhada com o Gantt — e são
  // `svg()` por dentro, porque um `<marker>` montado pelo `el()` some sem erro nenhum.
  edges.append(edgeDefs('graph'))

  let drawn = 0
  for (const issue of effort.issues) {
    for (const { dep, note, raw } of depsOf(issue, byNumber)) {
      edges.append(
        edgeEl('graph', {
          d: edgePath(at(dep), at(issue)),
          blocking: !dep.closed,
          from: dep,
          to: issue,
          note,
          raw,
        }),
      )
      drawn++
    }
  }

  canvas.append(edges)
  for (const issue of effort.issues) canvas.append(graphNode(issue, effort, archived, at(issue)))
  wrap.append(canvas)

  if (!drawn) {
    wrap.prepend(
      el('<p class="viewnote">Nenhuma issue deste esforço declara <code>Blocked by:</code> — o grafo é uma coluna só.</p>'),
    )
  }
  return wrap
}
