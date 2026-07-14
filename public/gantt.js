/**
 * O desenho do Gantt: **HTML posicionado para rótulos e barras, SVG só para as setas** —
 * a mesma divisão do grafo, pelas mesmas razões (foco por teclado, clique que abre a
 * gaveta, texto que não precisa ser reimplementado em SVG).
 *
 * A geometria não é decidida aqui — ela vem inteira do `gantt-layout.js`, que é puro e
 * testado. O que é daqui: o "hoje" (o relógio é de quem desenha), os tooltips e o clique.
 */
import { el, esc, svg, pressable } from './dom.js'
import { cleanTitle, numberIndex } from './issues.js'
import { ganttLayout, arrowPath, BAR_H, LABEL_W } from './gantt-layout.js'
import { edgeDefs, edgeEl } from './edges.js'
import { openIssue } from './drawer.js'

/** `2026-07-12` → `12/07` — fatiado da string, sem fuso para errar. */
const ddmm = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}`

/**
 * O que a barra responde ao hover: as bordas, cada uma com a sua natureza. O `≥` do piso
 * não é enfeite — é a barra admitindo que o início é um limite, não um fato.
 */
function barTitle(bar) {
  const { issue } = bar
  const inicio = issue.created ? `${bar.floor ? '≥ ' : ''}${ddmm(issue.created.day)}` : '?'
  const fim = issue.closed ? ddmm(issue.touched) : 'hoje'
  return `${inicio} → ${fim} · ${issue.status}`
}

export function renderGantt(effort, archived) {
  const wrap = el('<div class="gantt"></div>')
  if (!effort.issues.length) {
    wrap.append(el('<p class="empty">Esforço sem issues — não há linha do tempo a desenhar.</p>'))
    return wrap
  }

  const byNumber = numberIndex(effort.issues)
  // O dia de quem olha, no vocabulário do payload (dia UTC, como o `touched`): é ele que
  // estica as barras abertas. O servidor não manda "hoje" — hoje envelhece, e payload que
  // envelhece sozinho é o polling ressuscitado.
  const today = new Date().toISOString().slice(0, 10)
  const { bars, arrows, ticks, todayX, width, height } = ganttLayout(effort.issues, byNumber, today)

  const canvas = el(`<div class="gantt-canvas" style="width:${width}px; height:${height}px"></div>`)

  for (const t of ticks) {
    if (t.x === todayX) continue // a linha de "hoje" já marca este dia; dois rótulos se atropelam
    canvas.append(
      el(`<div class="gtick" style="left:${t.x}px; height:${height}px"><span>${ddmm(t.day)}</span></div>`),
    )
  }
  if (todayX !== null) {
    canvas.append(el(`<div class="gtick is-today" style="left:${todayX}px; height:${height}px"><span>hoje</span></div>`))
  }

  for (const bar of bars) {
    const { issue } = bar
    const label = el(`
      <div class="glabel ${issue.closed ? 'is-closed' : ''}" style="top:${bar.y}px; width:${LABEL_W}px; height:${BAR_H}px"
           tabindex="0" role="button">
        <b>${esc(issue.number)}</b><span>${esc(cleanTitle(issue))}</span>
      </div>
    `)
    const rect = el(`
      <div class="gbar ${issue.closed ? 'is-closed' : ''} ${bar.open ? 'is-open' : ''} ${bar.floor ? 'is-floor' : ''} ${issue.blocked ? 'is-blocked' : ''}"
           style="left:${bar.x}px; top:${bar.y}px; width:${bar.w}px; height:${BAR_H}px"
           title="${esc(barTitle(bar))}"></div>
    `)
    pressable(label, () => openIssue(issue, effort, archived))
    pressable(rect, () => openIssue(issue, effort, archived))
    canvas.append(label, rect)
  }

  // As setas do `Blocked by:` — a maquinaria compartilhada com o grafo (`edges.js`):
  // marcadores em `svg()` e a prosa do bloqueio no `<title>` do traço.
  const edges = svg('svg', { class: 'gantt-edges', width, height })
  edges.append(edgeDefs('gantt'))
  for (const a of arrows) edges.append(edgeEl('gantt', { ...a, d: arrowPath(a) }))
  canvas.append(edges)
  wrap.append(canvas)

  // A limitação da fatia 1 é visível e assumida: sem o catálogo, todo início é o mesmo
  // piso e as barras saem em leque. A nota diz o que a borda aberta significa, para o
  // desenho honesto não parecer um bug.
  if (bars.some((b) => b.floor)) {
    wrap.append(
      el('<p class="viewnote">Borda esquerda aberta = início incerto: o disco só garante que o ticket não é mais velho que o esforço.</p>'),
    )
  }
  return wrap
}
