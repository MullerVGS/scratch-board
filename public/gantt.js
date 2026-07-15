/**
 * O desenho do Gantt: **HTML posicionado para rótulos e barras, SVG só para as setas** — a
 * mesma divisão do grafo, pelas mesmas razões (foco por teclado, clique que abre a gaveta,
 * texto que não precisa ser reimplementado em SVG).
 *
 * A geometria não é decidida aqui — ela vem inteira do `gantt-layout.js`, que é puro e testado.
 * O que é daqui: o "hoje" e a escala (o relógio e o zoom são de quem desenha), a subdivisão das
 * barras sólidas por coluna, a hachura das cercadas, os tooltips e o clique.
 *
 * **Sólido é fato, hachurado é cerco.** A barra medida (o servidor viu transicionar) sai sólida
 * e subdividida pelas colunas; a nunca observada sai hachurada sobre o intervalo do esforço —
 * "aconteceu em algum momento aqui dentro", nunca uma data inventada.
 */
import { el, esc, svg, pressable } from './dom.js'
import { cleanTitle, numberIndex } from './issues.js'
import { ganttLayout, arrowPath, HOUR_W, BAR_H, LABEL_W } from './gantt-layout.js'
import { edgeDefs, edgeEl } from './edges.js'
import { openIssue } from './drawer.js'

const HOUR = 3600e3
const DAY = 864e5

/** O Gantt do esforço mede em **horas**: um esforço dura dias, mas suas issues duram minutos. */
const PX_PER_MS = HOUR_W / HOUR

/** `2026-07-10` → ms na meia-noite UTC; somar um dia fecha o cerco de um esforço arquivado. */
const dayMs = (day) => Date.parse(day)

const iso = (ms) => new Date(ms).toISOString()
const ddmm = (ms) => `${iso(ms).slice(8, 10)}/${iso(ms).slice(5, 7)}`
const hh = (ms) => `${iso(ms).slice(11, 13)}h`

/** O rótulo de um tique: data na virada do dia, hora no meio dela. */
const tickLabel = (at, step) => (step >= DAY || at % DAY === 0 ? ddmm(at) : hh(at))

/** Uma duração humana, do minuto ao dia — é o que a barra responde no hover. */
function humanDur(ms) {
  const min = Math.round(ms / 60e3)
  if (min < 60) return `${min}min`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 ? `${h}h ${min % 60}min` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/**
 * O que a barra responde ao hover. A sólida diz o intervalo ao minuto e a duração; a hachurada
 * admite que o início e o fim são um cerco (`~`), não um fato — é a barra dizendo o que sabe.
 */
function barTitle(bar) {
  const { issue } = bar
  const dur = humanDur(bar.end - bar.start)
  if (bar.kind === 'hatched') {
    return `~ ${ddmm(bar.start)} → ${bar.open ? 'hoje' : ddmm(bar.end)} · nunca observado · ${issue.status}`
  }
  const fim = bar.open ? 'hoje' : `${ddmm(bar.end)} ${hh(bar.end)}`
  return `${ddmm(bar.start)} ${hh(bar.start)} → ${fim} · ${dur} · ${issue.status}`
}

export function renderGantt(effort, archived) {
  const wrap = el('<div class="gantt"></div>')
  if (!effort.issues.length) {
    wrap.append(el('<p class="empty">Esforço sem issues — não há linha do tempo a desenhar.</p>'))
    return wrap
  }

  const byNumber = numberIndex(effort.issues)
  // O relógio e o cerco são de quem desenha. O `created`/`ended` do esforço vêm do disco (dia
  // UTC); o `ended` ausente quer dizer "ainda vivo", e o cerco estica até "hoje". O servidor
  // não manda "hoje" — hoje envelhece, e payload que envelhece sozinho é o polling ressuscitado.
  const now = Date.now()
  const floor = {
    start: effort.created ? dayMs(effort.created) : now,
    end: effort.ended ? dayMs(effort.ended) + DAY : now,
  }
  const { bars, arrows, ticks, step, todayX, cerco, width, height } = ganttLayout(effort.issues, byNumber, {
    now,
    pxPerMs: PX_PER_MS,
    floor,
  })

  const canvas = el(`<div class="gantt-canvas" style="width:${width}px; height:${height}px"></div>`)

  // O cerco do esforço: uma faixa tênue por trás de tudo, do `created` ao `ended`/hoje. É a
  // barra-pai de disco — o intervalo em que as hachuradas se inscrevem.
  if (cerco.w > 0) {
    canvas.append(el(`<div class="gcerco" style="left:${cerco.x}px; width:${cerco.w}px; top:0; height:${height}px"></div>`))
  }

  for (const t of ticks) {
    if (t.x === todayX) continue // a linha de "hoje" já marca este ponto; dois rótulos se atropelam
    canvas.append(
      el(`<div class="gtick" style="left:${t.x}px; height:${height}px"><span>${esc(tickLabel(t.at, step))}</span></div>`),
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
      <div class="gbar ${bar.kind === 'hatched' ? 'is-hatched' : ''} ${issue.closed ? 'is-closed' : ''} ${bar.open ? 'is-open' : ''} ${issue.blocked ? 'is-blocked' : ''}"
           style="left:${bar.x}px; top:${bar.y}px; width:${bar.w}px; height:${BAR_H}px"
           title="${esc(barTitle(bar))}"></div>
    `)
    // As faixas por coluna dentro da barra sólida — o "tempo em coluna". Posicionadas relativas
    // à barra (a barra é o contêiner), então o `border-radius` dela as recorta nas pontas.
    for (const s of bar.segments) {
      if (s.w <= 0) continue
      rect.append(el(`<div class="gseg is-${esc(s.column)}" style="left:${s.x - bar.x}px; width:${s.w}px"></div>`))
    }
    pressable(label, () => openIssue(issue, effort, archived))
    pressable(rect, () => openIssue(issue, effort, archived))
    canvas.append(label, rect)
  }

  // As setas do `Blocked by:` — a maquinaria compartilhada com o grafo (`edges.js`).
  const edges = svg('svg', { class: 'gantt-edges', width, height })
  edges.append(edgeDefs('gantt'))
  for (const a of arrows) edges.append(edgeEl('gantt', { ...a, d: arrowPath(a) }))
  canvas.append(edges)
  wrap.append(canvas)

  // A hachura é o desenho da incerteza: o board nunca observou aquele ticket transicionar, e o
  // disco só garante que ele viveu dentro do esforço. A nota explica o traço para o desenho
  // honesto não parecer um bug.
  if (bars.some((b) => b.kind === 'hatched')) {
    wrap.append(
      el('<p class="viewnote">Barra hachurada = o servidor nunca viu este ticket transicionar; o disco só garante que ele viveu dentro do esforço. Cada transição observada a solidifica.</p>'),
    )
  }
  return wrap
}
