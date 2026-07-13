/**
 * A gaveta: onde você lê o documento e decide o que fazer com ele — com a trilha de
 * volta, o redimensionamento, e **viva**.
 *
 * O `.md` chega **renderizado** (`md.js`); o que não é markdown — rascunho de agente,
 * log, JSON — continua monoespaçado e literal.
 *
 * **Viva** quer dizer: quando o arquivo aberto muda no disco, o conteúdo é trocado por
 * baixo de você. É o caso de uso que motiva o push inteiro — o agente está escrevendo o
 * ticket que você está lendo, e antes disto a gaveta era um retrato do instante em que
 * você a abriu: para ver o que mudou, fechava e reabria.
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
 * O conteúdo que está na tela agora — **a supressão da gaveta**, e o análogo exato do hash
 * do `cache.js`: relido e byte-idêntico, não se troca nada.
 *
 * Ela existe porque nem todo push sabe dizer *o que* mudou. A varredura de segurança do
 * servidor empurra com a lista vazia (ela repesca o que o `fs.watch` perdeu — e quem
 * perdeu o evento não sabe qual era), e o snapshot de reconexão também. Nesses casos a
 * gaveta relê no escuro, e é este `shown` que a impede de piscar à toa.
 */
let shown = null

/**
 * A mensagem com que o `/api/file` responde 404 (`src/server.js`) quando o arquivo não
 * existe mais. É o que separa "sumiu do disco" — um fato sobre o mundo, que a gaveta tem
 * que saber dizer — de um erro qualquer, que ela só sabe repetir.
 */
const MISSING = 'não encontrado'

/**
 * A moldura: sobrancelha, título, o `←` da trilha e a barra de ações.
 *
 * Ela sai do **board**, não do arquivo — e o board envelhece. O `eyebrow` carrega o status
 * (`07 · claimed`) e o comando que destrava o ticket depende dele: numa troca ao vivo,
 * repintar só o corpo deixaria um documento `resolved` sob um cabeçalho `claimed`, e a
 * gaveta estaria se contradizendo na mesma tela.
 */
function paintFrame({ eyebrow, title, ref, prompts = [] }) {
  document.getElementById('drawer-eyebrow').textContent = eyebrow
  const head = document.getElementById('drawer-title')
  head.textContent = title
  if (ref) head.append(copyBtn(title, 'título'))

  document.getElementById('drawer-back').hidden = !trail.length

  const actions = document.getElementById('drawer-actions')
  actions.innerHTML = ''
  if (ref) actions.append(copyBtn(ref, 'caminho', ref))
  const strip = promptStrip(prompts)
  if (strip) actions.append(strip)
  actions.hidden = !actions.childElementCount
}

/**
 * As opções da gaveta, recalculadas contra o board que **acabou de chegar**.
 *
 * O `opts` foi montado quando você abriu a gaveta, e congelou o board daquele instante. Se
 * o push existe, é porque o board mudou — e o status da issue aberta é justamente o que
 * costuma ter mudado. Sem isto, o `Blocked by:` do documento também resolveria contra a
 * lista velha de issues, e um bloqueio recém-fechado continuaria vermelho.
 *
 * Documento solto (um `map.md`, um `.txt` seguido por link) não tem issue de onde tirar
 * `eyebrow` e comando: só o `effort` é renovado, para o `wireRefs()` resolver contra o
 * board de agora.
 */
function freshOpts(path, opts) {
  const slug = opts.effort?.slug
  if (!slug) return opts

  const pool = opts.archived ? state.board.archived : state.board.efforts
  const effort = pool?.find((e) => e.slug === slug)
  if (!effort) return opts // o esforço sumiu do board; o que temos é o que temos

  const issue = effort.issues.find((i) => i.path === path)
  if (!issue) return { ...opts, effort }

  return {
    eyebrow: `${effort.slug} · ${issue.number} · ${issue.status}`,
    title: cleanTitle(issue),
    ref: issue.ref,
    prompts: issuePrompts(issue, effort, opts.archived),
    effort,
    archived: opts.archived,
  }
}

/**
 * O arquivo aberto sumiu do disco.
 *
 * `ENOENT` cru não é uma frase. E jogar fora o que estava na tela seria punir você pelo
 * que o agente fez: numa troca ao vivo o texto **fica**, com o aviso por cima dizendo o
 * que ele é — a última leitura de um arquivo que não existe mais. Numa abertura não há
 * nada a preservar, e o aviso sozinho é o próprio estado vazio.
 *
 * Não é terminal: se o arquivo voltar (um `rename` é um sumiço seguido de um
 * nascimento), o push seguinte re-renderiza e o aviso vai embora com ele.
 */
function markGone(body, ref, live) {
  if (!live) body.replaceChildren()
  if (body.querySelector('.gone')) return // já avisado; não empilhar avisos
  body.prepend(
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
 * A gaveta é o lugar onde você decide o que fazer com um arquivo — então é onde
 * o comando e o caminho precisam estar à mão, junto com o texto que os motivou.
 *
 * O `.md` chega renderizado, não cru: é um documento para ler, e o cabeçalho, as
 * tabelas e os caminhos dizem mais quando têm forma. O que não é markdown (rascunho
 * de agente, log, JSON) continua monoespaçado e literal.
 *
 * `live` é a troca por baixo de você — o mesmo caminho, relido porque o disco mudou.
 * É de propósito que ela reusa esta função inteira em vez de escrever HTML na mão: o
 * `wireRefs()` corre de novo no conteúdo novo, e o `Blocked by:`, o caminho copiável e
 * o link relativo continuam vivos depois da troca sem que ninguém tenha que lembrar.
 */
async function render(path, opts, live = false) {
  const { ref, effort = null, archived = false } = opts
  current = { path, opts }

  const body = document.getElementById('drawer-body')

  // **A rolagem, que é o ponto todo.** Sem ela a gaveta viva é *pior* que a gaveta morta:
  // o agente salva no meio do seu parágrafo e você é jogado de volta ao topo. Guardar
  // aqui e repor no fim é o que torna a troca invisível — você continua exatamente onde
  // estava, e só o texto sob os seus olhos ficou mais novo.
  //
  // Na abertura, `0` é o topo, que é o que se quer. A linha que zerava o `scrollTop`
  // incondicionalmente vira, então, o caso particular de um documento ainda não rolado.
  const top = live ? body.scrollTop : 0

  // A moldura e o "carregando…" são da abertura. Ao vivo, **nada** se mexe antes de o
  // conteúdo novo chegar: um placeholder colapsaria a altura do corpo, e a rolagem que
  // acabamos de guardar não teria para onde voltar.
  if (!live) {
    paintFrame(opts)
    body.textContent = 'carregando…'
    body.classList.remove('md')
    body.scrollTop = 0
    drawer.hidden = scrim.hidden = false
    // No celular a gaveta é a tela inteira: rolar o board por trás dela é rolar o que não
    // se vê. No desktop a regra não se aplica — o board continua visível ao lado.
    document.body.classList.add('locked')
  }

  let content
  try {
    ;({ content } = await api(`/api/file?path=${encodeURIComponent(path)}`))
  } catch (err) {
    shown = null
    if (err.message === MISSING) markGone(body, ref ?? path, live)
    else body.textContent = `erro: ${err.message}`
    return
  }

  // **A supressão da gaveta.** Um push pode chegar sem saber *o que* mudou (a varredura de
  // segurança, o snapshot de reconexão), e aí a gaveta relê no escuro. Se o que voltou é
  // byte-a-byte o que já está na tela, não há o que trocar — e trocar mesmo assim custaria
  // um piscar e um realce mentindo que alguém escreveu algo. É o mesmo raciocínio do hash
  // do `cache.js`, um andar abaixo: **relê sempre, redesenha só por um motivo verdadeiro.**
  if (live && content === shown) return
  shown = content

  // Ao vivo o board também chegou novo, e a moldura sai dele. Aqui — depois da supressão —
  // porque conteúdo idêntico é status idêntico: o `Status:` que a moldura mostra foi lido
  // deste mesmo arquivo.
  if (live) paintFrame(opts)

  if (path.endsWith('.md')) {
    body.classList.add('md')
    body.innerHTML = renderMarkdown(content)
    // O renderer só **marca** os alvos; quem os liga é isto. O `innerHTML` acabou de jogar
    // fora os `onclick` do conteúdo velho — sem esta linha a gaveta viva devolveria um
    // documento bonito e morto.
    wireRefs(body, path, effort, archived)
  } else {
    body.classList.remove('md')
    body.textContent = content
  }

  body.scrollTop = top
  if (live) flash(body)
}

/**
 * Um realce curto no corpo, e só quando o conteúdo trocou sozinho.
 *
 * Conteúdo que muda debaixo do olho sem nada dizer é assombração. O realce é a única
 * diferença entre "o documento mudou" e "eu enlouqueci" — e como a rolagem é preservada,
 * ele é a *única* pista de que a troca aconteceu.
 */
function flash(body) {
  body.classList.remove('swapped')
  void body.offsetWidth // reinicia a animação quando dois pushes chegam colados
  body.classList.add('swapped')
  // E sai quando acaba: uma classe que fica pendurada para sempre é o DOM mentindo que a
  // troca acabou de acontecer — e foi o probe deste ticket que tropeçou nela.
  body.addEventListener('animationend', () => body.classList.remove('swapped'), { once: true })
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
  shown = null
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

  // ---------- a gaveta viva ----------
  //
  // O `router.js` publica cada push do servidor aqui, com os caminhos que mexeram no
  // disco (`src/watch.js` os acumula; `src/server.js` os manda no envelope do evento).
  // Eles vêm no vocabulário do container — `/workspace/.scratch/...` —, que é o mesmo do
  // `current.path`: a comparação é direta, sem tradução.
  //
  // **A chegada do evento não basta.** Ele vem de qualquer mudança no `.scratch/`, e quase
  // nenhuma é no arquivo que você tem aberto. É o `changed` que decide — sem ele, qualquer
  // agente salvando qualquer coisa re-renderizaria a sua gaveta.
  //
  // **Lista vazia é o caso interessante, e ela não quer dizer "nada mudou": quer dizer
  // "não sei o que mudou".** É assim que empurra a varredura de segurança do servidor — a
  // rede que existe justamente porque o `fs.watch` pode ter morrido, e quem perdeu o
  // evento não tem como saber qual era o caminho. É assim, também, que chega o snapshot de
  // reconexão, depois de um restart do container em que o disco pode ter andado sem
  // ninguém olhando.
  //
  // Nos dois casos, tratar `[]` como "não me afeta" seria a gaveta **escolhendo acreditar
  // no silêncio** — e silêncio indistinguível de "nada mudou" é exatamente a doença que
  // este esforço inteiro está curando. Então ela relê no escuro, e quem decide se há algo a
  // trocar é a supressão por conteúdo do `render()`: idêntico, ninguém pisca.
  addEventListener('board:push', (ev) => {
    if (!current) return // gaveta fechada: não há o que trocar
    const changed = ev.detail?.changed
    if (changed?.length && !changed.includes(current.path)) return
    render(current.path, freshOpts(current.path, current.opts), true)
  })

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
