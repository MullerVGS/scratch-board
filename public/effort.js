/**
 * A página de um esforço: a barra de documentos, os prompts, e as três visões —
 * o kanban, o grafo e o Gantt.
 *
 * A visão escolhida vive no **hash**, não em `localStorage`: é onde já vive o resto da
 * navegação, e assim o grafo (ou o Gantt) de um esforço vira um link colável.
 */
import { el, esc, copyBtn } from './dom.js'
import { boardOf } from './state.js'
import { view, crumbs, tally } from './shell.js'
import { effortPrompts, promptStrip } from './prompts.js'
import { cleanTitle, openDeps, staleLabel } from './issues.js'
import { openDrawer, openIssue } from './drawer.js'
import { renderGraph } from './graph.js'
import { renderGantt } from './gantt.js'

function issueCard(issue, effort, archived) {
  const title = cleanTitle(issue)
  // O "há N dias" é conta **daqui** — o servidor manda o dia absoluto em que o ticket parou —,
  // e o rótulo só sai quando informa. O porquê das duas coisas mora no `staleLabel()`.
  const stale = staleLabel(issue)
  const card = el(`
    <article class="card ${issue.blocked ? 'is-blocked' : ''}" tabindex="0" role="button">
      <div class="card-title"><b>${esc(issue.number)}</b><span>${esc(title)}</span></div>
      <div class="card-meta">
        <span class="chip" data-s="${esc(issue.status)}">${esc(issue.status)}</span>
        ${issue.type ? `<span class="chip">${esc(issue.type)}</span>` : ''}
        ${stale ? `<span class="stale-tag" title="última escrita em ${esc(issue.touched)}">${esc(stale)}</span>` : ''}
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

// `mode` é o segmento do hash depois do slug: `grafo`, `gantt`, ou nada — e qualquer coisa
// que não seja uma visão conhecida cai na lista, como um hash velho caía.
export function renderEffort(ns, slug, archived, mode) {
  const board = boardOf(ns)
  const pool = archived ? board.archived : board.efforts
  const effort = pool.find((e) => e.slug === slug)
  // O esforço é procurado **dentro da origem**: o mesmo slug em outra origem é outro
  // esforço, e nunca é este. Não achou aqui, volta para a visão geral **desta** origem.
  if (!effort) return (location.hash = `#/${ns}`)

  const back = el('<button>← esforços</button>')
  back.onclick = () => (location.hash = `#/${ns}`)
  const here = el(`<span>/ ${esc(slug)}</span>`)
  here.append(copyBtn(slug, 'slug'))
  crumbs.replaceChildren(back, here)

  // A tela é montada de lado e trocada de uma vez, no fim. Esvaziar a `view` aqui e ir
  // preenchendo daria ao navegador uma página em branco para pintar no meio do caminho —
  // a piscada. Uma troca, uma pintura.
  const parts = []

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
    // O caminho sai do `path` do próprio esforço — que o servidor já calculou contra o root
    // da origem certa. Remontá-lo aqui (root + archive + slug) era possível quando havia um
    // root só; com N origens seria o cliente refazendo, na mão, a conta de que root é quem.
    b.onclick = () =>
      openDrawer(`${effort.path}/${doc.name}`, {
        eyebrow: slug,
        title: doc.title ?? doc.name,
        ref: `${effort.ref}/${doc.name}`,
        effort,
        archived,
      })
    bar.append(b)
  }
  bar.append(copyBtn(effort.ref, 'caminho do esforço', effort.ref))
  parts.push(bar)

  const strip = promptStrip(effortPrompts(effort, archived))
  if (strip) parts.push(strip)

  // A visão escolhida vive no hash, não em `localStorage`: é onde já vive o resto da
  // navegação, e um link para o grafo ou o Gantt de um esforço passa a ser colável.
  const base = `#/${ns}/${archived ? 'archive/' : ''}${slug}`
  const views = [
    ['lista', base],
    ['grafo', `${base}/grafo`],
    ['gantt', `${base}/gantt`],
  ]
  const on = views.some(([name]) => name === mode) ? mode : 'lista'
  const swap = el('<div class="viewswitch" role="tablist"></div>')
  for (const [name, hash] of views) {
    const b = el(`<button role="tab" class="${on === name ? 'on' : ''}" aria-selected="${on === name}">${name}</button>`)
    b.onclick = () => (location.hash = hash)
    swap.append(b)
  }
  parts.push(swap)

  if (on === 'grafo') {
    parts.push(renderGraph(effort, archived))
  } else if (on === 'gantt') {
    parts.push(renderGantt(effort, archived))
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
    parts.push(boardEl)
  }

  view.replaceChildren(...parts)
  tally.textContent = `${effort.closed}/${effort.total} fechadas`
}
