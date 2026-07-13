/**
 * A visão geral: os esforços do `.scratch/`, agrupados pelo que o board classifica —
 * ativos, prontos para arquivar, parados, arquivados.
 */
import { el, esc, copyBtn } from './dom.js'
import { state } from './state.js'
import { view, crumbs, tally } from './shell.js'

// ---------- chips de status ----------

/** Ordem de leitura: o que trava primeiro, o que já fechou por último. */
const STATUS_ORDER = [
  'needs-triage',
  'needs-info',
  'ready-for-agent',
  'ready-for-human',
  'claimed',
  'partial',
  'done',
  'resolved',
  'wontfix',
]

const statusRank = (s) => {
  const i = STATUS_ORDER.indexOf(s)
  return i === -1 ? -1 : i // status desconhecido vem primeiro: precisa aparecer
}

function statusChips(issues) {
  const counts = new Map()
  for (const i of issues) counts.set(i.status, (counts.get(i.status) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => statusRank(a[0]) - statusRank(b[0]))
    .map(([s, n]) => `<span class="chip" data-s="${esc(s)}">${esc(s)} ${n}</span>`)
    .join('')
}

// ---------- os cards ----------

/**
 * O card diz do que o esforço se trata — no próprio card.
 *
 * `pos-2101-flapping-guard` não conta história nenhuma; o título e o primeiro parágrafo
 * do mapa (ou do PRD) contam, e o servidor já os traz junto do board. Eles moraram num
 * popup de hover, e o hover é a parte errada dessa frase: no celular não existe, e no
 * desktop custava posicionar um flutuante contra a viewport na mão. Três linhas
 * clampadas no card dizem o mesmo em qualquer dispositivo; quem quiser o resto abre o
 * documento, que é para onde o card leva de qualquer jeito.
 */
function effortCard(e, archived = false) {
  const pct = e.total ? Math.round((e.closed / e.total) * 100) : 0
  const card = el(`
    <article class="effort ${e.archivable ? 'is-archivable' : ''} ${archived ? 'is-archived' : ''}"
             tabindex="0" role="link">
      <div class="effort-top">
        <h3>${esc(e.slug)}</h3>
        <span class="count"><b>${e.closed}</b>/${e.total}</span>
      </div>
      ${e.title ? `<p class="lede">${esc(e.title)}</p>` : ''}
      ${e.blurb ? `<p class="blurb">${esc(e.blurb)}</p>` : ''}
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="chips">${statusChips(e.issues) || '<span class="chip plain">sem issues</span>'}</div>
      ${e.docs.length ? `<div class="docs">${e.docs.map((d) => esc(d.name)).join(' · ')}</div>` : ''}
    </article>
  `)
  card.querySelector('h3').append(copyBtn(e.slug, 'slug'))

  const open = () => (location.hash = `#/${archived ? 'archive/' : ''}${e.slug}`)
  card.onclick = open
  card.onkeydown = (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      open()
    }
  }
  return card
}

function section(title, blurb, efforts, archived = false) {
  if (!efforts.length) return null
  const node = el(`
    <section class="section">
      <div class="section-head">
        <h2>${esc(title)}</h2>
        <span class="n">${efforts.length}</span>
        <p>${esc(blurb)}</p>
      </div>
      <div class="grid"></div>
    </section>
  `)
  const grid = node.querySelector('.grid')
  for (const e of efforts) grid.append(effortCard(e, archived))
  return node
}

export function renderOverview() {
  const board = state.board
  crumbs.innerHTML = ''
  view.innerHTML = ''

  const archivable = board.efforts.filter((e) => e.archivable)
  const stalled = board.efforts.filter((e) => !e.archivable && e.stalled)
  const active = board.efforts.filter((e) => !e.archivable && !e.stalled)

  const sections = [
    section('Ativos', 'Trabalho em curso: já tem issue fechada e issue aberta.', active),
    section(
      'Prontos para arquivar',
      'Todas as issues fecharam. Destile o aprendizado numa memória antes de mover.',
      archivable,
    ),
    section(
      'Parados',
      'Nenhuma issue fechada. Trabalho pretendido, não concluído — arquivar aqui mentiria.',
      stalled,
    ),
    section('Arquivados', 'Encerrados. A trilha de raciocínio continua consultável.', board.archived, true),
  ].filter(Boolean)

  if (!sections.length) {
    view.append(el('<p class="empty">Nenhum esforço em .scratch/</p>'))
    return
  }
  view.append(...sections)

  const openIssues = board.efforts.reduce((n, e) => n + (e.total - e.closed), 0)
  tally.textContent = `${board.efforts.length} esforços · ${openIssues} issues abertas · ${board.archived.length} arquivados`
}
