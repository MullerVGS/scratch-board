// Só HTTP: rotas, estáticos, o stream SSE e a contenção dos caminhos que chegam do cliente.
//
// O que o board *é* mora ao lado — `board.js` monta a projeção de uma origem, `pads.js` lê
// os scratchpads, `cache.js` guarda o board de cada origem e decide se ele mudou,
// `watch.js` escuta o disco, `paths.js` descobre as origens, `../shared/parse.js` entende o
// dialeto dos `.md`. Aqui só se responde.
//
// O board **não pergunta mais** ao disco a cada 5 segundos: ele é avisado. O watcher emite,
// o cache suprime o que não mudou, e o que sobra desce por `/api/stream` para quem estiver
// olhando — o board inteiro, num evento, calculado num lugar só. Um diff foi rejeitado
// porque exigiria uma máquina de merge no cliente, que pode divergir do disco: é
// exatamente o pecado que o board existe para não cometer.
//
// **N origens, uma conexão.** Cada namespace tem watcher, hash, digest e board próprios —
// mas o browser abre **um** `EventSource`, e cada evento diz de que origem veio (`ns`) e
// carrega **só o board daquela origem**. Mandar todas as origens em todo evento seria pagar
// o board do `vend-server` toda vez que alguém escreve no `projetos`; e uma conexão por aba
// de origem seria pagar N sockets para assistir a uma tela de cada vez. O `ns` no envelope
// é o que permite ao cliente atualizar uma origem inativa **sem redesenhar** a ativa.

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'

import { PADS, REPOS, discover } from './paths.js'
import { listPads } from './pads.js'
import { buildBoard } from './board.js'
import { createCache } from './cache.js'
import { watchTree } from './watch.js'
import { createHistory } from './history.js'

const PORT = Number(process.env.PORT ?? 7777)
const PUBLIC = resolve(import.meta.dirname, '..', 'public')
// O parser que o browser também importa. É servido estático, sob o mesmo prefixo que o
// `import` do `md.js` escreve (`../shared/parse.js`), para que o especificador resolva
// igual nos dois lados: no filesystem, para o Node; na URL, para o browser.
const SHARED = resolve(import.meta.dirname, '..', 'shared')

/** Um arquivo grande ou binário não vai para a gaveta; só o fato de existir importa. */
const TEXT_LIMIT = 512 * 1024
const JSON_LIMIT = 16 * 1024
const HOUR = 3600e3

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
 * parado são ~40 reconstruções por hora por origem (~15ms de CPU cada) e **zero byte no
 * fio, zero re-render**. Contra as 720 reconstruções *com* 720 re-renders do polling.
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

/** Corpo JSON pequeno das rotas de comando. O limite impede um POST de virar buffer sem teto. */
async function jsonBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > JSON_LIMIT) throw new Error('corpo grande demais')
  }
  return JSON.parse(body || '{}')
}

/** Memória tem granularidade de hora. O servidor reafirma o snap — não confia só no mouse. */
const hourIso = (value) => {
  const at = Date.parse(value)
  if (!Number.isFinite(at)) throw new Error('data inválida')
  return new Date(Math.round(at / HOUR) * HOUR).toISOString()
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

  // O catálogo é **um**, e a origem vive na chave de cada linha. Ele não é por namespace
  // como o cache: o cache existe para uma origem não suprimir a outra, e isso é uma
  // propriedade do *push*. O catálogo só registra fatos, e fato de origem diferente não
  // interfere em fato de origem nenhuma.
  //
  // Nasce **antes** dos wires porque cada cache o recebe: o `buildBoard()` lê o catálogo para
  // destilar a barra do Gantt de cada issue. É leitura pura — quem escreve no catálogo é o
  // `sync()`, depois que o board foi lido.
  const history = await createHistory()

  /**
   * Uma origem, e tudo que é dela: o board, a supressão, o digest, o watcher — e o **inode**
   * em que esse watcher foi aberto, que é como o `rearm()` sabe que ele ficou para trás.
   */
  const wires = new Map(
    namespaces.map((ns) => [
      ns.name,
      { ns, cache: createCache(ns, history), unwatch: null, watching: undefined },
    ]),
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
   * mentir: o ext4 **reusa** o número quando a recriação é imediata (medido — mesmo `ino` dos
   * dois lados de um `rm`+`mkdir` colado). No `git checkout` de verdade ele trocou
   * (34604854 → 34831673), que é o caso que motivou isto; quando não trocar, o rearme não
   * dispara e o board volta a depender da varredura de 90s — degradado, **nunca mentindo**.
   * O conserto sem heurística é o watch por diretório que o `watch.js` já aponta.
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

  // Os roots que o board pode ler. É o `safePath()` de sempre, agora generalizado às
  // origens descobertas — **e é só isso**: nenhuma política nova de `realpath`, nenhum
  // endurecimento novo de symlink. O que mudou foi a lista, não o modelo.
  const roots = [...namespaces.map((ns) => ns.root), PADS]

  /** Prende um `path` vindo do cliente aos roots que o board pode ler. */
  const safePath = (input) => {
    const p = resolve(input)
    const ok = roots.some((r) => p === r || p.startsWith(r + sep))
    if (!ok) throw new Error('caminho fora dos diretórios permitidos')
    return p
  }

  // ---------- o push ----------

  // O board já está serializado; reparsear para reserializar dentro de um envelope seria
  // pagar 62 KB de JSON duas vezes por evento. O envelope é montado como texto.
  //
  // `ns` diz **de que origem** o evento fala: sem ele o cliente não teria como guardar o
  // board novo no lugar certo, e um push do `vend-server` sobrescreveria o `projetos`.
  //
  // `changed` é a lista de caminhos que mexeram no disco (vazia no snapshot de conexão). O
  // board não precisa dela — ele vem inteiro —, mas a gaveta precisa: é assim que ela
  // descobre que o documento aberto é justamente o que o agente acabou de escrever.
  const frame = (ns, json, changed) =>
    `data: {"ns":${JSON.stringify(ns)},"changed":${JSON.stringify(changed)},"board":${json}}\n\n`

  /**
   * O evento do **arquivo**, não do board: só os caminhos, sem os 62 KB da projeção.
   *
   * O board projeta `Status:`, título e `Blocked by:` — e **nada do corpo**. Um agente
   * escrevendo a `## Answer` do documento que você tem aberto na gaveta não move um pixel do
   * board, e sob a supressão por hash isso seria **silêncio** — justamente no caso de uso que
   * dá nome à gaveta viva: *o agente está escrevendo o que você está lendo*.
   *
   * A supressão do board continua certa (ele não mudou, não se redesenha). O que não pode
   * acontecer é o sinal "*o arquivo* mudou" ficar pendurado no sinal "*o board* mudou": são
   * dois escopos, e colapsá-los cega a gaveta.
   */
  const fileFrame = (ns, changed) =>
    `event: files\ndata: {"ns":${JSON.stringify(ns)},"changed":${JSON.stringify(changed)}}\n\n`

  const broadcast = (payload) => {
    for (const res of clients) res.write(payload)
  }

  /**
   * Relê o disco de **uma origem** e empurra — o board **se, e só se, ele mudou**; os
   * caminhos, se algum arquivo mudou e o board não.
   *
   * É o único caminho que emite. Serve o watcher, a varredura e o `/api/board`: uma releitura
   * por HTTP que descobre uma mudança também avisa as outras abas, em vez de guardar a
   * novidade para si e deixar o hash mentir para o resto do mundo.
   *
   * Duas supressões, independentes de propósito: o `refresh()` diz se o **board** mudou — é
   * ele que autoriza redesenhar a tela; o `movedFiles()` diz quais **arquivos** mudaram de
   * conteúdo — é ele que autoriza avisar quem está lendo um deles. **Colapsar as duas numa só
   * cega a gaveta**: o board não projeta uma linha do corpo dos arquivos, então o corpo que o
   * agente escreve não move o hash, e ninguém seria avisado.
   *
   * As duas são **por origem**, e é o que impede uma escrita numa de suprimir ou acordar a
   * outra. Não há supressão cruzada: cada namespace tem o seu hash e o seu digest.
   *
   * **Ocioso continua custando zero.** Nada aqui roda por relógio: o `sync()` só acontece
   * quando o watcher fala, quando a varredura de 90s passa ou quando alguém pede o board.
   * Disco parado ⇒ board igual, digests iguais ⇒ **0 evento, 0 byte**.
   */
  async function sync(name) {
    const { cache } = wires.get(name)
    const [{ json, changed: moved, board }, changed] = await Promise.all([cache.refresh(), cache.movedFiles()])

    // O catálogo observa **aqui**, e não no watcher: este é o único ponto do servidor por
    // onde toda leitura de disco passa — o gatilho do watcher, a varredura de 90s e o
    // `/api/board`. Pendurá-lo no watcher o deixaria cego justamente quando o watcher morre,
    // que é o buraco que a varredura existe para tapar.
    //
    // Ele **não empurra nada**: um evento no catálogo não é um evento no fio. O board só sai
    // daqui se o hash dele mudou, exatamente como antes.
    //
    // **Os arquivados entram junto**, e essa linha é a razão de o `buildBoard()` devolver as
    // duas listas separadas: esforço arquivado é esforço **terminado** — exatamente aquele
    // cuja duração o Gantt existe para mostrar. Observar só os ativos apagaria do catálogo a
    // única história completa que existe.
    //
    // O catálogo é **best-effort**: ele espia a leitura do board, não é dono dela. `observe()`
    // escreve em disco (o log, o batimento), e essa escrita pode falhar por um motivo que não
    // tem nada a ver com o board que acabou de ser lido com sucesso — disco cheio, volume
    // remontado `ro`, o log virando diretório por baixo dele. Deixar isso subir derrubaria a
    // leitura por causa da escrita de um espectador, e no `/api/stream` (onde os headers já
    // saíram) isso não vira um 500: vira `ERR_HTTP_HEADERS_SENT` não capturado, e o processo
    // inteiro morre — todas as origens, para todos os clientes. Contido aqui, do jeito que o
    // watcher e a varredura já contêm a falha do próprio `sync()`.
    //
    // Mas silêncio total também não serve — é a doutrina deste projeto (ver **A rede de
    // segurança**, no AGENTS.md): um catálogo que para de gravar sem avisar é exatamente o
    // modo de falha que o push inteiro existe para não ter. Por isso o erro vai para o log do
    // container, mesmo sem subir.
    //
    // **A observação vem depois da leitura, e por isso a faixa nova do Gantt chega um ciclo
    // depois.** O `refresh()` acima já leu o board com o catálogo **de antes** desta
    // observação; a coluna (o chip do card, o kanban) muda na hora, porque vem do `Status:` do
    // arquivo, mas a *faixa* correspondente na barra do Gantt só aparece no próximo `sync()` —
    // a próxima escrita, ou a varredura de 90s. É um atraso de retaguarda numa tela
    // retrospectiva, não um push fantasma: a faixa nova é uma mudança de board de verdade, e
    // ela só existe porque uma transição de verdade aconteceu.
    try {
      await history.observe(name, [...board.efforts, ...board.archived], Date.now())
    } catch (err) {
      console.error(`catálogo: falha ao observar ${name}: ${err.message}`)
    }

    // E o watcher se reconcilia **aqui**, pela mesma razão que o catálogo observa aqui: este é
    // o único ponto por onde toda leitura de disco passa — o gatilho do watcher, a varredura de
    // 90s e o `/api/board`. Pendurá-lo no watcher o deixaria cego justamente quando o watcher
    // cala, que é o buraco que ele existe para tapar.
    //
    // **Sem relógio próprio, de propósito.** A varredura já é a rede contra o silêncio e o botão
    // de reler já é a válvula humana; os dois passam por aqui. Um `setInterval` só para statar
    // roots seria polling voltando pela porta dos fundos, e num board parado custaria
    // exatamente o que a supressão comprou. **Ocioso continua custando zero**: um `stat` por
    // `sync()`, e `sync()` não roda por relógio.
    try {
      await rearm(name)
    } catch (err) {
      console.error(`watcher: falha ao rearmar ${name}: ${err.message}`)
    }

    if (moved) broadcast(frame(name, json, changed))
    else if (changed.length) broadcast(fileFrame(name, changed))
    return json
  }

  /**
   * Todas as origens, num payload só — o primeiro board da aba e o que o botão de reler
   * chama. Cada origem passa pelo seu `sync()`, então a releitura é de verdade (e o que ela
   * descobrir também é empurrado às outras abas).
   *
   * O JSON de cada board já está pronto: montá-los como texto evita reparsear 62 KB por
   * origem só para reserializá-los dentro do envelope.
   */
  async function syncAll() {
    const boards = await Promise.all(
      namespaces.map(async (ns) => `${JSON.stringify(ns.name)}:${await sync(ns.name)}`),
    )
    const names = JSON.stringify(namespaces.map((ns) => ns.name))
    return `{"namespaces":${names},"boards":{${boards.join(',')}}}`
  }

  // ---------- as rotas ----------

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost')
    try {
      if (url.pathname === '/api/board') return send(res, 200, await syncAll())

      if (url.pathname === '/api/confirm' && req.method === 'POST') {
        const { ns, slug, number, start, end } = await jsonBody(req)
        if (typeof ns !== 'string' || typeof slug !== 'string' || !ns || !slug) {
          throw new Error('origem e esforço são obrigatórios')
        }
        if (number !== undefined && (typeof number !== 'string' || !number)) {
          throw new Error('número inválido')
        }
        const wire = wires.get(ns)
        if (!wire) throw new Error('origem não encontrada')

        // A rota só confirma o que a projeção conhece. Isso também distingue issue de esforço
        // sem aceitar caminho do cliente — a identidade é namespace + slug + número.
        const current = await buildBoard(wire.ns, history)
        const effort = [...current.efforts, ...current.archived].find((item) => item.slug === slug)
        if (!effort) throw new Error('esforço não encontrado')
        if (number !== undefined && !effort.issues.some((issue) => issue.number === number)) {
          throw new Error('issue não encontrada')
        }

        const snappedStart = hourIso(start)
        const snappedEnd = hourIso(end)
        if (Date.parse(snappedStart) > Date.parse(snappedEnd)) throw new Error('intervalo invertido')
        const confirmation = await history.confirm(ns, slug, number, snappedStart, snappedEnd, Date.now())

        // O catálogo vive fora do `.scratch/`, então watcher nenhum acordará. A própria rota
        // sincroniza e empurra a projeção nova às abas; o POST não deixa a confirmação muda.
        await sync(ns)
        return send(res, 200, { confirmation })
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
        // E ele **relê o disco** (`sync()`), em vez de servir o que o cache acredita. A
        // diferença aparece justamente na hora em que ela importa: se a aba está
        // reconectando, alguma coisa esteve quebrada — e se o que quebrou foi o watcher, o
        // cache está velho. Servir o cache aqui seria devolver a mentira que a reconexão
        // veio consertar. Custa uma reconstrução por origem por conexão aberta, e conexão
        // se abre pouco. (Como todo `sync()`, se a releitura descobrir novidade, as outras
        // abas são avisadas — a descoberta não fica presa em quem conectou.)
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

      // Os scratchpads são **globais**: eles não pertencem a origem nenhuma. São o rascunho
      // efêmero do Claude, e continuam sob demanda — sem watcher, sem push.
      if (url.pathname === '/api/pads') return send(res, 200, { root: PADS, pads: await listPads() })

      if (url.pathname === '/api/file') {
        // O caminho é absoluto e único no container, então ele **já diz** de que origem é:
        // o `safePath()` o prende aos roots descobertos, e não há um `ns` a passar aqui.
        const path = safePath(url.searchParams.get('path') ?? '')
        const { size } = await stat(path)
        if (size > TEXT_LIMIT) {
          return send(res, 200, { path, content: `— arquivo de ${size} bytes, grande demais para exibir —` })
        }
        const buf = await readFile(path)
        // NUL nos primeiros bytes é o sinal barato de binário: evita despejar um PNG na gaveta.
        const binary = buf.subarray(0, 8000).includes(0)
        return send(res, 200, {
          path,
          content: binary ? `— binário, ${size} bytes —` : buf.toString('utf8'),
        })
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

  // O disco de agora não é novidade: o servidor nasce sabendo o que está em cada origem.
  await Promise.all([...wires.values()].map((w) => w.cache.seed()))

  // **E o catálogo também é semeado**, pelo mesmo motivo com outra roupa. O `held` de cada
  // issue (`"em <coluna> há N"`) nasce do primeiro `seen` que o servidor grava; se esse `seen`
  // só fosse escrito no primeiro `sync()` (a conexão, a varredura), o campo saltaria de vazio
  // para o instante observado num board **parado** — um push fantasma que a varredura de
  // segurança proíbe (ver `sweep.test.js`). Registrando o `seen` de tudo que já está no disco
  // **antes de servir**, o `held` nasce estável.
  //
  // Idempotente no restart: `createHistory()` releu o log, e `observe()` só grava o que é novo —
  // um ticket que já tinha `seen` persistido não ganha outro, então o piso segue crescendo desde
  // a primeira observação da vida, sobrevivendo aos restarts. Best-effort, como todo `observe()`.
  const seededAt = Date.now()
  await Promise.all(
    namespaces.map(async (ns) => {
      try {
        const board = await buildBoard(ns, history)
        await history.observe(ns.name, [...board.efforts, ...board.archived], seededAt)
      } catch (err) {
        console.error(`catálogo: falha ao semear ${ns.name}: ${err.message}`)
      }
    }),
  )

  const server = createServer(handler)

  // Um watcher **por origem**. O `fs.watch` recursivo do Node vigia uma árvore, e as árvores
  // são mounts distintos — um watcher só no diretório comum atravessaria os bind mounts no
  // papel, mas ficaria com uma lista de caminhos misturada e um único ponto de morte para
  // todas as origens. Separados, um watcher que cai leva só a sua origem para a varredura.
  //
  // Ele é **gatilho**, não testemunha — a lista de caminhos que ele entrega fica onde está, e
  // o `sync()` apura por conta própria o que mudou. O `fs.watch` recursivo do Node para de
  // reportar um nome depois que um `rename` troca o inode por baixo dele, e é assim que os
  // agentes escrevem (tmp + rename): da segunda edição em diante, o arquivo de verdade some
  // do relato do kernel. Ele basta para dizer *que* algo mexeu; quem diz *o quê* é o digest.
  //
  // A montagem inicial é o **mesmo** `rearm()` que o `sync()` chama depois: na subida o
  // `watching` está `undefined`, e nenhum inode é igual a isso, então o primeiro rearme sempre
  // abre o watch. Um caminho só para abrir watcher — um `watchTree()` à parte aqui nasceria
  // sem registrar o inode, e o primeiro `sync()` fecharia e reabriria o que a subida acabou
  // de abrir.
  await Promise.all([...wires.keys()].map((name) => rearm(name)))

  // A varredura não empurra só o board: como o `changed` sai do digest e não do watcher, ela
  // também sabe **quais** arquivos mudaram — então, com o watcher morto, a gaveta aberta se
  // cura junto com o board.
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
