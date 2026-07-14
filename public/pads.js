/**
 * Os scratchpads de sessão — o root que **não é uma origem**, montado read-only.
 *
 * É rascunho de agente: o board lê e não toca. Vive em `/tmp`, some no reboot do WSL,
 * e o board não promete o contrário.
 *
 * Eles são **globais**: ficam fora das abas de origem, porque não pertencem a repositório
 * nenhum — são o rascunho do Claude, não o tracker de um projeto. E continuam **sob
 * demanda**: sem watcher e sem push, relidos ao entrar aqui e pelo botão de reler. Vigiar o
 * churn de `/tmp` seria ruído puro.
 */
import { api, el, esc, copyBtn } from './dom.js'
import { state } from './state.js'
import { view, crumbs, tally } from './shell.js'
import { openDrawer } from './drawer.js'

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

export async function renderPads() {
  const back = el('<button>← esforços</button>')
  // Os pads não têm origem, então "voltar" é a origem de casa — a primeira aba, a mesma que
  // o board abre. Voltar para `#/` só reabriria esta decisão no roteador.
  back.onclick = () => (location.hash = `#/${state.namespaces[0] ?? ''}`)
  crumbs.replaceChildren(back, el('<span>/ scratchpads</span>'))

  // O fetch vem **antes** de tocar na tela. A ordem antiga esvaziava a `view` e só então
  // ia buscar os pads: a página ficava em branco durante a viagem inteira até o servidor.
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
  if (!pads.length) {
    grid.append(el('<p class="empty">Nenhuma sessão deixou arquivo.</p>'))
  }

  view.replaceChildren(node)
  tally.textContent = `${pads.length} sessões com rascunho`
}
