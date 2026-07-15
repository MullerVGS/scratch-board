/**
 * O roteador: o hash decide a tela — e a **origem** é a primeira coisa que ele diz.
 *
 * `#/<ns>` é a visão geral daquela origem, `#/<ns>/-/gantt[/<expandidos>...]` o Gantt global,
 * `#/<ns>/<slug>` o kanban de um esforço, `#/<ns>/<slug>/grafo` o grafo e
 * `#/<ns>/<slug>/gantt` o Gantt filtrado, com `archive/` na frente quando o esforço já foi
 * encerrado. `#/pads` são os scratchpads, e eles ficam **fora**
 * das origens: são rascunho global de sessão, não tracker de repositório nenhum.
 *
 * **Toda rota é qualificada, e não há rota legada sem origem.** Um `#/x` em que `x` não é
 * uma origem conhecida cai na origem de casa — o hash não fica pela metade, e dois esforços
 * com o mesmo slug em origens diferentes nunca disputam a mesma URL.
 *
 * A visão do esforço vive no hash de propósito: é onde já vive o resto da navegação, e
 * assim ela é colável.
 */
import { api, el, esc } from './dom.js'
import { state } from './state.js'
import { view, crumbs, tally, bindConnection, renderTabs } from './shell.js'
import { renderOverview } from './overview.js'
import { renderEffort } from './effort.js'
import { renderGlobalGantt } from './gantt.js'
import { renderPads } from './pads.js'

const parts = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)

/** A origem que está na tela agora — ou `null` nos scratchpads, que não têm origem. */
export function activeNs() {
  const [first] = parts()
  if (!first || first === 'pads') return null
  return state.namespaces.includes(first) ? first : null
}

/** Nenhuma origem montada. Não é um erro do board: é o compose que não montou nada. */
function renderNothing() {
  renderTabs(null)
  crumbs.replaceChildren()
  tally.textContent = ''
  view.replaceChildren(
    el(`<p class="empty">Nenhuma origem montada. O compose não montou nenhum <code>.scratch/</code>.</p>`),
  )
}

export function route() {
  const seg = parts()

  if (seg[0] === 'pads') {
    renderTabs(null)
    return renderPads().catch((err) => {
      view.replaceChildren(el(`<p class="empty">Falha ao ler os scratchpads: ${esc(err.message)}</p>`))
    })
  }

  const names = state.namespaces
  if (!names.length) return renderNothing()

  // Sem origem no hash, ou com uma que não existe: vai para a de casa. A troca do hash
  // dispara o `hashchange`, e este `route()` roda de novo já qualificado.
  const ns = names.includes(seg[0]) ? seg[0] : null
  if (!ns) {
    location.hash = `#/${names[0]}`
    return
  }

  renderTabs(ns)

  let rest = seg.slice(1)
  const archived = rest[0] === 'archive'
  if (archived) rest = rest.slice(1)

  // A frota inteira. Os segmentos seguintes são as identidades dos esforços expandidos;
  // ficam no hash para a mesma abertura continuar colável.
  if (!archived && rest[0] === '-' && rest[1] === 'gantt') {
    const expanded = rest.slice(2).map((id) => {
      try {
        return decodeURIComponent(id)
      } catch {
        return id
      }
    })
    return renderGlobalGantt(ns, expanded)
  }

  const slug = rest[0]
  if (!slug) return renderOverview(ns)

  renderEffort(ns, slug, archived, rest[1])
}

/** Relê **todas** as origens do servidor e redesenha a tela atual. */
export async function refresh() {
  const { namespaces, boards } = await api('/api/board')
  state.namespaces = namespaces
  state.boards = boards
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
 * **Uma conexão, N origens.** Cada evento diz de qual origem fala (`ns`) e carrega só o
 * board dela. Guardar o board novo é sempre; **redesenhar, só se a origem for a que está na
 * tela** — uma escrita no `vend-server` não pode repintar o `projetos` que você está lendo.
 * A origem inativa fica pronta, calada, e aparece atualizada quando você troca de aba. (A
 * aba em si se atualiza: o `renderTabs()` relê as contagens, e é a única pista visível de
 * que a outra origem andou.)
 *
 * O `EventSource` reconecta sozinho, e na reconexão o servidor manda **cada origem,
 * inteira** — um restart do container se cura sem F5.
 *
 * Mas push que morre, morre **calado**: um servidor no chão e um board parado emitem o
 * mesmo nada. Por isso o `source` vai para o `shell.js` — é o cabeçalho que conta se a
 * conexão ainda está de pé, e é ele que oferece o botão de reler quando ela não está.
 */
export function connect() {
  const source = new EventSource('/api/stream')

  bindConnection(source, refresh)

  source.onmessage = (ev) => {
    const { ns, board, changed } = JSON.parse(ev.data)
    state.boards[ns] = board
    if (ns === activeNs()) route()
    else renderTabs(activeNs()) // a origem inativa andou: a aba dela diz isso, e nada mais se mexe
    // Quem mexeu no disco. O board não precisa (ele vem inteiro), mas a gaveta precisa
    // saber se o documento que está aberto é justamente o que o agente acabou de escrever —
    // e o documento aberto pode ser de outra origem que não a da tela.
    dispatchEvent(new CustomEvent('board:push', { detail: { ns, changed } }))
  }

  // O disco mexeu e o board **não** — que é o caso mais comum de todos, porque o board
  // projeta `Status:`, título e `Blocked by:`, e nada do corpo. Escrever a `## Answer` de
  // uma issue não move um pixel da tela do board, mas move o documento que você está lendo.
  //
  // O evento `files` traz **só os caminhos** (nem o board, nem um diff dele) e é publicado
  // no mesmo `board:push`: a gaveta escuta esse evento, olha o `changed`, e não lhe importa
  // qual dos dois frames o produziu. Aqui não se chama `route()` — o board não mudou, e
  // redesenhar a tela sem motivo é a doença que o push veio curar.
  source.addEventListener('files', (ev) => {
    dispatchEvent(new CustomEvent('board:push', { detail: JSON.parse(ev.data) }))
  })

  return source
}
