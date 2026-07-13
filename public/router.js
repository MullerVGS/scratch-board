/**
 * O roteador: o hash decide a tela.
 *
 * `#/` é a visão geral, `#/pads` os scratchpads, `#/<slug>` o kanban do esforço e
 * `#/<slug>/grafo` o grafo — com `archive/` na frente quando o esforço já foi
 * encerrado. A visão do esforço vive no hash de propósito: é onde já vive o resto da
 * navegação, e assim ela é colável.
 */
import { api, esc } from './dom.js'
import { state } from './state.js'
import { view } from './shell.js'
import { renderOverview } from './overview.js'
import { renderEffort } from './effort.js'
import { renderPads } from './pads.js'

export function route() {
  const hash = location.hash.replace(/^#\/?/, '')
  if (!hash) return renderOverview()
  if (hash === 'pads') {
    return renderPads().catch((err) => {
      view.innerHTML = `<p class="empty">Falha ao ler os scratchpads: ${esc(err.message)}</p>`
    })
  }
  const archived = hash.startsWith('archive/')
  let slug = archived ? hash.slice('archive/'.length) : hash
  const graph = slug.endsWith('/grafo')
  if (graph) slug = slug.slice(0, -'/grafo'.length)
  renderEffort(slug, archived, graph)
}

/** Relê o board do servidor e redesenha a tela atual. */
export async function refresh() {
  state.board = await api('/api/board')
  route()
}

/**
 * O push: o board deixa de perguntar e passa a ser avisado.
 *
 * Antes, um `setInterval` de 5 segundos perguntava ao disco se algo tinha mudado — 720
 * vezes por hora, 63 mil leituras de `.md`, e um re-render total a cada volta, com ou sem
 * novidade. Agora quem fala é o servidor, e ele só fala quando o board **mudou de fato**
 * (ele compara o hash do payload antes de emitir). A tela só se redesenha por um motivo
 * verdadeiro.
 *
 * O evento carrega o board **inteiro**, não um tick nem um diff: o estado é calculado num
 * lugar só, e assim o cliente não consegue derivar para um estado que o disco não tem.
 *
 * O `EventSource` reconecta sozinho, e na reconexão o servidor manda o board inteiro — um
 * restart do container se cura sem F5.
 */
export function connect() {
  const source = new EventSource('/api/stream')

  source.onmessage = (ev) => {
    const { board, changed } = JSON.parse(ev.data)
    state.board = board
    route()
    // Quem mexeu no disco. O board não precisa (ele vem inteiro), mas a gaveta precisa
    // saber se o documento que está aberto é justamente o que o agente acabou de escrever.
    dispatchEvent(new CustomEvent('board:push', { detail: { changed } }))
  }

  return source
}
