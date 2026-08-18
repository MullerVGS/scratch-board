/**
 * O visualizador de arquivo — o painel direito **fixo** (`#pane-right`) quando o alvo da
 * rota é um `type:'file'`.
 *
 * É a reforma da gaveta antiga num painel que não desliza mais sobre nada: a largura é a
 * coluna do layout, não preferência de quem olha, então saíram o `#scrim` e a alça de
 * redimensionar. O resto do comportamento migrou inteiro — e é o que faz este painel valer:
 *
 *   - **render por tipo**: `.md` chega renderizado (`md.js`); qualquer outra coisa —
 *     rascunho de agente, log, JSON — fica monoespaçada e literal;
 *   - **ao vivo**: quando o arquivo aberto muda no disco, o conteúdo troca por baixo do
 *     leitor, preservando a rolagem e com um realce para a troca não ser assombração;
 *   - **sumiço é estado, não erro**: o `404 não encontrado` vira um aviso âmbar por cima do
 *     texto, e o próximo push que reencontrar o arquivo o limpa;
 *   - **links do renderer**: link relativo navega no próprio painel, com uma trilha (`←`,
 *     ou `Esc`) para voltar; `Blocked by:` abre a issue irmã; caminho vira alvo copiável.
 *
 * A assinatura é o contrato (tarefa 03): `showFile(container, ns, node)`. `container` é o
 * `#pane-right`; `ns` é a origem; `node` é o nó de arquivo do board
 * (`{ type:'file', name, path, ref, rel, mtime, status?, title? }`). O `node.path` (caminho
 * do container) é por onde se lê o conteúdo; o `node.ref` (caminho do workspace) é o que o
 * humano copia.
 */
import { el, esc, copy, copyBtn } from './dom.js'
import { state } from './state.js'
import { renderMarkdown } from './md.js'

/**
 * A mensagem com que o `/api/file` responde `404` (`src/server.js`) quando o arquivo não
 * existe mais. É o que separa "sumiu do disco" — um fato sobre o mundo, que o painel tem que
 * saber dizer com uma frase — de um erro qualquer, que ele só sabe repetir. **É a string que
 * o servidor responde**: traduzir uma sem a outra devolve o erro cru (há teste).
 */
const MISSING = 'não encontrado'

/**
 * A sessão de leitura: o `#pane-right`, a origem, e o `path` da **rota** — o arquivo que o
 * `app.js` desenha. `bar`/`doc` são os dois nós fixos do painel (a barra do topo e o corpo
 * rolável), guardados para a troca ao vivo mexer só no corpo, sem reconstruir a moldura.
 */
let open = null

/**
 * O que está **na tela agora** — a rota, ou um alvo aberto por um link de dentro do
 * documento (a trilha). É o `current.path` que o `changed` do push compara, e ele pode diferir
 * do `open.basePath` enquanto a trilha estiver ativa.
 */
let current = null

/** Onde o painel esteve: seguir um link sem poder voltar trocaria o contexto que você tinha. */
const trail = []

/**
 * O conteúdo que está na tela — **a supressão do painel**, o análogo exato do hash do
 * `cache.js` um andar abaixo: relido e byte-idêntico, não se troca nada, não se mexe na
 * rolagem e não se acende o realce. Existe porque nem todo push sabe dizer *o que* mudou.
 */
let shown = null

/** Um alvo de link que não está na árvore (aponta para fora do projetado): o `ref` é o próprio caminho. */
const synthNode = (p) => ({ name: p.slice(p.lastIndexOf('/') + 1), path: p, ref: p })

/** Acha um nó pelo `path` do container, em qualquer profundidade — a árvore não é plana. */
function findByPath(nodes, p) {
  if (!nodes) return null
  for (const n of nodes) {
    if (n.path === p) return n
    if (n.type === 'dir') {
      const hit = findByPath(n.children, p)
      if (hit) return hit
    }
  }
  return null
}

/**
 * Os arquivos irmãos — os da mesma pasta-pai do arquivo aberto. É contra eles que um
 * `Blocked by: 04` resolve: as referências de bloqueio são locais à pasta (mesma regra do
 * grafo). Se o pai é a raiz da origem, os irmãos são os nós de topo da árvore.
 */
function siblingFiles(board, path) {
  if (!board?.tree) return []
  const dir = path.slice(0, path.lastIndexOf('/'))
  const folder = dir === board.root ? { children: board.tree } : findByPath(board.tree, dir)
  return (folder?.children ?? []).filter((n) => n.type === 'file')
}

/** O número que abre o nome de um arquivo, sem zeros à esquerda (`01-um.md` → `1`). */
const leadingNum = (name) => {
  const m = /^0*(\d+)/.exec(String(name))
  return m ? m[1] : null
}
/** `Blocked by: 04` casa com `04-x.md`, `4-x.md` e `04.md` — o número, não os zeros. */
const matchesNumber = (name, n) => leadingNum(name) !== null && leadingNum(name) === leadingNum(n)

/**
 * Dá comportamento aos alvos que o `md.js` só **marcou** (`data-ref`, `data-issue`,
 * `data-open`) — resolver é aqui, porque quem tem a árvore na mão é o cliente. Roda depois de
 * **todo** render, inclusive a troca ao vivo: sem esta linha o conteúdo novo seria um
 * documento bonito e morto.
 */
function wireRefs(doc) {
  const board = state.boards[open.ns]
  const path = current.path

  // Caminho de arquivo: clicar copia. Copia-se o que se lê.
  for (const b of doc.querySelectorAll('.ref')) {
    const ref = b.dataset.ref
    b.onclick = () => {
      copy(ref, 'Copiado: caminho')
      b.classList.add('done')
      clearTimeout(b.timer)
      b.timer = setTimeout(() => b.classList.remove('done'), 1400)
    }
  }

  // `Blocked by: 04` → o arquivo irmão que abre com `04`. Sem alvo, não é link: o número
  // vira texto, em vez de um botão que mente.
  const siblings = siblingFiles(board, path)
  for (const b of doc.querySelectorAll('.issueref')) {
    const n = b.dataset.issue
    const target = siblings.find((f) => matchesNumber(f.name, n))
    if (!target) {
      b.replaceWith(el(`<code>${esc(n)}</code>`))
      continue
    }
    if (target.status) b.dataset.s = target.status
    b.title = `Abrir ${target.name}${target.status ? ` — ${target.status}` : ''}`
    b.onclick = () => navTo(target)
  }

  // Link relativo (`../review-01.md`) → abre o alvo no próprio painel, com trilha de volta.
  const dir = path.slice(0, path.lastIndexOf('/'))
  for (const b of doc.querySelectorAll('.doclink')) {
    const targetPath = decodeURIComponent(new URL(b.dataset.open, `file://${dir}/`).pathname)
    const node = findByPath(board?.tree, targetPath) ?? synthNode(targetPath)
    b.onclick = () => navTo(node)
  }
}

/**
 * Monta a moldura do painel — a barra do topo (a trilha e o caminho copiável) e o corpo
 * rolável. Chamada em toda pintura de abertura/navegação; a troca ao vivo **não** a chama,
 * para não perder a rolagem que o `render()` acabou de guardar.
 */
function buildShell() {
  const bar = el('<div class="viewer-bar"></div>')

  const back = el(
    '<button type="button" class="icon back" aria-label="Voltar (Esc)" title="Voltar (Esc)">←</button>',
  )
  back.hidden = trail.length === 0
  back.onclick = goBack
  bar.append(back)

  // O `ref` na barra é copiável e é o que identifica o arquivo (o texto na tela é o texto no
  // clipboard). Um alvo fora da árvore não tem `ref` de workspace: cai no próprio caminho.
  const ref = current.node?.ref ?? current.node?.path ?? current.path
  bar.append(copyBtn(ref, 'caminho', ref))

  const doc = el('<div class="viewer-doc"></div>')
  open.container.replaceChildren(bar, doc)
  open.bar = bar
  open.doc = doc
}

/**
 * O arquivo aberto sumiu do disco. Numa troca ao vivo o texto **fica**, com o aviso por cima
 * dizendo o que ele é — a última leitura de um arquivo que não existe mais; jogá-lo fora
 * puniria quem lia pelo que o agente fez. Numa abertura não há nada a preservar, e o aviso
 * sozinho é o próprio estado vazio. Não é terminal: se o arquivo voltar, o push seguinte
 * re-renderiza e o aviso vai junto.
 */
function markGone(doc, ref, live) {
  if (!live) {
    doc.replaceChildren()
    open.container.classList.remove('md', 'raw')
  }
  if (doc.querySelector('.gone')) return // já avisado; não empilhar avisos
  doc.prepend(
    el(`
      <div class="gone">
        <strong>O arquivo sumiu do disco.</strong>
        <span>Removido ou renomeado enquanto você o lia.</span>
        <code>${esc(ref)}</code>
      </div>
    `),
  )
}

/**
 * Quem de fato rola o documento. O `#pane-right` é a coluna do layout e não a gaveta fixa
 * de antes: quando o conteúdo cabe, quem rola é a página inteira (a moldura cresce com o
 * documento); quando ele estoura a própria caixa (tela estreita, painel com altura travada),
 * quem rola é o painel. Preservar a rolagem "certa" é preservar a de quem realmente rola —
 * senão a troca ao vivo joga o leitor de volta ao topo, que é o pecado que o painel vivo
 * existe para não cometer.
 */
function scroller() {
  const p = open.container
  return p.scrollHeight > p.clientHeight + 1 ? p : document.scrollingElement || document.documentElement
}

/**
 * Um realce curto no corpo, e só quando o conteúdo trocou sozinho. Como a rolagem é
 * preservada, a troca é invisível — o parágrafo sob os olhos continua no lugar, com outro
 * texto —, e este realce é a *única* pista de que ela aconteceu.
 */
function flash(elm) {
  elm.classList.remove('swapped')
  void elm.offsetWidth // reinicia a animação quando dois pushes chegam colados
  elm.classList.add('swapped')
  elm.addEventListener('animationend', () => elm.classList.remove('swapped'), { once: true })
}

/**
 * Lê o `current` e o desenha no corpo.
 *
 * `live` é a troca por baixo do leitor — o mesmo alvo, relido porque o disco mudou. Ela reusa
 * esta função inteira de propósito: o `wireRefs()` corre de novo no conteúdo novo, e o
 * `Blocked by:`, o caminho copiável e o link relativo continuam vivos depois da troca sem que
 * ninguém tenha que lembrar.
 */
async function render(live) {
  const { path, node } = current
  const isMd = path.endsWith('.md')

  // Na abertura (ou se a moldura foi substituída por outra tela e voltou), reconstrói e trata
  // como pintura do zero. Ao vivo, a moldura fica: só o corpo muda.
  if (!live || !open.doc?.isConnected) {
    buildShell()
    live = false
  }
  const doc = open.doc

  // **A rolagem, que é o ponto todo.** Guardar aqui e repor no fim torna a troca invisível.
  // Na abertura, `0` é o topo — o caso particular de um documento ainda não rolado.
  const top = live ? scroller().scrollTop : 0
  if (!live) {
    open.container.classList.remove('md', 'raw')
    doc.textContent = 'carregando…'
    scroller().scrollTop = 0
  }

  let res, text
  try {
    res = await fetch(`/api/file?path=${encodeURIComponent(path)}`)
    text = await res.text()
  } catch (err) {
    shown = null
    open.container.classList.remove('md')
    open.container.classList.add('raw')
    doc.textContent = `erro: ${err.message}`
    return
  }

  // Sumiço: o corpo é a string `MISSING`, e ele é âmbar por cima do texto, não erro.
  if (res.status === 404 && text === MISSING) {
    shown = null
    markGone(doc, node?.ref ?? path, live)
    return
  }
  // `413` (grande demais para exibir) e qualquer outro erro: o corpo cru, literal, sem realce.
  if (!res.ok) {
    shown = null
    open.container.classList.remove('md')
    open.container.classList.add('raw')
    let msg = text
    if (res.headers.get('content-type')?.includes('json')) {
      try {
        msg = JSON.parse(text).error ?? text
      } catch {
        /* corpo não era JSON — fica o texto cru */
      }
    }
    doc.textContent = msg
    return
  }

  // **A supressão.** Relido e byte-idêntico ao que já está na tela: não há o que trocar, e
  // trocar mesmo assim custaria um piscar e um realce mentindo que alguém escreveu algo.
  if (live && text === shown) return
  shown = text

  if (isMd) {
    open.container.classList.add('md')
    open.container.classList.remove('raw')
    doc.innerHTML = renderMarkdown(text)
    wireRefs(doc)
  } else {
    open.container.classList.add('raw')
    open.container.classList.remove('md')
    doc.textContent = text
  }

  scroller().scrollTop = top
  if (live) flash(open.container)
}

/** Seguir um link de dentro do documento: empilha a volta e abre o alvo do zero (topo). */
function navTo(node) {
  if (current) trail.push(current)
  current = { path: node.path, node }
  shown = null
  render(false)
}

/** Voltar pela trilha. Painel fixo: sem trilha, não há para onde voltar — não faz nada. */
function goBack() {
  const prev = trail.pop()
  if (!prev) return
  current = prev
  shown = null
  render(false)
}

/**
 * Liga o painel aos dois eventos do fio — **uma vez**. Com o `mtime` no hash, o save normal
 * chega por `board:push`; o `file:push` é o caso estreito de conteúdo reescrito sem mover o
 * `mtime`. O painel escuta os **dois** e olha o `changed` de cada um.
 *
 * O `app.js` também redesenha o painel a cada `board:push` da origem ativa (chamando de novo
 * o `showFile`), mas o `showFile` reconhece a mesma rota e não faz nada — é este ouvinte que
 * faz a troca do corpo, preservando a rolagem. Registrado depois do ouvinte do `app.js` (na
 * primeira chamada de `showFile`), corre depois dele: o nó já chegou fresco.
 */
let installed = false
function installLive() {
  if (installed) return
  installed = true

  const onPush = (ev) => {
    if (!open || !current || !open.doc?.isConnected) return
    const changed = ev.detail?.changed
    // Lista com itens que não incluem o aberto: não me afeta. **Lista vazia = "não sei o que
    // mudou"** (varredura de segurança, reconexão) → relê no escuro, e o `shown` decide se há
    // algo a trocar. Tratar `[]` como "não me afeta" seria acreditar no silêncio.
    if (changed?.length && !changed.includes(current.path)) return
    render(true)
  }

  addEventListener('board:push', onPush)
  addEventListener('file:push', onPush)
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && trail.length) {
      e.preventDefault()
      goBack()
    }
  })
}

/**
 * O contrato da tarefa 03. Chamada pelo `app.js`: na navegação de verdade (arquivo novo na
 * rota), abre do zero e zera a trilha; na re-renderização da **mesma** rota (um `board:push`
 * da origem ativa, ou o botão de reler), não mexe no corpo nem na rolagem — o ouvinte ao vivo
 * é quem troca —, só guarda o nó fresco (status/título podem ter mudado) para a próxima
 * pintura da moldura.
 */
export function showFile(container, ns, node) {
  installLive()

  if (open && open.container === container && node.path === open.basePath && open.doc?.isConnected) {
    open.node = node
    if (current && current.path === open.basePath) current.node = node
    return
  }

  open = { container, ns, basePath: node.path, node, bar: null, doc: null }
  current = { path: node.path, node }
  shown = null
  trail.length = 0
  render(false)
}
