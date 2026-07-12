import { renderMarkdown } from './md.js'

const view = document.getElementById('view')
const crumbs = document.getElementById('crumbs')
const tally = document.getElementById('tally')
const drawer = document.getElementById('drawer')
const scrim = document.getElementById('scrim')

let board = null

const api = async (path, opts) => {
  const res = await fetch(path, opts)
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body
}

const el = (html) => {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstElementChild
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function toast(msg) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => (t.hidden = true), 2600)
}

async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // clipboard API exige contexto seguro; em http://localhost o fallback cobre o resto
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.append(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  toast(msg)
}

/**
 * Botão de copiar. Fica no DOM sempre (invisível até hover ou foco), para que o
 * teclado o alcance; confirma na própria affordance — o ✓ diz *o que* foi copiado,
 * coisa que um toast no rodapé não diz quando há vários botões na tela.
 *
 * Para o `stopPropagation`: quase todo alvo copiável mora dentro de algo clicável
 * (card que navega, linha que abre a gaveta). Copiar não é navegar.
 */
function copyBtn(text, what, label = null) {
  const b = el(`
    <button class="copy ${label ? 'labelled' : ''}" type="button"
            aria-label="Copiar ${esc(what)}" title="Copiar ${esc(what)}">
      <span class="ico" aria-hidden="true"></span>${label ? `<span>${esc(label)}</span>` : ''}
    </button>
  `)
  b.onclick = (ev) => {
    ev.stopPropagation()
    copy(text, `Copiado: ${what}`)
    b.classList.add('done')
    clearTimeout(b.timer)
    b.timer = setTimeout(() => b.classList.remove('done'), 1400)
  }
  return b
}

/** Os documentos do esforço são objetos (`{name, title, blurb}`), não nomes soltos. */
const hasDoc = (effort, name) => effort.docs.some((d) => d.name === name)

// ---------- prompts de skill ----------

/**
 * Do estado de um esforço/issue para o comando que o destrava.
 *
 * O board não invoca skill nenhuma: ele monta o comando com os caminhos certos e
 * te dá o texto. Quem julga é o agente, e a decisão de disparar é sua.
 *
 * Os caminhos vêm do `ref` que o servidor calcula — o nome do arquivo no
 * workspace, não no container. Colar `/workspace/.scratch/...` num agente não leva
 * a lugar nenhum.
 */
function effortPrompts(e, archived) {
  if (archived) return []
  const out = []

  // O wayfinder é o resolve-tudo: onde existe mapa, ele escolhe o ticket, reivindica
  // e resolve. Não há o que decidir aqui, então vem primeiro.
  if (hasDoc(e, 'map.md')) {
    out.push({
      cmd: `/wayfinder ${e.ref}/map.md`,
      hint: 'trabalha o mapa: pega o próximo ticket da frontier e resolve',
      primary: !e.archivable,
    })
  }
  if (e.archivable) {
    out.push({
      cmd: `/scratch archive ${e.slug}`,
      hint: 'destila o aprendizado em memória e move para archive/',
      primary: true,
    })
  }
  if (!e.total && hasDoc(e, 'PRD.md')) {
    out.push({ cmd: `/to-tickets ${e.ref}/PRD.md`, hint: 'decompõe o PRD em issues com arestas de bloqueio' })
  }
  if (!e.total && !hasDoc(e, 'PRD.md') && !hasDoc(e, 'map.md')) {
    out.push({ cmd: `/wayfinder`, hint: 'esforço sem documento: charte o mapa a partir da ideia solta' })
  }
  return out
}

function issuePrompts(i, e, archived) {
  if (archived || i.column === 'fechado') return []
  // Bloqueada não é trabalhável: oferecer o comando seria convidar a furar a fila.
  if (i.blocked) return []

  // Ticket de wayfinder — tem `Type:` e um mapa acima dele. O comando é o do mapa
  // com o ticket nomeado: a skill reivindica, resolve e atualiza o Decisions-so-far.
  if (i.type && hasDoc(e, 'map.md')) {
    return [{ cmd: `/wayfinder ${e.ref}/map.md ${i.ref}`, hint: `ticket ${i.type} — reivindica e resolve`, primary: true }]
  }
  if (i.status === 'needs-triage' || i.status === 'needs-info') {
    return [{ cmd: `/triage ${i.ref}`, hint: 'categoriza, verifica e escreve o brief para o agente' }]
  }
  if (i.status === 'ready-for-agent') {
    return [{ cmd: `/implement ${i.ref}`, hint: 'implementa a issue', primary: true }]
  }
  if (i.status === 'ready-for-human') {
    return [{ cmd: `/grilling ${i.ref}`, hint: 'é sua: grelhe a decisão antes de escrevê-la' }]
  }
  return []
}

/** O comando aparece literal: você copia o que leu, não uma caixa-preta. */
function promptRow(p) {
  const row = el(`
    <div class="prompt ${p.primary ? 'primary' : ''}">
      <code>${esc(p.cmd)}</code>
      <span class="hint">${esc(p.hint)}</span>
    </div>
  `)
  row.append(copyBtn(p.cmd, 'comando', 'copiar'))
  return row
}

function promptStrip(prompts) {
  if (!prompts.length) return null
  const strip = el('<div class="prompts"></div>')
  for (const p of prompts) strip.append(promptRow(p))
  return strip
}

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

// ---------- visão geral ----------

/**
 * O popup de "sobre o que é isto".
 *
 * `pos-2101-flapping-guard` não conta história nenhuma. O título e o primeiro parágrafo
 * do mapa (ou do PRD) contam — e o servidor já os traz junto do board, então lembrar o
 * assunto de um esforço não custa navegação nem request.
 *
 * É um elemento só, reposicionado, e não um popup por card: com trinta esforços na
 * grade, trinta popups ocultos seriam trinta pedaços de DOM para manter vivos à toa.
 */
const peek = el('<div class="peek" hidden></div>')
document.body.append(peek)

function showPeek(anchor, e) {
  // Esforço sem PRD nem mapa não tem resumo para dar — mas tem issues, e os títulos
  // delas dizem do que se trata melhor que um popup vazio ou nenhum popup.
  const body = e.blurb
    ? `<p>${esc(e.blurb)}</p>`
    : e.issues.length
      ? `<ul class="peek-issues">${e.issues
          .slice(0, 5)
          .map((i) => `<li>${esc(cleanTitle(i))}</li>`)
          .join('')}${e.issues.length > 5 ? `<li class="more">+${e.issues.length - 5} issues</li>` : ''}</ul>`
      : ''
  if (!body && !e.title) return

  peek.innerHTML = `
    ${e.title ? `<h4>${esc(e.title)}</h4>` : ''}
    ${body}
    <div class="peek-foot">${e.docs.length ? e.docs.map((d) => esc(d.name)).join(' · ') : 'sem documento'}</div>
  `
  peek.hidden = false

  // Posiciona abaixo do card e prende na viewport: um popup que sai da tela não é popup.
  const r = anchor.getBoundingClientRect()
  const p = peek.getBoundingClientRect()
  const top = r.bottom + 8 + p.height > innerHeight ? r.top - p.height - 8 : r.bottom + 8
  peek.style.top = `${Math.max(8, top)}px`
  peek.style.left = `${Math.min(Math.max(8, r.left), innerWidth - p.width - 8)}px`
}

const hidePeek = () => {
  peek.hidden = true
}
addEventListener('scroll', hidePeek, true)

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
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="chips">${statusChips(e.issues) || '<span class="chip plain">sem issues</span>'}</div>
      ${e.docs.length ? `<div class="docs">${e.docs.map((d) => esc(d.name)).join(' · ')}</div>` : ''}
    </article>
  `)
  card.querySelector('h3').append(copyBtn(e.slug, 'slug'))

  const open = () => {
    hidePeek()
    location.hash = `#/${archived ? 'archive/' : ''}${e.slug}`
  }
  card.onclick = open
  card.onkeydown = (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      open()
    }
  }

  // Mouse e teclado abrem o mesmo popup: quem navega por Tab também precisa lembrar
  // do que se trata o esforço antes de decidir entrar nele.
  card.onmouseenter = () => showPeek(card, e)
  card.onfocus = () => showPeek(card, e)
  card.onmouseleave = hidePeek
  card.onblur = hidePeek
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

function renderOverview() {
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

// ---------- kanban de um esforço ----------

/**
 * O título do arquivo costuma repetir o número (`06 — Task: ...`), que o card já
 * mostra à esquerda. Some com o prefixo — inclusive no texto copiado, porque o que
 * se cola num prompt é o nome da issue, não a numeração dela.
 */
const cleanTitle = (issue) =>
  issue.number ? issue.title.replace(new RegExp(`^0*${Number(issue.number)}\\s*[—–-]\\s*`), '') : issue.title

function openIssue(issue, effort, archived, nav = false) {
  openDrawer(
    issue.path,
    {
      eyebrow: `${effort.slug} · ${issue.number} · ${issue.status}`,
      title: cleanTitle(issue),
      ref: issue.ref,
      prompts: issuePrompts(issue, effort, archived),
      effort,
      archived,
    },
    nav,
  )
}

function issueCard(issue, effort, archived) {
  const title = cleanTitle(issue)
  const card = el(`
    <article class="card ${issue.blocked ? 'is-blocked' : ''}" tabindex="0" role="button">
      <div class="card-title"><b>${esc(issue.number)}</b><span>${esc(title)}</span></div>
      <div class="card-meta">
        <span class="chip" data-s="${esc(issue.status)}">${esc(issue.status)}</span>
        ${issue.type ? `<span class="chip">${esc(issue.type)}</span>` : ''}
        ${issue.blocked ? `<span class="blocked-tag">bloqueada por ${esc(issue.blockedBy.join(', '))}</span>` : ''}
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

function renderEffort(slug, archived) {
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

  const boardEl = el('<div class="board"></div>')
  for (const col of board.columns) {
    const issues = effort.issues.filter((i) => i.column === col.id)
    const node = el(`
      <div class="col">
        <header><span>${esc(col.label)}</span><span>${issues.length}</span></header>
      </div>
    `)
    if (!issues.length) node.append(el('<div class="empty">—</div>'))
    for (const issue of issues) node.append(issueCard(issue, effort, archived))
    boardEl.append(node)
  }
  view.append(boardEl)

  tally.textContent = `${effort.closed}/${effort.total} fechadas`
}

// ---------- scratchpads de sessão ----------

const bytes = (n) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`

/** Rótulo relativo — o UUID da sessão não diz nada; "há 20 min" diz. */
function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `há ${h} h`
  return `há ${Math.round(h / 24)} d`
}

function padCard(pad) {
  const card = el(`
    <article class="pad">
      <div class="effort-top">
        <h3>${esc(pad.short)}</h3>
        <span class="count">${pad.files.length} arq · ${bytes(pad.bytes)}</span>
      </div>
      <div class="pad-when">${esc(ago(pad.mtime))}</div>
      <ul class="files"></ul>
    </article>
  `)
  card.querySelector('h3').append(copyBtn(pad.ref, 'caminho da sessão'))
  const list = card.querySelector('.files')
  for (const f of pad.files) {
    const row = el(`
      <li class="file">
        <span class="fname">${esc(f.name)}</span>
        <span class="fsize">${bytes(f.size)}</span>
      </li>
    `)
    row.append(copyBtn(f.ref, 'caminho'))
    row.onclick = () => openDrawer(f.path, { eyebrow: `scratchpad · ${pad.short}`, title: f.name, ref: f.ref })
    list.append(row)
  }
  return card
}

async function renderPads() {
  crumbs.innerHTML = ''
  const back = el('<button>← esforços</button>')
  back.onclick = () => (location.hash = '')
  crumbs.append(back, el('<span>/ scratchpads</span>'))

  view.innerHTML = ''
  const { pads } = await api('/api/pads')

  const node = el(`
    <section class="section">
      <div class="section-head">
        <h2>Scratchpads de sessão</h2>
        <span class="n">${pads.length}</span>
        <p>O que os agentes rascunharam. Vive em /tmp — some no reboot, e some sem avisar.</p>
      </div>
      <div class="grid"></div>
    </section>
  `)
  const grid = node.querySelector('.grid')
  for (const p of pads) grid.append(padCard(p))
  view.append(node)

  if (!pads.length) {
    grid.append(el('<p class="empty">Nenhuma sessão deixou arquivo.</p>'))
  }
  tally.textContent = `${pads.length} sessões com rascunho`
}

// ---------- gaveta ----------

/**
 * Dá comportamento aos alvos que o renderer marcou.
 *
 * O `md.js` só marca (`data-ref`, `data-issue`, `data-open`); resolver é aqui, porque
 * quem tem o board na mão é o cliente. Um `Blocked by: 04` navega para a issue 04 do
 * *mesmo* esforço, e um `[review-01.md](../review-01.md)` é relativo ao arquivo aberto
 * — daí o `path` e o `effort` no contexto.
 */
function wireRefs(body, path, effort, archived) {
  for (const b of body.querySelectorAll('.ref')) {
    const ref = b.dataset.ref
    b.onclick = () => {
      copy(ref, 'Copiado: caminho')
      b.classList.add('done')
      clearTimeout(b.timer)
      b.timer = setTimeout(() => b.classList.remove('done'), 1400)
    }
  }

  for (const b of body.querySelectorAll('.issueref')) {
    const n = b.dataset.issue
    const issue = effort?.issues.find((i) => i.number === n.padStart(2, '0') || i.number === n)
    if (!issue) {
      // Sem alvo, não é link: o número vira texto em vez de um botão que mente.
      b.replaceWith(el(`<code>${esc(n)}</code>`))
      continue
    }
    b.title = `${cleanTitle(issue)} — ${issue.status}`
    b.dataset.s = issue.status
    b.onclick = () => openIssue(issue, effort, archived, true)
  }

  const dir = path.slice(0, path.lastIndexOf('/'))
  for (const b of body.querySelectorAll('.doclink')) {
    // `../review-01.md` só significa algo em relação ao arquivo que o cita.
    const target = decodeURIComponent(new URL(b.dataset.open, `file://${dir}/`).pathname)

    // Se o destino é uma issue do esforço, abre como issue — assim vem com o prompt
    // que a destrava, e não como documento solto.
    const issue = effort?.issues.find((i) => i.path === target)
    if (issue) {
      b.onclick = () => openIssue(issue, effort, archived, true)
      continue
    }

    const name = target.slice(target.lastIndexOf('/') + 1)
    const base = effort ? `${board.root}/${archived ? 'archive/' : ''}${effort.slug}` : null
    b.onclick = () =>
      openDrawer(
        target,
        {
          eyebrow: effort?.slug ?? '',
          title: name,
          ref: base && target.startsWith(base) ? target.replace(base, effort.ref) : target,
          effort,
          archived,
        },
        true,
      )
  }
}

/**
 * Onde a gaveta esteve, e o que ela mostra agora.
 *
 * Um documento cita o outro, e seguir a citação sem poder voltar seria trocar o
 * contexto que você tinha por um que você não pediu.
 */
const trail = []
let current = null

/**
 * A gaveta é o lugar onde você decide o que fazer com um arquivo — então é onde
 * o comando e o caminho precisam estar à mão, junto com o texto que os motivou.
 *
 * O `.md` chega renderizado, não cru: é um documento para ler, e o cabeçalho, as
 * tabelas e os caminhos dizem mais quando têm forma. O que não é markdown (rascunho
 * de agente, log, JSON) continua monoespaçado e literal.
 */
async function render(path, opts) {
  const { eyebrow, title, ref, prompts = [], effort = null, archived = false } = opts
  current = { path, opts }

  document.getElementById('drawer-eyebrow').textContent = eyebrow
  const head = document.getElementById('drawer-title')
  head.textContent = title
  if (ref) head.append(copyBtn(title, 'título'))

  const back = document.getElementById('drawer-back')
  back.hidden = !trail.length

  const actions = document.getElementById('drawer-actions')
  actions.innerHTML = ''
  if (ref) actions.append(copyBtn(ref, 'caminho', ref))
  const strip = promptStrip(prompts)
  if (strip) actions.append(strip)
  actions.hidden = !actions.childElementCount

  const body = document.getElementById('drawer-body')
  body.textContent = 'carregando…'
  body.classList.remove('md')
  drawer.hidden = scrim.hidden = false
  body.scrollTop = 0

  try {
    const { content } = await api(`/api/file?path=${encodeURIComponent(path)}`)
    if (path.endsWith('.md')) {
      body.classList.add('md')
      body.innerHTML = renderMarkdown(content)
      wireRefs(body, path, effort, archived)
    } else {
      body.textContent = content
    }
  } catch (err) {
    body.textContent = `erro: ${err.message}`
  }
}

/**
 * `nav` separa seguir um link de dentro do documento — que empilha a volta — de abrir
 * a gaveta a partir do board, que começa uma trilha nova.
 */
function openDrawer(path, opts, nav = false) {
  if (nav && current) trail.push(current)
  else if (!nav) trail.length = 0
  return render(path, opts)
}

function goBack() {
  const prev = trail.pop()
  return prev ? render(prev.path, prev.opts) : closeDrawer()
}

const closeDrawer = () => {
  drawer.hidden = scrim.hidden = true
  trail.length = 0
  current = null
}
document.getElementById('drawer-close').onclick = closeDrawer
document.getElementById('drawer-back').onclick = goBack
scrim.onclick = closeDrawer
addEventListener('keydown', (e) => e.key === 'Escape' && (trail.length ? goBack() : closeDrawer()))

// ---------- largura da gaveta ----------

/**
 * A gaveta é redimensionável, e a largura escolhida sobrevive ao reload.
 *
 * Isto é `localStorage` — e é a única coisa que o board guarda fora dos `.md`. Não
 * fere o princípio: a fonte da verdade é o *conteúdo*, e a largura da gaveta não é
 * conteúdo. É preferência de quem olha, não estado do trabalho; nenhum agente lê,
 * nenhum arquivo depende, e perdê-la não perde nada.
 */
const WIDTH_KEY = 'scratch-board:drawer-w'
const DEFAULT_W = 780
const MIN_W = 380

const setDrawerWidth = (px) => {
  const w = Math.round(Math.min(Math.max(px, MIN_W), innerWidth - 120))
  document.documentElement.style.setProperty('--drawer-w', `${w}px`)
  return w
}

const savedWidth = Number(localStorage.getItem(WIDTH_KEY))
if (savedWidth) setDrawerWidth(savedWidth)

const grip = document.getElementById('drawer-grip')

grip.onpointerdown = (ev) => {
  ev.preventDefault()
  grip.setPointerCapture(ev.pointerId)
  drawer.classList.add('resizing')
  document.body.classList.add('resizing')

  // A gaveta é ancorada à direita: a largura é a distância do cursor até a borda.
  const move = (e) => setDrawerWidth(innerWidth - e.clientX)
  const up = (e) => {
    localStorage.setItem(WIDTH_KEY, String(setDrawerWidth(innerWidth - e.clientX)))
    drawer.classList.remove('resizing')
    document.body.classList.remove('resizing')
    grip.removeEventListener('pointermove', move)
    grip.removeEventListener('pointerup', up)
  }
  grip.addEventListener('pointermove', move)
  grip.addEventListener('pointerup', up)
}

grip.ondblclick = () => {
  setDrawerWidth(DEFAULT_W)
  localStorage.removeItem(WIDTH_KEY)
}

// ---------- roteamento ----------

function route() {
  const hash = location.hash.replace(/^#\/?/, '')
  if (!hash) return renderOverview()
  if (hash === 'pads') {
    return renderPads().catch((err) => {
      view.innerHTML = `<p class="empty">Falha ao ler os scratchpads: ${esc(err.message)}</p>`
    })
  }
  const archived = hash.startsWith('archive/')
  renderEffort(archived ? hash.slice('archive/'.length) : hash, archived)
}

async function refresh() {
  board = await api('/api/board')
  route()
}

addEventListener('hashchange', route)
refresh().catch((err) => {
  view.innerHTML = `<p class="empty">Falha ao ler o board: ${esc(err.message)}</p>`
})
setInterval(() => refresh().catch(() => {}), 5000)
