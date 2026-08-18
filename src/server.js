// Só HTTP: rotas, estáticos, o stream SSE e a contenção dos caminhos que chegam do cliente.
//
// O que a árvore *é* mora ao lado — `tree.js` monta a projeção de uma origem, `cache.js`
// guarda a árvore de cada origem e decide se ela mudou, `watch.js` escuta o disco, `paths.js`
// descobre as origens, `../shared/parse.js` entende o dialeto dos `.md`. Aqui só se responde.
//
// O board **não pergunta mais** ao disco a cada 5 segundos: ele é avisado. O watcher emite,
// o cache suprime o que não mudou, e o que sobra desce por `/api/stream` para quem estiver
// olhando — a árvore inteira, num evento, calculada num lugar só. Um diff foi rejeitado
// porque exigiria uma máquina de merge no cliente, que pode divergir do disco: é
// exatamente o pecado que o board existe para não cometer.
//
// **N origens, uma conexão.** Cada namespace tem watcher, hash, digest e árvore próprios —
// mas o browser abre **um** `EventSource`, e cada evento diz de que origem veio (`ns`) e
// carrega **só a árvore daquela origem**. Mandar todas as origens em todo evento seria pagar
// a árvore do `vend-server` toda vez que alguém escreve no `projetos`; e uma conexão por aba
// de origem seria pagar N sockets para assistir a uma tela de cada vez. O `ns` no envelope
// é o que permite ao cliente atualizar uma origem inativa **sem redesenhar** a ativa.
//
// O board é **read-only, e é só leitura mesmo**: não há uma rota que escreva um byte no
// `.scratch/` nem em lugar nenhum. As origens sobem `:ro` no compose, e o servidor não tem
// estado próprio — a árvore que ele serve é derivada do disco a cada leitura, e nada mais.

import { createServer } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, extname, sep, join, relative, dirname, basename } from 'node:path'

import { REPOS, discover, refIn } from './paths.js'
import { createCache } from './cache.js'
import { watchTree } from './watch.js'
import { normalizeStatus, parseBlockedBy, parseDoc, relLinks } from '../shared/parse.js'

const PORT = Number(process.env.PORT ?? 7777)
const PUBLIC = resolve(import.meta.dirname, '..', 'public')
// O parser que o browser também importa. É servido estático, sob o mesmo prefixo que o
// `import` do `md.js` escreve (`../shared/parse.js`), para que o especificador resolva
// igual nos dois lados: no filesystem, para o Node; na URL, para o browser.
const SHARED = resolve(import.meta.dirname, '..', 'shared')

/** Um arquivo grande ou binário não vai para o visualizador; só o fato de existir importa. */
const TEXT_LIMIT = 512 * 1024

/** Um comentário SSE de tempos em tempos: mantém o socket vivo e denuncia o que morreu. */
const PING_MS = 30_000

/**
 * A **varredura de segurança**. Um push que falha, falha em **silêncio** — e silêncio é
 * byte-a-byte indistinguível de "nada mudou". Se o `fs.watch` morrer (limite de inotify,
 * root remontado, um evento que o kernel simplesmente não entregou), o board mostraria
 * dados velhos com cara de vivos, para sempre. Pior que o polling que matamos, porque o
 * polling era burro demais para conseguir mentir.
 *
 * Então, de 90 em 90 segundos, o servidor relê o disco por conta própria — **cada origem, e
 * cada uma por si**: um watcher morto no `vend-server` não é motivo para reempurrar o
 * `projetos`, e a supressão de cada origem decide sozinha se ela tem algo a dizer.
 *
 * Ela é quase de graça **por causa da supressão**: `sync()` reconstrói, compara o hash e só
 * emite se divergir — e ele só diverge se o watcher tiver perdido alguma coisa. No board
 * parado são ~40 reconstruções por hora por origem e **zero byte no fio, zero re-render**.
 *
 * O que ela devolve ao board é a propriedade que o polling tinha de graça: ele não
 * consegue ficar em silêncio mentiroso por mais de 90 segundos.
 */
const SWEEP_MS = 90_000

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

/** A chave de rota `#/<ns>/<rel>` é sempre POSIX, e o `path` do container nunca vai ao hash. */
const toPosix = (p) => (sep === '/' ? p : p.split(sep).join('/'))

// ---------- o grafo de uma pasta, sob demanda ----------
//
// Nem toda pasta é um esforço com issues, então o grafo não é uma coisa só: ele **decide o
// modo** pelo que a subárvore tem. Se algum `.md` traz `Blocked by:`, o desenho são as arestas
// de bloqueio (`deps`); senão, são os links markdown que os documentos fazem uns aos outros
// (`links`). É calculado **sob demanda** — só quando alguém abre a visão de grafo de uma pasta
// —, nunca no board: a maioria das pastas nunca é aberta assim, e varrer todas a cada leitura
// seria pagar por uma tela que ninguém pediu.

/** Junta os `.md` da subárvore, do fundo ao topo. Oculto nunca entra — nem `.git/`, nem `.swp`. */
async function collectMd(dir, out = []) {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out /* a pasta sumiu, ou nunca existiu: subárvore vazia */
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const path = join(dir, e.name)
    if (e.isDirectory()) await collectMd(path, out)
    else if (e.isFile() && extname(e.name) === '.md') out.push(path)
  }
  return out
}

/** Um nó do grafo. `id` = `path` (identidade); `rel` = a chave de rota que o cliente navega. */
function graphNode(ns, doc) {
  const node = {
    id: doc.path,
    name: doc.name,
    path: doc.path,
    ref: refIn(ns, doc.path),
    rel: toPosix(relative(ns.root, doc.path)),
  }
  if (doc.title !== undefined) node.title = doc.title
  if (doc.status !== undefined) node.status = doc.status
  return node
}

/**
 * O modo `deps`: os nós são os arquivos-issue **numerados**, e as arestas são o `Blocked by:`
 * resolvido **só entre irmãos de mesma pasta-pai** — um `Blocked by: 02` é o `02` da mesma
 * pasta `issues/`, nunca de outro esforço. `from` = o bloqueante, `to` = o bloqueado, `note` =
 * a prosa do fragmento (a justificativa que o hover lê antes de decidir furar a fila).
 *
 * Um número que não casa com irmão nenhum não vira aresta: não há o que esperar.
 */
function depsGraph(ns, docs) {
  const numbered = docs.filter((d) => d.number !== null)
  const nodes = numbered.map((d) => graphNode(ns, d))
  const byKey = new Map(numbered.map((d) => [`${d.dir}\0${d.number}`, d.path]))
  const edges = []
  for (const d of numbered) {
    for (const dep of d.blockedBy) {
      const from = byKey.get(`${d.dir}\0${dep.number}`)
      if (!from) continue
      edges.push(dep.note ? { from, to: d.path, note: dep.note } : { from, to: d.path })
    }
  }
  return { mode: 'deps', nodes, edges }
}

/**
 * O modo `links`: os nós são **todos** os `.md` da subárvore, e as arestas são os links
 * markdown relativos resolvidos **por caminho real** para outro nó da subárvore. `from` = quem
 * cita, `to` = o citado, e **sem `note`**: um link não carrega justificativa.
 *
 * Só o alvo que resolve para um documento que também é nó vira aresta — um link para fora da
 * subárvore, ou para um arquivo que não existe, não desenha nada.
 */
function linksGraph(ns, docs) {
  const nodes = docs.map((d) => graphNode(ns, d))
  const present = new Set(docs.map((d) => d.path))
  const edges = []
  for (const d of docs) {
    for (const target of relLinks(d.raw)) {
      const clean = target.split('#')[0].split('?')[0]
      if (!clean) continue
      const to = resolve(d.dir, clean)
      if (to !== d.path && present.has(to)) edges.push({ from: d.path, to })
    }
  }
  return { mode: 'links', nodes, edges }
}

/**
 * O grafo de uma pasta. Lê a subárvore agora (como a árvore, sem cache), parseia cada `.md` e
 * decide o modo: `deps` se **algum** documento tem `Blocked by:`, `links` caso contrário. Sem
 * aresta nenhuma, devolve os nós soltos — o cliente mostra a nota em vez de fingir um desenho.
 */
async function folderGraph(ns, folder) {
  const paths = await collectMd(folder)
  const docs = await Promise.all(
    paths.map(async (path) => {
      const raw = await readFile(path, 'utf8')
      const { header, title } = parseDoc(raw)
      return {
        path,
        dir: dirname(path),
        name: basename(path),
        raw,
        title,
        status: header.status !== undefined ? normalizeStatus(header.status) : undefined,
        number: /^(\d+)/.exec(basename(path))?.[1]?.padStart(2, '0') ?? null,
        blockedBy: parseBlockedBy(header['blocked by']),
      }
    }),
  )
  return docs.some((d) => d.blockedBy.length > 0) ? depsGraph(ns, docs) : linksGraph(ns, docs)
}

/**
 * Sobe o servidor, descobre as origens, liga um watcher em cada uma e arma a varredura.
 *
 * Porta `0` pede uma porta efêmera ao sistema — é assim que o teste de integração sobe um
 * board de verdade contra um diretório temporário sem brigar com o container que já roda na
 * 7777. `sweep` encurta a varredura para o mesmo teste poder assistir a ela agir.
 *
 * `stopWatch` mata os watchers **sem** derrubar o servidor. Não é enfeite de teste: é a
 * falha que a varredura existe para cobrir, e é como ela se torna demonstrável em vez de
 * prometida — um watcher morto é exatamente isto.
 *
 * Tudo que tem estado nasce **aqui dentro**, não no módulo: os assinantes, os caches, os
 * watchers. Dois servidores no mesmo processo não se enxergam.
 */
export async function start(port = PORT, { sweep = SWEEP_MS } = {}) {
  // A descoberta é do startup. Um mount novo no compose aparece quando o container é
  // recriado — que é o que mudar o compose já obriga a fazer.
  const namespaces = await discover()

  /** Quem está com o board aberto. Um `res` de SSE que nunca termina — **um por aba**, não por origem. */
  const clients = new Set()

  /**
   * Uma origem, e tudo que é dela: a árvore, a supressão, o digest, o watcher — e o **inode**
   * em que esse watcher foi aberto, que é como o `rearm()` sabe que ele ficou para trás.
   */
  const wires = new Map(
    namespaces.map((ns) => [ns.name, { ns, cache: createCache(ns), unwatch: null, watching: undefined }]),
  )

  /**
   * Reabre o watcher de uma origem quando o `.scratch/` **trocou de inode** por baixo dele.
   *
   * O `git checkout` de uma branch sem `.scratch/` apaga o diretório; a volta o recria, com
   * outro inode. A **leitura** sobrevive a isso (resolve o caminho a cada `readdir`, e é para
   * isso que o compose monta o repo). O **watcher**, não: o `fs.watch` se prende ao inode que
   * abriu, e apagar o root **não emite `error`** — está verificado no `watch.js`, o kernel
   * manda `rename` e cala. Ele não morre: **cala**, parecendo vivo. Medido no container
   * (Node 22) depois de um checkout real: board correto, push mudo para sempre.
   *
   * **É heurística, e a rede está embaixo.** O sinal é a troca do número do inode, e ele pode
   * mentir: o ext4 **reusa** o número quando a recriação é imediata. No `git checkout` de
   * verdade ele trocou, que é o caso que motivou isto; quando não trocar, o rearme não dispara
   * e o board volta a depender da varredura de 90s — degradado, **nunca mentindo**.
   *
   * **Não ressuscita o que foi morto de propósito**: o `stopWatch()` não move o inode, então
   * `watching` continua batendo e nada acontece — é o que mantém o `sweep.test.js` honesto.
   */
  const rearm = async (name) => {
    const wire = wires.get(name)
    const ino = await stat(wire.ns.root).then((s) => s.ino, () => null)
    if (ino === wire.watching) return
    wire.watching = ino
    wire.unwatch?.()
    wire.unwatch = watchTree(wire.ns.root, () => {
      sync(name).catch(() => { /* o disco piscou; a varredura de segurança repesca */ })
    })
  }

  // Os roots que o board pode ler. É o `safePath()` de sempre, generalizado às origens
  // descobertas — **e é só isso**: nenhuma política nova de `realpath`, nenhum endurecimento
  // novo de symlink. O que mudou foi a lista, não o modelo. O diretório comum **não** é um
  // root: ele contém as origens, mas não é uma delas.
  const roots = namespaces.map((ns) => ns.root)

  /** Prende um `path` vindo do cliente aos roots que o board pode ler. */
  const safePath = (input) => {
    const p = resolve(input)
    const ok = roots.some((r) => p === r || p.startsWith(r + sep))
    if (!ok) throw new Error('caminho fora dos diretórios permitidos')
    return p
  }

  // ---------- o push ----------
  //
  // A árvore já está serializada; reparsear para reserializar dentro de um envelope seria pagar
  // o JSON duas vezes por evento. O envelope é montado como texto.
  //
  // `ns` diz **de que origem** o evento fala: sem ele o cliente não teria como guardar a árvore
  // nova no lugar certo, e um push do `vend-server` sobrescreveria o `projetos`.
  //
  // `changed` é a lista de caminhos que mexeram no disco (vazia no snapshot de conexão). A
  // árvore não precisa dela — ela vem inteira —, mas o visualizador precisa: é assim que ele
  // descobre que o documento aberto é justamente o que o agente acabou de escrever.
  const frame = (ns, json, changed) =>
    `data: {"ns":${JSON.stringify(ns)},"changed":${JSON.stringify(changed)},"board":${json}}\n\n`

  /**
   * O evento do **arquivo**, não da árvore: só os caminhos, sem a projeção inteira.
   *
   * A árvore projeta estrutura, status e título — e **nada do corpo**. Um agente escrevendo a
   * `## Answer` do documento que você tem aberto não move um pixel da árvore, e sob a supressão
   * por hash isso seria **silêncio** — justamente no caso de uso que dá nome ao visualizador
   * vivo: *o agente está escrevendo o que você está lendo*.
   */
  const fileFrame = (ns, changed) =>
    `event: files\ndata: {"ns":${JSON.stringify(ns)},"changed":${JSON.stringify(changed)}}\n\n`

  const broadcast = (payload) => {
    for (const res of clients) res.write(payload)
  }

  /**
   * Relê o disco de **uma origem** e empurra — a árvore **se, e só se, ela mudou**; os
   * caminhos, se algum arquivo mudou e a árvore não.
   *
   * É o único caminho que emite. Serve o watcher, a varredura e o `/api/board`: uma releitura
   * por HTTP que descobre uma mudança também avisa as outras abas, em vez de guardar a
   * novidade para si e deixar o hash mentir para o resto do mundo.
   *
   * Duas supressões, independentes de propósito: o `refresh()` diz se a **árvore** mudou — é
   * ele que autoriza redesenhar a tela; o `movedFiles()` diz quais **arquivos** mudaram de
   * conteúdo — é ele que autoriza avisar quem está lendo um deles. **Colapsar as duas numa só
   * cega o visualizador**: a árvore não projeta uma linha do corpo dos arquivos, então o corpo
   * que o agente escreve não move o hash, e ninguém seria avisado.
   *
   * As duas são **por origem**, e é o que impede uma escrita numa de suprimir ou acordar a
   * outra. Não há supressão cruzada: cada namespace tem o seu hash e o seu digest.
   *
   * O watcher se reconcilia **aqui** (`rearm`), pela mesma razão: este é o único ponto por
   * onde toda leitura de disco passa — o gatilho, a varredura de 90s e o `/api/board`.
   * Pendurá-lo no watcher o deixaria cego justamente quando o watcher cala, que é o buraco
   * que ele existe para tapar. **Sem relógio próprio**: um `setInterval` só para statar roots
   * seria polling voltando pela porta dos fundos.
   *
   * **Ocioso continua custando zero.** Nada aqui roda por relógio: o `sync()` só acontece
   * quando o watcher fala, quando a varredura de 90s passa ou quando alguém pede o board.
   * Disco parado ⇒ árvore igual, digests iguais ⇒ **0 evento, 0 byte**.
   */
  async function sync(name) {
    const { cache } = wires.get(name)
    const [{ json, changed: moved }, changed] = await Promise.all([cache.refresh(), cache.movedFiles()])

    try {
      await rearm(name)
    } catch (err) {
      console.error(`watcher: falha ao rearmar ${name}: ${err.message}`)
    }

    if (moved) broadcast(frame(name, json, changed))
    else if (changed.length) broadcast(fileFrame(name, changed))
    return json
  }

  // ---------- as rotas ----------

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost')
    try {
      // A projeção de **uma** origem, relida do disco por dentro do `sync()` (que também avisa
      // as outras abas se descobrir novidade). É o que o botão de reler chama.
      if (url.pathname === '/api/board') {
        const wire = wires.get(url.searchParams.get('ns') ?? '')
        if (!wire) throw new Error('origem não encontrada')
        return send(res, 200, await sync(wire.ns.name))
      }

      // O grafo de uma pasta, calculado sob demanda. `ns` escolhe a origem (para o `ref`/`rel`);
      // `path` é a pasta no vocabulário do container, presa aos roots pelo `safePath()`.
      if (url.pathname === '/api/graph') {
        const wire = wires.get(url.searchParams.get('ns') ?? '')
        if (!wire) throw new Error('origem não encontrada')
        const folder = safePath(url.searchParams.get('path') ?? '')
        return send(res, 200, await folderGraph(wire.ns, folder))
      }

      if (url.pathname === '/api/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        // O snapshot de conexão. É ele que cura o restart do container sem F5: o
        // `EventSource` reconecta sozinho e o servidor devolve **cada origem, inteira** —
        // um frame por namespace. A aba volta com todas as origens frescas, e não só a que
        // está na tela: quem reconecta não sabe quanto tempo ficou fora.
        //
        // E ele **relê o disco** (`sync()`), em vez de servir o que o cache acredita. Se a
        // aba está reconectando, alguma coisa esteve quebrada — e se o que quebrou foi o
        // watcher, o cache está velho. Servir o cache aqui seria devolver a mentira que a
        // reconexão veio consertar.
        res.write(`retry: 2000\n\n`)
        for (const ns of namespaces) res.write(frame(ns.name, await sync(ns.name), []))
        clients.add(res)
        const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)
        const drop = () => {
          clearInterval(ping)
          clients.delete(res)
        }
        req.on('close', drop)
        res.on('close', drop)
        return
      }

      if (url.pathname === '/api/file') {
        // O caminho é absoluto e único no container, então ele **já diz** de que origem é:
        // o `safePath()` o prende aos roots descobertos, e não há um `ns` a passar aqui. O
        // corpo é **cru** (texto), não um envelope — o visualizador o exibe direto.
        const path = safePath(url.searchParams.get('path') ?? '')
        let size
        try {
          ;({ size } = await stat(path))
        } catch {
          // Sumir é um **estado**, não um erro do board: o visualizador o trata como âmbar e o
          // diz por cima do texto que estava lendo. A string é contrato — o cliente a procura.
          return send(res, 404, 'não encontrado', 'text/plain')
        }
        if (size > TEXT_LIMIT) return send(res, 413, `— arquivo de ${size} bytes, grande demais para exibir —`, 'text/plain')
        const buf = await readFile(path)
        // NUL nos primeiros bytes é o sinal barato de binário: evita despejar um PNG na tela.
        const binary = buf.subarray(0, 8000).includes(0)
        return send(res, 200, binary ? `— binário, ${size} bytes —` : buf.toString('utf8'), 'text/plain')
      }

      // Estático de dois roots: `public/` na raiz da URL, e `shared/` sob `/shared/` — é
      // por ali que o `md.js` do browser importa o parser que o servidor também usa.
      const [root, file] = url.pathname.startsWith('/shared/')
        ? [SHARED, url.pathname.slice('/shared/'.length)]
        : [PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname.slice(1)]
      const path = resolve(root, file)
      if (!path.startsWith(root + sep)) return send(res, 403, { error: 'proibido' })
      return send(res, 200, await readFile(path, 'utf8'), MIME[extname(path)] ?? 'text/plain')
    } catch (err) {
      const missing = err.code === 'ENOENT'
      send(res, missing ? 404 : 400, { error: missing ? 'não encontrado' : err.message })
    }
  }

  // O disco de agora não é novidade: o servidor nasce sabendo o que está em cada origem. Sem
  // isso, a primeira rajada acharia que **todo** arquivo acabou de mudar e empurraria a lista
  // inteira de caminhos.
  await Promise.all([...wires.values()].map((w) => w.cache.seed()))

  const server = createServer(handler)

  // Um watcher **por origem**. O `fs.watch` recursivo do Node vigia uma árvore, e as árvores
  // são mounts distintos — separados, um watcher que cai leva só a sua origem para a varredura.
  //
  // A montagem inicial é o **mesmo** `rearm()` que o `sync()` chama depois: na subida o
  // `watching` está `undefined`, e nenhum inode é igual a isso, então o primeiro rearme sempre
  // abre o watch.
  await Promise.all([...wires.keys()].map((name) => rearm(name)))

  // A varredura não empurra só o board: como o `changed` sai do digest e não do watcher, ela
  // também sabe **quais** arquivos mudaram — então, com o watcher morto, o visualizador aberto
  // se cura junto com o board.
  const sweeper = setInterval(() => {
    for (const name of wires.keys()) {
      sync(name).catch(() => { /* a próxima volta repesca — a varredura não desiste */ })
    }
  }, sweep)
  // Quem segura o processo de pé é o servidor HTTP, não o relógio.
  sweeper.unref?.()

  const stopWatch = () => {
    for (const wire of wires.values()) wire.unwatch?.()
  }

  return new Promise((ok) => {
    server.listen(port, () => {
      ok({
        server,
        port: server.address().port,
        namespaces,
        stopWatch,
        close: async () => {
          stopWatch()
          clearInterval(sweeper)
          for (const res of clients) res.end()
          clients.clear()
          await new Promise((done) => server.close(done))
        },
      })
    })
  })
}

// `node src/server.js` sobe o servidor; `import` (dos testes) só pega o `start`, e é o
// teste que escolhe a porta. Sem o guard, `node --test` levantaria a 7777 e penduraria.
const isMain = process.argv[1] && resolve(process.argv[1]) === import.meta.filename

if (isMain) {
  const { port, namespaces } = await start()
  const origens = namespaces.map((ns) => ns.name).join(', ') || 'nenhuma — o compose não montou nada'
  console.log(`scratch-board em http://localhost:${port}  (${REPOS}: ${origens})`)
}
