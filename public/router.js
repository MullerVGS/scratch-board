/**
 * O roteador: o hash decide a **origem** e o alvo dentro dela — `#/<ns>/<rel...>`, onde
 * `rel` é o caminho relativo à raiz da origem (a chave de rota que `src/tree.js` embute em
 * cada nó). `#/` nu vai para a origem de casa — a primeira que chegou pelo snapshot do SSE.
 *
 * **Não há endpoint que liste as origens.** `/api/board` é per-`ns`; a lista sai das
 * chaves de `state.boards`, conforme os `message` do snapshot as vão preenchendo — um por
 * origem, casa primeiro. Por isso `route()` também é quem resolve `state.active`: ele só
 * sabe repontar para a de casa depois que ao menos um board chegou, e uma origem citada no
 * hash que ainda não chegou fica **em espera** em vez de ser tratada como inexistente — o
 * próximo `message` chama `route()` de novo e tenta resolver de novo.
 */
import { api } from './dom.js'
import { state } from './state.js'
import { setConn, renderTabs, wireRefresh } from './shell.js'

const segs = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)

/** A origem que está na tela agora, ou `null` enquanto nenhum board chegou. */
export function activeNs() {
  return state.active
}

/** O `rel` do alvo dentro da origem ativa — `''` na raiz (`#/<ns>` sozinho). */
export function activeRel() {
  const [, ...rest] = segs()
  return rest.join('/')
}

/**
 * Lê o hash e decide `state.active`.
 *
 * `#/` nu (sem `ns`) repõe para a origem de casa assim que ela é conhecida. Um `ns`
 * qualificado só vira `state.active` se já estiver em `state.boards` — senão a função
 * não mexe no hash (pode ser uma origem que ainda está a caminho no snapshot) e sai sem
 * decidir nada, deixando `state.active` como estava.
 *
 * Sempre redesenha a fileira de abas: é o único efeito colateral fora do `state.active`.
 */
export function route() {
  const [ns] = segs()
  const known = Object.keys(state.boards)

  if (!ns) {
    if (known.length) {
      state.active = known[0]
      location.hash = `#/${known[0]}`
    }
  } else if (known.includes(ns)) {
    state.active = ns
  }

  renderTabs()
}

/** Relê **uma** origem do servidor — a válvula humana (botão de reler). */
export async function refresh(ns) {
  const board = await api(`/api/board?ns=${encodeURIComponent(ns)}`)
  state.boards[ns] = board
  dispatchEvent(new CustomEvent('board:push', { detail: { ns, board, changed: [] } }))
}

/** Quanto tempo tentando reconectar antes de admitir que o servidor não está lá. */
const DEAD_MS = 6000

/**
 * Abre o `EventSource` de `/api/stream` e liga o indicador de conexão + o botão de reler.
 *
 * **A contagem até o vermelho corre desde o último `open`, não desde o último erro.** O
 * `EventSource` erra a cada tentativa de reconexão (`retry: 2000`); rearmar o relógio a
 * cada erro deixaria o pontinho âmbar para sempre — uma forma mais educada da mesma
 * mentira. E, uma vez vermelho, ele só volta ao verde no `onopen` — voltar a âmbar a cada
 * tentativa piscaria de dois em dois segundos. Este bug existiu; foi o navegador que o
 * denunciou.
 *
 * `message` = `{ns, board, changed}`: guarda o board e publica `board:push`. `files` =
 * `{ns, changed}`: publica `file:push` — o disco mudou e a árvore não (conteúdo reescrito
 * com o `mtime` preservado). O `changed` viaja nos dois porque, com o `mtime` no hash, o
 * save normal (que move o `mtime`) chega por `message` — é dele que o viewer tira "o que
 * mudou" na maioria das vezes.
 */
export function connect() {
  wireRefresh(() => {
    const ns = activeNs()
    return ns ? refresh(ns) : Promise.resolve()
  })

  const source = new EventSource('/api/stream')
  let deadTimer = null
  let dead = false

  const die = () => {
    clearTimeout(deadTimer)
    deadTimer = null
    dead = true
    setConn('dead')
  }

  source.onopen = () => {
    clearTimeout(deadTimer)
    deadTimer = null
    dead = false
    setConn('live')
  }

  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) return die()
    if (dead) return
    setConn('retry')
    deadTimer ??= setTimeout(die, DEAD_MS)
  }

  source.onmessage = (ev) => {
    const { ns, board, changed } = JSON.parse(ev.data)
    state.boards[ns] = board
    // `route()` primeiro: é ele que resolve `state.active` quando esta é a origem que o
    // hash está esperando (a de casa, ou uma citada direto na URL de uma carga a frio).
    // `dispatchEvent` depois, para que quem ouve `board:push` e compara `ns === activeNs()`
    // (`app.js`) veja o `state.active` já resolvido — na ordem inversa, a própria origem
    // que acabou de resolver a rota nunca bate a comparação, e a tela nasce em branco.
    route()
    dispatchEvent(new CustomEvent('board:push', { detail: { ns, board, changed } }))
  }

  source.addEventListener('files', (ev) => {
    const { ns, changed } = JSON.parse(ev.data)
    dispatchEvent(new CustomEvent('file:push', { detail: { ns, changed } }))
  })

  return source
}
