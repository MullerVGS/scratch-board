/**
 * O desenho único da linha do tempo. Com um grupo expandido, é o Gantt filtrado de um esforço;
 * com a frota inteira, são esforços-pai colapsáveis e suas issues logo abaixo. HTML posiciona
 * rótulos/barras; SVG desenha somente as setas compartilhadas com o grafo.
 */
import { el, esc, svg, pressable } from './dom.js'
import { cleanTitle } from './issues.js'
import { groupedGanttLayout, arrowPath, HOUR_W, DAY_W, BAR_H, LABEL_W } from './gantt-layout.js'
import { edgeDefs, edgeEl } from './edges.js'
import { openIssue } from './drawer.js'
import { boardOf } from './state.js'
import { view, crumbs, tally } from './shell.js'
import { fleetSwitch } from './overview.js'
import { draggableConfirmation } from './confirm.js'

const HOUR = 3600e3
const DAY = 864e5
const HOUR_PX = HOUR_W / HOUR
const DAY_PX = DAY_W / DAY

/** Horário de Brasília (UTC−3): o dado é absoluto; o fuso só existe no rótulo. */
const BR = -3 * HOUR
const iso = (ms) => new Date(ms + BR).toISOString()
const ddmm = (ms) => `${iso(ms).slice(8, 10)}/${iso(ms).slice(5, 7)}`
const hh = (ms) => `${iso(ms).slice(11, 13)}h`
const dayMs = (day) => Date.parse(`${day}T00:00:00-03:00`)
const tickLabel = (at, step) => (step >= DAY || (at + BR) % DAY === 0 ? ddmm(at) : hh(at))

const rowStyle = ({ x, w }, y) =>
  `left:${x}px; top:${y}px; width:${w}px; height:${BAR_H}px; --row-y:${y}px; --row-h:${BAR_H}px`

function layerSwitch(host) {
  const controls = el(`
    <div class="gantt-layers" role="group" aria-label="Camadas da linha do tempo">
      <span>camada</span>
      <button type="button" data-layer="measured">medido</button>
      <button type="button" data-layer="confirmed">confirmado</button>
      <button type="button" data-layer="both" aria-pressed="true">ambos</button>
    </div>
  `)
  for (const button of controls.querySelectorAll('button')) {
    button.onclick = () => {
      host.dataset.layer = button.dataset.layer
      for (const peer of controls.querySelectorAll('button')) {
        peer.setAttribute('aria-pressed', String(peer === button))
      }
    }
  }
  return controls
}

const targetOf = (group, number) => ({
  ns: group.effort.ns,
  slug: group.effort.slug,
  ...(number === undefined ? {} : { number }),
})

function confirmedBar(range, y, { className = '', title, pxPerMs, target, onClick }) {
  const rect = el(`
    <div class="gbar is-confirmed ${className}" style="${rowStyle(range, y)}"
         title="${esc(title)}"></div>
  `)
  draggableConfirmation(rect, {
    range: { start: range.start, end: range.end },
    pxPerMs,
    target,
    onClick,
  })
  return rect
}

function humanDur(ms) {
  const min = Math.round(ms / 60e3)
  if (min < 60) return `${min}min`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 ? `${h}h ${min % 60}min` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

function barTitle(bar) {
  const { issue } = bar
  const dur = humanDur(bar.end - bar.start)
  if (bar.kind === 'hatched') {
    return `~ ${ddmm(bar.start)} → ${bar.open ? 'hoje' : ddmm(bar.end)} · nunca observado · ${issue.status}`
  }
  const end = bar.open ? 'hoje' : `${ddmm(bar.end)} ${hh(bar.end)}`
  return `${ddmm(bar.start)} ${hh(bar.start)} → ${end} · ${dur} · ${issue.status}`
}

const parentTitle = ({ group, start, end }) => {
  const { effort } = group
  const endLabel = effort.ended ? ddmm(dayMs(effort.ended)) : 'hoje'
  return `${effort.slug} · ${effort.closed} de ${effort.total} · ${ddmm(start)} → ${endLabel} · ${humanDur(end - start)}`
}

const entryId = (effort, archived) => `${archived ? 'archive/' : ''}${effort.slug}`

function entry(effort, archived, now) {
  return {
    id: entryId(effort, archived),
    effort,
    archived,
    floor: {
      start: effort.created ? dayMs(effort.created) : now,
      end: effort.ended ? dayMs(effort.ended) + DAY : now,
    },
  }
}

/** Desenha os dois escopos sem bifurcar a tela: só mudam grupos, escala e estado expandido. */
function renderTimeline(groups, { pxPerMs, tickEvery, expanded, onToggle, centerToday = false }) {
  const host = el('<section class="gantt-view" data-layer="both"></section>')
  const wrap = el('<div class="gantt"></div>')
  if (!groups.length) {
    wrap.append(el('<p class="empty">Nenhum esforço — não há linha do tempo a desenhar.</p>'))
    host.append(wrap)
    return host
  }

  const now = Date.now()
  const unit = tickEvery ?? DAY
  const axisPad = centerToday ? Math.ceil(window.innerWidth / 2 / pxPerMs / unit) * unit : 0
  const { parents, bars, arrows, ticks, step, todayX, width, height } = groupedGanttLayout(groups, {
    now,
    pxPerMs,
    expanded,
    tickEvery,
    axisPad,
  })
  const canvas = el(`<div class="gantt-canvas" style="width:${width}px; height:${height}px"></div>`)

  for (const tick of ticks) {
    if (tick.x === todayX) continue
    canvas.append(
      el(`<div class="gtick" style="left:${tick.x}px; height:${height}px"><span>${esc(tickLabel(tick.at, step))}</span></div>`),
    )
  }
  if (todayX !== null) {
    canvas.append(el(`<div class="gtick is-today" style="left:${todayX}px; height:${height}px"><span>hoje</span></div>`))
  }

  for (const parent of parents) {
    const { group } = parent
    const { effort } = group
    const interactive = Boolean(onToggle)
    const toggleClass = interactive ? 'is-toggle' : ''
    const toggleAttrs = interactive ? 'tabindex="0" role="button"' : ''
    const glyph = interactive ? (parent.expanded ? '▾' : '▸') : '·'
    const label = el(`
      <div class="glabel is-parent ${toggleClass}" style="top:${parent.y}px; width:${LABEL_W}px; height:${BAR_H}px"
           ${toggleAttrs}>
        <b>${glyph}</b><span>${esc(effort.slug)}</span><em>${effort.closed} de ${effort.total}</em>
      </div>
    `)
    const rect = el(`
      <div class="gbar is-parent is-measured ${parent.confirmed ? 'has-confirmed' : ''} ${toggleClass}" style="${rowStyle(parent, parent.y)}"
           title="${esc(parentTitle(parent))}"></div>
    `)
    if (interactive) {
      pressable(label, () => onToggle(group.id))
    }
    draggableConfirmation(rect, {
      range: { start: parent.start, end: parent.end },
      pxPerMs,
      target: targetOf(group),
      onClick: interactive ? () => onToggle(group.id) : undefined,
    })
    canvas.append(label, rect)
    if (parent.confirmed) {
      canvas.append(confirmedBar(parent.confirmed, parent.y, {
        className: 'is-parent has-confirmed',
        title: `confirmado · ${ddmm(parent.confirmed.start)} ${hh(parent.confirmed.start)} → ${ddmm(parent.confirmed.end)} ${hh(parent.confirmed.end)}`,
        pxPerMs,
        target: targetOf(group),
        onClick: interactive ? () => onToggle(group.id) : undefined,
      }))
    }
  }

  for (const bar of bars) {
    const { issue, group } = bar
    const label = el(`
      <div class="glabel is-child ${issue.closed ? 'is-closed' : ''}" style="top:${bar.y}px; width:${LABEL_W}px; height:${BAR_H}px"
           tabindex="0" role="button">
        <b>${esc(issue.number)}</b><span>${esc(cleanTitle(issue))}</span>
      </div>
    `)
    const rect = el(`
      <div class="gbar is-measured ${bar.confirmed && bar.kind !== 'hatched' ? 'has-confirmed' : ''} ${bar.confirmed && bar.kind === 'hatched' ? 'is-confirmed-fallback' : ''} ${bar.kind === 'hatched' ? 'is-hatched' : ''} ${issue.closed ? 'is-closed' : ''} ${bar.open ? 'is-open' : ''} ${issue.blocked ? 'is-blocked' : ''}"
           style="${rowStyle(bar, bar.y)}"
           title="${esc(barTitle(bar))}"></div>
    `)
    for (const segment of bar.segments) {
      if (segment.w <= 0) continue
      rect.append(el(`<div class="gseg is-${esc(segment.column)}" style="left:${segment.x - bar.x}px; width:${segment.w}px"></div>`))
    }
    pressable(label, () => openIssue(issue, group.effort, group.archived))
    draggableConfirmation(rect, {
      range: { start: bar.start, end: bar.end },
      pxPerMs,
      target: targetOf(group, issue.number),
      onClick: () => openIssue(issue, group.effort, group.archived),
    })
    canvas.append(label, rect)
    if (bar.confirmed) {
      canvas.append(confirmedBar(bar.confirmed, bar.y, {
        className: `${bar.kind === 'hatched' ? '' : 'has-confirmed'} ${issue.closed ? 'is-closed' : ''}`,
        title: `confirmado · ${ddmm(bar.confirmed.start)} ${hh(bar.confirmed.start)} → ${ddmm(bar.confirmed.end)} ${hh(bar.confirmed.end)}`,
        pxPerMs,
        target: targetOf(group, issue.number),
        onClick: () => openIssue(issue, group.effort, group.archived),
      }))
    }
  }

  const edges = svg('svg', { class: 'gantt-edges', width, height })
  edges.append(edgeDefs('gantt'))
  for (const arrow of arrows) edges.append(edgeEl('gantt', { ...arrow, d: arrowPath(arrow) }))
  canvas.append(edges)
  wrap.append(canvas)

  if (centerToday && todayX !== null) {
    requestAnimationFrame(() => {
      wrap.scrollLeft = todayX - wrap.clientWidth / 2
    })
  }
  if (bars.some((bar) => bar.kind === 'hatched')) {
    wrap.append(
      el('<p class="viewnote">Barra hachurada = o servidor nunca viu este ticket transicionar; o disco só garante que ele viveu dentro do esforço.</p>'),
    )
  }
  host.append(layerSwitch(host), wrap)
  return host
}

/** A terceira aba do esforço usa a mesma timeline, com um grupo que nasce expandido. */
export function renderGantt(effort, archived) {
  const now = Date.now()
  const group = entry(effort, archived, now)
  return renderTimeline([group], {
    pxPerMs: HOUR_PX,
    tickEvery: HOUR,
    expanded: [group.id],
    centerToday: true,
  })
}

/** A rota global: frota colapsada por padrão; cada expansão é um segmento colável do hash. */
export function renderGlobalGantt(ns, expandedIds = []) {
  const board = boardOf(ns)
  if (board.error) {
    crumbs.replaceChildren()
    view.replaceChildren(
      fleetSwitch(ns, 'gantt'),
      el(`<p class="empty bad"><strong>Falha ao ler <code>${esc(board.ref)}</code>.</strong> ${esc(board.error)}</p>`),
    )
    tally.textContent = 'origem ilegível'
    return
  }
  const now = Date.now()
  const groups = [
    ...board.efforts.map((effort) => entry(effort, false, now)),
    ...board.archived.map((effort) => entry(effort, true, now)),
  ]
  const known = new Set(groups.map((group) => group.id))
  const expanded = new Set(expandedIds.filter((id) => known.has(id)))

  crumbs.replaceChildren()
  const toggle = (id) => {
    if (expanded.has(id)) expanded.delete(id)
    else expanded.add(id)
    const ordered = groups.map((group) => group.id).filter((groupId) => expanded.has(groupId))
    location.hash = `#/${ns}/-/gantt${ordered.length ? `/${ordered.map(encodeURIComponent).join('/')}` : ''}`
  }

  view.replaceChildren(
    fleetSwitch(ns, 'gantt'),
    renderTimeline(groups, {
      pxPerMs: DAY_PX,
      tickEvery: DAY,
      expanded,
      onToggle: toggle,
    }),
  )
  const total = groups.reduce((sum, group) => sum + group.effort.total, 0)
  const closed = groups.reduce((sum, group) => sum + group.effort.closed, 0)
  tally.textContent = `${groups.length} esforços · ${closed}/${total} issues fechadas`
}
