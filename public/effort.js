/**
 * A página de um esforço: a barra de documentos, os prompts, e as duas visões —
 * o kanban e o grafo.
 *
 * A visão escolhida vive no **hash**, não em `localStorage`: é onde já vive o resto da
 * navegação, e assim o grafo de um esforço vira um link colável.
 */
import { el, esc, copyBtn } from './dom.js'
import { state } from './state.js'
import { view, crumbs, tally } from './shell.js'
import { effortPrompts, promptStrip } from './prompts.js'
import { cleanTitle, openDeps } from './issues.js'
import { openDrawer, openIssue } from './drawer.js'
import { renderGraph } from './graph.js'

function issueCard(issue, effort, archived) {
  const title = cleanTitle(issue)
  const card = el(`
    <article class="card ${issue.blocked ? 'is-blocked' : ''}" tabindex="0" role="button">
      <div class="card-title"><b>${esc(issue.number)}</b><span>${esc(title)}</span></div>
      <div class="card-meta">
        <span class="chip" data-s="${esc(issue.status)}">${esc(issue.status)}</span>
        ${issue.type ? `<span class="chip">${esc(issue.type)}</span>` : ''}
        ${issue.blocked ? `<span class="blocked-tag">bloqueada por ${esc(openDeps(issue, effort).map((d) => d.number).join(', '))}</span>` : ''}
      </div>
    </article>
  `)
  card.querySelector('.card-title').append(copyBtn(title, 'título'))
  card.querySelector('.card-meta').append(copyBtn(issue.ref, 'caminho'))

  card.onclick = () => openIssue(issue, effort, archived)
  card.onkeydown = (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      openIssue(issue, effort, archived)
    }
  }
  return card
}

export function renderEffort(slug, archived, graph = false) {
  const board = state.board
  const pool = archived ? board.archived : board.efforts
  const effort = pool.find((e) => e.slug === slug)
  if (!effort) return (location.hash = '')

  crumbs.innerHTML = ''
  const back = el('<button>← esforços</button>')
  back.onclick = () => (location.hash = '')
  const here = el(`<span>/ ${esc(slug)}</span>`)
  here.append(copyBtn(slug, 'slug'))
  crumbs.append(back, here)

  view.innerHTML = ''

  const bar = el(`
    <div class="actionbar ${effort.archivable ? 'ready' : ''}">
      <p>${
        archived
          ? 'Esforço arquivado — somente leitura recomendada.'
          : effort.archivable
            ? `Todas as ${effort.total} issues fecharam. Pronto para encerrar.`
            : `${effort.total - effort.closed} de ${effort.total} issues em aberto.`
      }</p>
    </div>
  `)

  for (const doc of effort.docs) {
    const b = el(`<button class="act">${esc(doc.name)}</button>`)
    b.onclick = () =>
      openDrawer(`${board.root}/${archived ? 'archive/' : ''}${slug}/${doc.name}`, {
        eyebrow: slug,
        title: doc.title ?? doc.name,
        ref: `${effort.ref}/${doc.name}`,
        effort,
        archived,
      })
    bar.append(b)
  }
  bar.append(copyBtn(effort.ref, 'caminho do esforço', effort.ref))
  view.append(bar)

  const strip = promptStrip(effortPrompts(effort, archived))
  if (strip) view.append(strip)

  // A visão escolhida vive no hash, não em `localStorage`: é onde já vive o resto da
  // navegação, e um link para o grafo de um esforço passa a ser colável.
  const base = `#/${archived ? 'archive/' : ''}${slug}`
  const swap = el(`
    <div class="viewswitch" role="tablist">
      <button role="tab" class="${graph ? '' : 'on'}" aria-selected="${!graph}">lista</button>
      <button role="tab" class="${graph ? 'on' : ''}" aria-selected="${graph}">grafo</button>
    </div>
  `)
  const [listBtn, graphBtn] = swap.querySelectorAll('button')
  listBtn.onclick = () => (location.hash = base)
  graphBtn.onclick = () => (location.hash = `${base}/grafo`)
  view.append(swap)

  if (graph) {
    view.append(renderGraph(effort, archived))
  } else {
    const boardEl = el('<div class="board"></div>')
    for (const col of board.columns) {
      const issues = effort.issues.filter((i) => i.column === col.id)
      // Coluna zerada continua na tela — o estágio existe, e saber que está vazio é
      // informação —, mas encolhe para uma faixa: a caixa de 150px com um travessão
      // dentro empurrava o trabalho de verdade para baixo da dobra.
      const node = el(`
        <div class="col ${issues.length ? '' : 'is-empty'}">
          <header><span>${esc(col.label)}</span><span>${issues.length}</span></header>
        </div>
      `)
      if (!issues.length) node.append(el('<div class="empty">—</div>'))
      for (const issue of issues) node.append(issueCard(issue, effort, archived))
      boardEl.append(node)
    }
    view.append(boardEl)
  }

  tally.textContent = `${effort.closed}/${effort.total} fechadas`
}
