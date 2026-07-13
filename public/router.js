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
