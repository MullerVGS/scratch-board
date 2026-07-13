/**
 * O desenho do grafo: **HTML posicionado para os nós, SVG só para as curvas**.
 *
 * Assim o chip de status, o foco por teclado e o clique que abre a gaveta são os
 * mesmos da lista, sem reimplementar texto em SVG. A geometria não é decidida aqui —
 * ela vem inteira do `graph-layout.js`, que é puro e testado.
 */
import { el, esc, svg } from './dom.js'
import { cleanTitle, numberIndex, depsOf } from './issues.js'
import { graphLayout, edgePath, NODE_W, NODE_H } from './graph-layout.js'
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
  node.onclick = () => openIssue(issue, effort, archived)
  node.onkeydown = (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      openIssue(issue, effort, archived)
    }
  }
  return node
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

  // Um marcador por classe de aresta. `el()` monta HTML, e um `<defs>` construído ali
  // não estaria no namespace SVG — o navegador o aceitaria e o ignoraria, e as setas
  // sumiriam sem erro nenhum. Daí o `svg()` em cada nó.
  const defs = svg('defs', {})
  for (const kind of ['blocking', 'satisfied']) {
    const marker = svg('marker', {
      id: `arrow-${kind}`,
      viewBox: '0 0 8 8',
      refX: 7,
      refY: 4,
      markerWidth: 6,
      markerHeight: 6,
      orient: 'auto-start-reverse',
    })
    marker.append(svg('path', { d: 'M 0 0 L 8 4 L 0 8 z', class: `arrow ${kind}` }))
    defs.append(marker)
  }
  edges.append(defs)

  let drawn = 0
  for (const issue of effort.issues) {
    for (const { dep, note, raw } of depsOf(issue, byNumber)) {
      const blocking = !dep.closed
      const path = svg('path', {
        class: `gedge ${blocking ? 'blocking' : 'satisfied'}`,
        d: edgePath(at(dep), at(issue)),
        'marker-end': `url(#arrow-${blocking ? 'blocking' : 'satisfied'})`,
      })
      // A prosa depois do número é a justificativa do bloqueio — o hover devolve ela.
      const tip = svg('title', {})
      tip.textContent = note ? `${dep.number} → ${issue.number}: ${note}` : `${dep.number} → ${issue.number}`
      path.append(tip)
      path.setAttribute('data-raw', raw)
      edges.append(path)
      drawn++
    }
  }

  canvas.append(edges)
  for (const issue of effort.issues) canvas.append(graphNode(issue, effort, archived, at(issue)))
  wrap.append(canvas)

  if (!drawn) {
    wrap.prepend(
      el('<p class="graph-note">Nenhuma issue deste esforço declara <code>Blocked by:</code> — o grafo é uma coluna só.</p>'),
    )
  }
  return wrap
}
