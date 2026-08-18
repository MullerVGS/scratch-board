/**
 * O servidor de verdade, contra um `.scratch/` de verdade.
 *
 * Esta é a costura mais alta do projeto e a que cobre mais: sobe o servidor numa **porta
 * efêmera** apontando para um diretório temporário, abre o stream SSE com o `fetch` nativo
 * e **escreve arquivos no disco** — arquivos mesmo, não mocks de `fs`. O que se afirma é o
 * que chega pelo fio.
 *
 * O board agora é uma **árvore de arquivos genérica** (`src/tree.js`): sem colunas, sem
 * exigir PRD/map/issues, sem catálogo. `GET /api/board?ns=` serve a projeção de uma origem;
 * `GET /api/graph?ns=&path=` calcula o grafo de uma pasta sob demanda; o SSE empurra `message`
 * (a árvore mudou) e `files` (o disco mudou, a árvore não).
 *
 * A promessa central do push continua a mesma:
 *
 *   - escrita empurra;
 *   - escrita sem mudança semântica **não** empurra (a supressão por hash);
 *   - rajada de seis arquivos vira **um** evento (o debounce);
 *   - diretório novo aparece sem reiniciar nada.
 *
 * **O `mtime` está no nó** (o cliente calcula o "há 2h" a partir dele), então um save move a
 * árvore e vira um `message` legítimo. O evento `files` sobra para o caso estreito em que o
 * **conteúdo** muda mas a árvore não — e é ele que prova que o `changed` sai do **digest**, não
 * da lista de caminhos do watcher (que o `rename` dos agentes derruba).
 *
 * E o `/shared/parse.js`: um teste de unidade nunca o pegaria — a rede do parser roda no
 * filesystem, não pela HTTP. Se aquela rota morrer, o `md.js` do browser falha no import,
 * e um import de módulo falha **em silêncio**: o board simplesmente não monta.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rename, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mounts // o diretório comum: cada filho dele é uma origem
let root // o `.scratch/` da origem `projetos`
let server
let base

/** Escreve um arquivo, criando o diretório se preciso. */
async function put(rel, body) {
  const path = join(root, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
  return path
}

const issue = (title, status, extra = '') =>
  `Status: ${status}\nType: task\n${extra}\n# ${title}\n\nUm corpo qualquer.\n`

/**
 * O stream SSE, lido com o `fetch` nativo — sem `EventSource` (do browser) e sem biblioteca.
 * O nome do evento é asserção: `message` carrega a árvore inteira; `files` carrega só os
 * caminhos que mexeram no disco. Cada evento chega como `{ event, ...payload }`.
 */
async function openStream() {
  const ac = new AbortController()
  const res = await fetch(`${base}/api/stream`, { signal: ac.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const queue = []
  let wake = null
  let buf = ''

  ;(async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let cut
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, cut)
          buf = buf.slice(cut + 2)
          const lines = frame.split('\n')
          const data = lines
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n')
          if (!data) continue // `retry:` e os `: ping` não são eventos
          const named = lines.find((l) => l.startsWith('event: '))
          queue.push({ event: named ? named.slice(7) : 'message', ...JSON.parse(data) })
          wake?.()
          wake = null
        }
      }
    } catch { /* abortado no fim do teste */ }
  })()

  const nap = (ms) => new Promise((ok) => setTimeout(ok, ms))

  const stream = {
    async next(ms = 4000) {
      const deadline = Date.now() + ms
      while (!queue.length) {
        if (Date.now() > deadline) throw new Error('o servidor não empurrou nada')
        await Promise.race([new Promise((ok) => (wake = ok)), nap(50)])
      }
      return queue.shift()
    },
    async silence(ms = 700) {
      await nap(ms)
      assert.deepEqual(queue, [], 'o servidor empurrou um evento que não devia existir')
    },
    async count(ms = 700) {
      await nap(ms)
      return queue.length
    },
    drain: () => queue.splice(0, queue.length),
    close: () => ac.abort(),
  }

  await stream.next() // o snapshot de conexão
  return stream
}

const get = (path) => fetch(`${base}${path}`)
/** A projeção de uma origem: `{ ns, root, tree }`. */
const board = async () => (await get('/api/board?ns=projetos')).json()

/** Acha um nó pelo nome, em qualquer profundidade — a árvore não é plana. */
function find(nodes, name) {
  for (const n of nodes) {
    if (n.name === name) return n
    if (n.children) {
      const hit = find(n.children, name)
      if (hit) return hit
    }
  }
  return null
}

/** A posição de um nó no nível raiz — a ordem por atividade. */
const posOf = (tree, name) => tree.findIndex((n) => n.name === name)

/** Envelhece um arquivo. `utimes` fabrica o tempo no disco — não há relógio a mockar. */
const age = (rel, days) => {
  const when = new Date(Date.now() - days * 864e5)
  return utimes(join(root, rel), when, when)
}

before(async () => {
  mounts = await mkdtemp(join(tmpdir(), 'board-mounts-'))
  root = join(mounts, 'projetos', '.scratch')
  await mkdir(root, { recursive: true })
  process.env.REPOS_DIR = mounts

  await put('alpha/map.md', '# Mapa do alpha\n\nO primeiro parágrafo.\n')
  await put('alpha/issues/01-um.md', issue('01 — Um', 'resolved'))
  await put('alpha/issues/02-dois.md', issue('02 — Dois', 'ready-for-agent'))

  // Depois do ambiente, nunca antes: o `paths.js` resolve os roots no import.
  const mod = await import('../src/server.js')
  server = await mod.start(0)
  base = `http://127.0.0.1:${server.port}`
})

after(async () => {
  await server?.close()
  await rm(mounts, { recursive: true, force: true })
})

test('/api/board?ns= serve a árvore da origem, com os três vocabulários de caminho', async () => {
  const b = await board()
  assert.equal(b.ns, 'projetos')
  assert.equal(b.root, root)
  // O `ref` de **topo** é o da origem — nu na de casa —, não o de um nó. É dele que o
  // cliente monta o nó-raiz sintético (`#/<ns>` sozinho, sem `rel`) sem nunca usar `root`
  // (o caminho do container) como `ref`.
  assert.equal(b.ref, '.scratch')
  assert.equal('error' in b, false, 'origem sã não carrega erro')

  const alpha = find(b.tree, 'alpha')
  assert.equal(alpha.type, 'dir')
  // A origem de casa produz `ref` nu: os comandos partem de `/root/projetos`, e
  // `projetos/.scratch/...` seria um caminho que não existe de lá.
  assert.equal(alpha.ref, '.scratch/alpha')
  assert.equal(alpha.rel, 'alpha', 'o rel é a chave de rota, relativo à raiz')
  assert.equal(alpha.path, join(root, 'alpha'))
  assert.equal(alpha.ref.includes(mounts), false, 'o container nunca vaza para o vocabulário do humano')

  // O `.md` com cabeçalho ganha selo e título; nada mais é exigido da estrutura.
  const um = find(b.tree, '01-um.md')
  assert.equal(um.type, 'file')
  assert.equal(um.status, 'resolved')
  assert.equal(um.title, '01 — Um')
  assert.equal(typeof um.mtime, 'number', 'o nó carrega o mtime — o cliente calcula o "há 2h" com ele')
})

test('nenhum `ref` — nem o de topo, nem o de um nó — carrega o caminho do container', async () => {
  // `root`/`path` **devem** carregar o caminho do container (é o vocabulário de leitura,
  // por contrato) — a garantia é só sobre `ref`, o vocabulário que a UI mostra e copia. O
  // bug desta rodada era exatamente um `ref` (do nó-raiz sintético, no cliente) recebendo
  // `board.root`; a defesa do lado do servidor é garantir que o `ref` que ele serve nunca
  // é, ele mesmo, o caminho do container — em nenhum nível da árvore.
  const b = await board()
  assert.equal(b.ref.includes(mounts), false, 'o `ref` de topo (da origem) não pode ser o `root`')

  const walk = (nodes) => {
    for (const n of nodes) {
      assert.equal(n.ref.includes(mounts), false, `o \`ref\` de ${n.rel} não pode carregar o container`)
      if (n.children) walk(n.children)
    }
  }
  walk(b.tree)
})

test('a árvore sai ordenada por atividade: a pasta com o arquivo mais novo abre a tela', async () => {
  await put('gelado/PRD.md', '# Gelado\n\nNinguém toca há uma semana.\n')
  await put('quente/PRD.md', '# Quente\n\nAcabaram de mexer.\n')
  await age('gelado/PRD.md', 7)

  const { tree } = await board()
  assert.ok(posOf(tree, 'quente') < posOf(tree, 'gelado'), 'a pasta quente vem antes da gelada')
  assert.equal(tree.at(-1).name, 'gelado', 'a pasta parada há uma semana afunda para o fim')
})

test('escrever um .md empurra uma árvore nova (message), e ela reflete a mudança', async () => {
  const stream = await openStream()
  try {
    const alvo = await put('alpha/issues/02-dois.md', issue('02 — Dois', 'resolved'))

    const ev = await stream.next()
    assert.equal(ev.event, 'message', 'a árvore mudou: o evento carrega a árvore')
    assert.equal(ev.ns, 'projetos', 'o evento nunca é anônimo')
    assert.equal(find(ev.board.tree, '02-dois.md').status, 'resolved')
    assert.ok(
      ev.changed.includes(alvo),
      'o `message` também carrega os caminhos que mexeram — o visualizador vivo os consulta',
    )
  } finally {
    stream.close()
  }
})

test('reescrever um arquivo com o MESMO conteúdo e mtime NÃO empurra nada', async () => {
  const same = issue('02 — Dois', 'resolved')
  const path = join(root, 'alpha/issues/02-dois.md')
  const fixed = new Date('2026-02-02T02:02:02.000Z')
  await writeFile(path, same)
  await utimes(path, fixed, fixed)
  await board() // fixa a baseline: hash e digest desta versão

  const stream = await openStream()
  try {
    await writeFile(path, same)
    await utimes(path, fixed, fixed) // mesmos bytes, mesmo mtime: nada mudou
    await stream.silence()
  } finally {
    stream.close()
  }
})

test('um arquivo oculto (.swp) NÃO empurra nada — nem `message` nem `files`', async () => {
  const stream = await openStream()
  try {
    // O disco de fato mexe, mas um caminho oculto não é projetado (nem pela árvore, nem pelo
    // digest do `movedFiles`): ele não pode estar aberto em visualizador nenhum.
    await put('alpha/issues/.02-dois.md.swp', 'lixo de editor')
    await rm(join(root, 'alpha/issues/.02-dois.md.swp'))
    await stream.silence()
  } finally {
    stream.close()
  }
})

test('a SEGUNDA escrita atômica do mesmo arquivo chega pelo digest — o watcher perde o nome, o digest não', async () => {
  // O caso que derruba a prescrição ingênua, e é como os agentes escrevem: grava um
  // `arquivo.md.tmp.NNNN` e faz `rename` por cima. O `fs.watch` recursivo do Node para de
  // reportar o nome depois que o `rename` troca o inode por baixo dele — da segunda edição em
  // diante só o `.tmp` aparece no relato do kernel, e o `.md` de verdade some.
  //
  // Se o `changed` saísse do watcher, o visualizador vivo funcionaria **uma vez por arquivo** e
  // depois calaria em silêncio. Ele sai do **digest** (`movedFiles`), e o watcher é só gatilho:
  // cada `.tmp` é um nome novo, e nome novo o kernel sempre reporta.
  //
  // Não se afirma o **tipo** do evento (dois saves podem cair no mesmo milissegundo de `mtime`
  // e virar `files` em vez de `message`); o que se afirma é o que importa: o caminho **chega**.
  const alvo = join(root, 'alpha/issues/03-atomica.md')
  const header = 'Status: resolved\nType: task\n\n# 03 — Atômica\n\n'

  const atomica = async (corpo) => {
    const tmp = `${alvo}.tmp.${Math.random().toString(16).slice(2)}`
    await writeFile(tmp, header + corpo)
    await rename(tmp, alvo)
  }

  const stream = await openStream()
  try {
    await atomica('O corpo original.\n')
    const criado = await stream.next()
    assert.ok(criado.changed.includes(alvo), 'a criação atômica tem que aparecer no changed')

    // Da segunda em diante o watcher já perdeu o nome do arquivo. O digest continua o pegando.
    for (const corpo of ['## Answer\n\nPrimeira versão, mais longa que a anterior.\n', '## Answer\n\nSegunda.\n']) {
      await atomica(corpo)
      const ev = await stream.next()
      assert.ok(
        ev.changed.includes(alvo),
        `a edição atômica sumiu do changed: ${JSON.stringify(ev.changed)}`,
      )
      // O `.tmp` nasceu e morreu: ele não é documento de ninguém e não viaja.
      assert.equal(ev.changed.length, 1, 'só o arquivo de verdade viaja — nem o .tmp, nem mais nada')
    }
  } finally {
    stream.close()
  }
})

test('conteúdo que muda sem mover a árvore emite `files` — os caminhos, e nenhuma árvore', async () => {
  // A supressão do arquivo, isolada: a árvore projeta estrutura, status e título — e `mtime`.
  // Se o `mtime` é preservado e só o **corpo** muda, a árvore fica byte-a-byte idêntica (o hash
  // não se move), mas o digest do conteúdo vê a diferença. É o evento `files`, que avisa quem
  // lê o documento sem repintar a tela inteira.
  const path = join(root, 'files-only/doc.md')
  const fixed = new Date('2026-03-03T03:03:03.000Z')
  await mkdir(join(root, 'files-only'), { recursive: true })
  await writeFile(path, 'Status: open\n# Doc\n\nversão um, curta\n')
  await utimes(path, fixed, fixed)
  await board() // baseline com o mtime fixo

  const stream = await openStream()
  try {
    // Só o corpo muda (tamanho diferente), e o mtime volta ao mesmo instante: a árvore não se move.
    await writeFile(path, 'Status: open\n# Doc\n\nversão dois, bem mais comprida que a primeira\n')
    await utimes(path, fixed, fixed)

    const ev = await stream.next()
    assert.equal(ev.event, 'files', 'conteúdo mudou e a árvore não: tem que ser o evento dos caminhos')
    assert.equal(ev.ns, 'projetos')
    assert.ok(ev.changed.includes(path), 'o evento tem que dizer QUAL arquivo mudou')
    assert.equal('board' in ev, false, 'o evento `files` não carrega a árvore')
  } finally {
    stream.close()
  }
})

test('uma rajada de seis escritas vira UM evento, não seis', async () => {
  const stream = await openStream()
  try {
    for (let n = 1; n <= 6; n++) {
      await put(`rajada/issues/0${n}-t.md`, issue(`0${n} — T`, 'ready-for-agent'))
    }
    const events = await stream.count(900)
    assert.equal(events, 1, `o debounce falhou: ${events} eventos para uma rajada`)

    const ev = await stream.next()
    assert.equal(find(ev.board.tree, 'rajada').children.find((c) => c.name === 'issues').children.length, 6)
  } finally {
    stream.close()
  }
})

test('uma pasta nova — que não existia quando o servidor subiu — aparece sem reiniciar nada', async () => {
  const stream = await openStream()
  try {
    await put('nasceu-agora/PRD.md', '# Recém-nascido\n\nExiste agora.\n')

    const ev = await stream.next()
    const novo = find(ev.board.tree, 'nasceu-agora')
    assert.ok(novo, 'o watch recursivo não pegou o diretório novo')
    assert.equal(find(ev.board.tree, 'PRD.md').title, 'Recém-nascido')
  } finally {
    stream.close()
  }
})

test('/api/board recusa uma origem que não existe', async () => {
  const res = await get('/api/board?ns=fantasma')
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /origem não encontrada/)
})

test('/api/file recusa um caminho fora dos roots', async () => {
  const fora = await get('/api/file?path=/etc/passwd')
  assert.equal(fora.status, 400)
  assert.match((await fora.json()).error, /fora dos diretórios permitidos/)

  const traversal = await get(`/api/file?path=${encodeURIComponent(join(root, '../../etc/passwd'))}`)
  assert.equal(traversal.status, 400)

  const vazio = await get('/api/file?path=')
  assert.equal(vazio.status, 400)
})

test('/api/file serve o corpo cru; um arquivo ausente responde 404 com o corpo `não encontrado`', async () => {
  const ok = await get(`/api/file?path=${encodeURIComponent(join(root, 'alpha/map.md'))}`)
  assert.equal(ok.status, 200)
  assert.match(ok.headers.get('content-type'), /text\/plain/)
  assert.match(await ok.text(), /Mapa do alpha/)

  const fantasma = await get(`/api/file?path=${encodeURIComponent(join(root, 'alpha/nao-existe.md'))}`)
  assert.equal(fantasma.status, 404)
  assert.equal(await fantasma.text(), 'não encontrado', 'a string do 404 é contrato — o visualizador a procura')
})

test('/api/file responde 413 acima de 512 KB', async () => {
  await put('grande/enorme.bin', 'x'.repeat(512 * 1024 + 1))
  const res = await get(`/api/file?path=${encodeURIComponent(join(root, 'grande/enorme.bin'))}`)
  assert.equal(res.status, 413)
})

test('/api/graph devolve mode:`deps` com aresta quando há Blocked by:', async () => {
  await put('grafo-deps/issues/01-base.md', issue('01 — Base', 'ready-for-agent'))
  await put(
    'grafo-deps/issues/02-preso.md',
    issue('02 — Preso', 'ready-for-agent', 'Blocked by: 01 — a base tem que existir antes'),
  )
  const folder = join(root, 'grafo-deps')
  const g = await (await get(`/api/graph?ns=projetos&path=${encodeURIComponent(folder)}`)).json()

  assert.equal(g.mode, 'deps', 'um Blocked by: na subárvore força o modo deps')
  assert.equal(g.nodes.length, 2)
  const base = g.nodes.find((n) => n.name === '01-base.md')
  const preso = g.nodes.find((n) => n.name === '02-preso.md')
  assert.equal(base.id, base.path, 'o id do nó é o path')
  assert.equal(base.rel, 'grafo-deps/issues/01-base.md', 'o rel é a chave de rota')
  assert.equal(base.status, 'ready-for-agent')

  assert.equal(g.edges.length, 1)
  const [edge] = g.edges
  assert.equal(edge.from, base.path, 'a aresta sai do bloqueante')
  assert.equal(edge.to, preso.path, 'e entra no bloqueado')
  assert.equal(edge.note, '— a base tem que existir antes', 'a nota é a prosa do fragmento')
})

test('/api/graph devolve mode:`links` quando não há Blocked by:, resolvendo os links por caminho real', async () => {
  await put('grafo-links/a.md', '# A\n\nvai para [o b](b.md)\n')
  await put('grafo-links/b.md', '# B\n\nvai para [o c](c.md)\n')
  await put('grafo-links/c.md', '# C\n\nfolha, não cita ninguém\n')
  const folder = join(root, 'grafo-links')
  const g = await (await get(`/api/graph?ns=projetos&path=${encodeURIComponent(folder)}`)).json()

  assert.equal(g.mode, 'links', 'sem Blocked by:, o grafo é o de links markdown')
  assert.equal(g.nodes.length, 3)
  const byName = Object.fromEntries(g.nodes.map((n) => [n.name, n]))

  assert.equal(g.edges.length, 2)
  assert.ok(g.edges.some((e) => e.from === byName['a.md'].path && e.to === byName['b.md'].path))
  assert.ok(g.edges.some((e) => e.from === byName['b.md'].path && e.to === byName['c.md'].path))
  // Link não carrega justificativa.
  for (const e of g.edges) assert.equal('note' in e, false, 'aresta de link não tem note')
})

test('o board é servível: /, /app.js, /router.js e o /shared/parse.js que o browser importa', async () => {
  // O `md.js` do browser faz `import ... from '../shared/parse.js'` — que na URL vira
  // `/shared/parse.js`. Se essa rota morrer num corte, o import falha **em silêncio** e o
  // board não monta. Nenhum teste de unidade percebe: a rede do parser roda no filesystem.
  for (const [path, type] of [
    ['/', /text\/html/],
    ['/app.js', /javascript/],
    ['/router.js', /javascript/],
    ['/shared/parse.js', /javascript/],
  ]) {
    const res = await get(path)
    assert.equal(res.status, 200, `${path} não respondeu 200`)
    assert.match(res.headers.get('content-type'), type, `${path} veio com o tipo errado`)
  }

  const parser = await (await get('/shared/parse.js')).text()
  assert.match(parser, /export function parseDoc/, 'o /shared/parse.js não é o parser')

  // E o estático não escapa do seu root.
  assert.equal((await get('/shared/../src/server.js')).status, 404)
})
