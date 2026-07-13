/**
 * A gaveta: onde você lê o documento e decide o que fazer com ele — com a trilha de
 * volta e o redimensionamento.
 *
 * O `.md` chega **renderizado** (`md.js`); o que não é markdown — rascunho de agente,
 * log, JSON — continua monoespaçado e literal.
 */
import { api, el, esc, copy, copyBtn } from './dom.js'
import { state } from './state.js'
import { issuePrompts, promptStrip } from './prompts.js'
import { cleanTitle } from './issues.js'
import { renderMarkdown } from './md.js'

const drawer = document.getElementById('drawer')
const scrim = document.getElementById('scrim')

/** Abrir uma issue é abrir a gaveta com o prompt que a destrava junto. */
export function openIssue(issue, effort, archived, nav = false) {
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
    const base = effort ? `${state.board.root}/${archived ? 'archive/' : ''}${effort.slug}` : null
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
  // No celular a gaveta é a tela inteira: rolar o board por trás dela é rolar o que não
  // se vê. No desktop a regra não se aplica — o board continua visível ao lado.
  document.body.classList.add('locked')
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
export function openDrawer(path, opts, nav = false) {
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
  document.body.classList.remove('locked')
  trail.length = 0
  current = null
}

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

/**
 * Liga a gaveta ao documento. É chamada uma vez, do `app.js` — o módulo não se
 * pendura sozinho no DOM ao ser importado.
 */
export function initDrawer() {
  document.getElementById('drawer-close').onclick = closeDrawer
  document.getElementById('drawer-back').onclick = goBack
  scrim.onclick = closeDrawer
  addEventListener('keydown', (e) => e.key === 'Escape' && (trail.length ? goBack() : closeDrawer()))

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
}
