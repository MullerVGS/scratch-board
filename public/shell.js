/**
 * A moldura: os pontos fixos da tela — o cabeçalho (título, `.dot` de conexão, abas de
 * origem, botão de reler) e os dois painéis, `#pane-left` (a árvore) e `#pane-right` (o
 * conteúdo do alvo — viewer ou grafo, conforme o tipo do nó). `router.js` e `app.js`
 * amarram o resto; nada aqui sabe o que o alvo é nem como ele se desenha.
 *
 * `renderShell()` monta a moldura **uma vez**, no boot (`app.js`). Os dois painéis saem
 * como bindings vivas (`export let`) — o import é uma referência que se atualiza sozinha
 * assim que `renderShell()` roda, então quem os importa antes não precisa reimportar.
 */
import { el, esc, toast } from './dom.js'
import { state } from './state.js'

const app = document.getElementById('app')

/** O container do painel esquerdo (a árvore) — `null` até `renderShell()` rodar. */
export let paneLeft = null
/** O container do painel direito (viewer ou grafo) — idem. */
export let paneRight = null

/** O botão de reler, para quem for wireá-lo (`router.js`, que tem o `refresh()`). */
export let refreshBtn = null

let dot = null
let tabsEl = null

/** Todo arquivo da subárvore, recursivo — o número que a aba mostra. */
const countFiles = (nodes) =>
  nodes.reduce((n, node) => n + (node.type === 'file' ? 1 : countFiles(node.children ?? [])), 0)

/**
 * As abas de origem — a única superfície que diz que existe mais de um `.scratch/`.
 *
 * **Nascem do snapshot**: não há endpoint que liste as origens; a lista é
 * `Object.keys(state.boards)`, na ordem em que os `message` do SSE chegaram — casa
 * primeiro, porque é o primeiro frame que o servidor escreve. Com uma origem só, não há
 * o que escolher e a faixa fica vazia — o board se comporta como antes de existirem
 * origens.
 *
 * `replaceChildren`, nunca `innerHTML = ''`: a faixa nova entra montada de lado e troca
 * de uma vez.
 */
export function renderTabs() {
  const names = Object.keys(state.boards)
  if (names.length < 2) return tabsEl.replaceChildren()

  tabsEl.replaceChildren(
    ...names.map((name) => {
      const board = state.boards[name]
      const bad = Boolean(board?.error)
      const n = bad ? null : countFiles(board?.tree ?? [])
      return el(`
        <a class="nstab ${name === state.active ? 'on' : ''}" href="#/${esc(name)}"
           aria-current="${name === state.active}">
          <span>${esc(name)}</span>
          ${bad ? '<b class="bad" title="falha ao ler esta origem">!</b>' : `<b>${n}</b>`}
        </a>
      `)
    }),
  )
}

const LABEL = {
  live: 'conectado — o board chega sozinho',
  retry: 'reconectando…',
  dead: 'sem conexão com o servidor — o que você vê pode estar velho',
}

/**
 * O estado da conexão vira atributo (`data-conn`); a cor e o pulso são do `shell.css`.
 * É a única coisa na tela capaz de dizer "não sei" — ver `router.js`, `connect()`.
 */
export function setConn(estado) {
  dot.dataset.conn = estado
  dot.title = LABEL[estado]
  dot.setAttribute('aria-label', LABEL[estado])
}

/** Piso da animação do botão: um giro de 20ms não é feedback, é um piscar. */
export const SPIN_MS = 420

/**
 * Monta a moldura inteira e a prende em `#app`. Chamada uma vez, no boot.
 *
 * `replaceChildren`, nunca `innerHTML = ''` — evita o frame em branco entre esvaziar e
 * preencher.
 */
export function renderShell() {
  const frame = el(`
    <div class="shell">
      <header>
        <h1><span class="dot"></span> scratch</h1>
        <nav id="ns-tabs" class="nstabs"></nav>
        <div class="spacer"></div>
        <button id="refresh" class="icon refresh" type="button"
                title="Reler o board do disco" aria-label="Reler o board do disco">⟳</button>
      </header>
      <div class="panes">
        <aside id="pane-left"></aside>
        <main id="pane-right"></main>
      </div>
    </div>
  `)
  app.replaceChildren(frame)

  dot = frame.querySelector('.dot')
  tabsEl = frame.querySelector('#ns-tabs')
  refreshBtn = frame.querySelector('#refresh')
  paneLeft = frame.querySelector('#pane-left')
  paneRight = frame.querySelector('#pane-right')

  setConn('retry') // ainda não abriu o stream: fica âmbar até o primeiro `onopen`
}

/**
 * A válvula humana: relê o board de `ns` agora, com o giro e o toast que confirmam que
 * algo aconteceu. `onRefresh` é o `router.refresh`; fica por fora para `shell.js` não
 * precisar importar `router.js` de volta.
 */
export function wireRefresh(onRefresh) {
  const nap = (ms) => new Promise((ok) => setTimeout(ok, ms))
  refreshBtn.onclick = async () => {
    refreshBtn.classList.add('spin')
    refreshBtn.disabled = true
    try {
      await Promise.all([onRefresh(), nap(SPIN_MS)])
      toast('Board relido do disco')
    } catch (err) {
      toast(`Falha ao reler: ${err.message}`)
    } finally {
      refreshBtn.disabled = false
      refreshBtn.classList.remove('spin')
    }
  }
}
