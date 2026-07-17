/**
 * As origens: N `.scratch/` no mesmo board, e o que isso obriga a ser verdade.
 *
 * Tudo que este arquivo afirma **só existe com mais de uma origem** — e é por isso que ele
 * existe. O `server.test.js` prova o push; aqui se prova que o push de uma origem não
 * atravessa a outra, que dois esforços com o mesmo slug são dois esforços, e que uma origem
 * quebrada não derruba as demais.
 *
 * Os modos de falha que ele guarda são todos **silenciosos**:
 *
 *   - a supressão de uma origem engolir a mudança da outra (um `Map` global esquecido, um
 *     hash compartilhado) — o board de uma delas simplesmente para de chegar, e "parou de
 *     chegar" é byte-a-byte igual a "nada mudou";
 *   - o evento não dizer de que origem fala — o cliente guarda o board no lugar errado, e a
 *     tela mostra os esforços de um repositório sob o nome de outro;
 *   - o `ref` sair com o caminho do container, ou nu numa origem que não é a de casa — o
 *     comando copiado não leva a lugar nenhum, e ninguém descobre até colá-lo num agente;
 *   - uma leitura que estoura numa origem derrubar a montagem das outras — o board inteiro
 *     vira uma tela vazia por causa de um arquivo.
 *
 * Cinco origens, e o diretório comum é o único lugar em que elas são declaradas: cada
 * subpasta **é** um namespace. É o que o compose faz com um mount; aqui, com um `mkdir`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mounts // o diretório comum: cada filho dele é uma origem
let pads
let hist // o catálogo: temporário, para o teste não escrever no volume de produção
let server
let base

/** Escreve dentro de uma origem, criando o que faltar. É o equivalente a um mount novo. */
async function put(ns, rel, body) {
  const path = join(mounts, ns, '.scratch', rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
  return path
}

const issue = (title, status, extra = '') =>
  `Status: ${status}\nType: task\n${extra}\n# ${title}\n\nUm corpo qualquer.\n`

/** O stream SSE lido com o `fetch` nativo — o `EventSource` é do browser. */
async function openStream({ snapshot = true } = {}) {
  const ac = new AbortController()
  const res = await fetch(`${base}/api/stream`, { signal: ac.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const queue = []
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
        await nap(30)
      }
      return queue.shift()
    },
    /** Todos os eventos que chegarem em `ms`. */
    async drain(ms = 700) {
      await nap(ms)
      return queue.splice(0, queue.length)
    },
    async silence(ms = 700) {
      await nap(ms)
      assert.deepEqual(queue, [], 'o servidor empurrou um evento que não devia existir')
    },
    close: () => ac.abort(),
  }

  // O snapshot de conexão é **um frame por origem**: quem reconecta não sabe quanto tempo
  // ficou fora, e as origens que não estão na tela também podem ter andado.
  if (snapshot) await stream.drain(250)
  return stream
}

const boards = async () => (await (await fetch(`${base}/api/board`)).json()).boards
const effortOf = (b, slug) => b.efforts.find((e) => e.slug === slug)

before(async () => {
  mounts = await mkdtemp(join(tmpdir(), 'board-ns-'))
  pads = await mkdtemp(join(tmpdir(), 'board-ns-pads-'))
  hist = await mkdtemp(join(tmpdir(), 'board-ns-hist-'))
  process.env.REPOS_DIR = mounts
  process.env.PADS_DIR = pads
  // O catálogo também sai do ambiente, e também é resolvido no import. Sem isto o
  // servidor do teste escreveria no `HISTORY` de produção (`/workspace/history`).
  process.env.HISTORY_DIR = hist

  // A origem de casa, e um esforço nela.
  await put('projetos', 'comum/map.md', '# O esforço de casa\n\nO primeiro parágrafo.\n')
  await put('projetos', 'comum/issues/01-um.md', issue('01 — Um', 'resolved'))
  await put('projetos', 'comum/issues/02-dois.md', issue('02 — Dois', 'ready-for-agent'))

  // A segunda origem — e **o mesmo slug**. É o caso que um board com um root só nunca teve
  // como ter: dois esforços de nome igual que não são o mesmo esforço.
  await put('vend-server', 'comum/map.md', '# O esforço do vend\n\nOutro parágrafo, outro repo.\n')
  await put('vend-server', 'comum/issues/01-um.md', issue('01 — Um, mas do vend', 'claimed'))

  // Uma origem montada e vazia: um repo que ainda não tem esforço nenhum. Vazio é um
  // estado, não uma falha.
  await mkdir(join(mounts, 'vazia', '.scratch'), { recursive: true })

  // E uma que **não dá para ler**: um diretório onde o board espera um `.md`. O `readFile`
  // estoura `EISDIR`, que é uma falha de leitura de verdade — não um `chmod` que o root
  // ignoraria. É o que prova que a falha fica contida na origem que a sofreu.
  await mkdir(join(mounts, 'quebrada', '.scratch', 'ruim', 'issues', '01-nao-e-arquivo.md'), {
    recursive: true,
  })

  const mod = await import('../src/server.js')
  server = await mod.start(0)
  base = `http://127.0.0.1:${server.port}`
})

after(async () => {
  await server?.close()
  await rm(mounts, { recursive: true, force: true })
  await rm(pads, { recursive: true, force: true })
  await rm(hist, { recursive: true, force: true })
})

test('cada subpasta do diretório comum é uma origem: casa primeiro, o resto em ordem alfabética', async () => {
  // A configuração é o compose e mais nada — não há lista em env nem arquivo de config, e
  // é por isso que o teste não passa lista nenhuma: ele cria pastas.
  const { namespaces } = await (await fetch(`${base}/api/board`)).json()
  assert.deepEqual(namespaces, ['projetos', 'quebrada', 'vazia', 'vend-server'])
  assert.deepEqual(
    server.namespaces.map((ns) => ns.name),
    ['projetos', 'quebrada', 'vazia', 'vend-server'],
  )
})

test('o ref de casa é nu; o das outras origens é qualificado — e nenhum mostra o container', async () => {
  // O `ref` é o que se cola num agente, e o agente roda em `/root/projetos`. De lá,
  // `.scratch/comum` é o esforço de casa, e `vend-server/.scratch/comum` é o do vend. Um
  // `ref` nu na origem errada apontaria para o esforço errado — que **existe**, porque o
  // slug é o mesmo. É a forma mais silenciosa possível de errar.
  const b = await boards()

  assert.equal(effortOf(b.projetos, 'comum').ref, '.scratch/comum')
  assert.equal(effortOf(b['vend-server'], 'comum').ref, 'vend-server/.scratch/comum')

  assert.equal(
    effortOf(b['vend-server'], 'comum').issues[0].ref,
    'vend-server/.scratch/comum/issues/01-um.md',
  )

  // O caminho interno do container nunca é apresentado ao humano.
  for (const board of Object.values(b)) {
    for (const e of board.efforts) {
      assert.equal(e.ref.includes(mounts), false, `o ref de ${e.ns}/${e.slug} vazou o container`)
      for (const i of e.issues) assert.equal(i.ref.includes(mounts), false)
    }
  }
})

test('dois esforços com o mesmo slug em origens diferentes são dois esforços', async () => {
  const b = await boards()
  const casa = effortOf(b.projetos, 'comum')
  const vend = effortOf(b['vend-server'], 'comum')

  // Mesmo slug, tudo o mais diferente: título, contagem, issues, caminho.
  assert.equal(casa.slug, vend.slug)
  assert.equal(casa.ns, 'projetos')
  assert.equal(vend.ns, 'vend-server')
  assert.equal(casa.title, 'O esforço de casa')
  assert.equal(vend.title, 'O esforço do vend')
  assert.equal(casa.total, 2)
  assert.equal(vend.total, 1)
  assert.notEqual(casa.path, vend.path)
  assert.notEqual(casa.issues[0].path, vend.issues[0].path)
})

test('escrever numa origem empurra só o board dela, e o evento diz de qual origem fala', async () => {
  const stream = await openStream()
  try {
    await put('vend-server', 'comum/issues/02-nova.md', issue('02 — Nova', 'ready-for-agent'))

    const ev = await stream.next()
    assert.equal(ev.event, 'message')
    // Sem o `ns`, o cliente guardaria este board no lugar errado — e a tela mostraria os
    // esforços do vend sob o nome do projetos.
    assert.equal(ev.ns, 'vend-server', 'o evento não diz de que origem veio')
    assert.equal(ev.board.ns, 'vend-server')
    assert.equal(effortOf(ev.board, 'comum').total, 2)

    // E **só** o board dela viaja: mandar as N origens em todo evento seria pagar o board
    // do projetos toda vez que alguém escreve no vend.
    assert.equal('boards' in ev, false)

    // A origem que não mexeu não emite byte nenhum. É a supressão de cada origem decidindo
    // por si — um hash compartilhado empurraria as duas aqui.
    await stream.silence()
  } finally {
    stream.close()
  }
})

test('a supressão não atravessa origens: cada uma tem o seu hash e o seu digest', async () => {
  const mesmo = issue('01 — Um', 'resolved')
  const stream = await openStream()
  try {
    // Reescrever, na origem de casa, o conteúdo que já está lá: byte-idêntico, ninguém é
    // avisado. Nada disto é novo — o que é novo é que a escrita **na outra origem**, logo em
    // seguida, continua chegando. Um `seen` global teria acabado de aprender este caminho.
    await put('projetos', 'comum/issues/01-um.md', mesmo)
    await stream.silence(500)

    await put('vend-server', 'comum/issues/01-um.md', issue('01 — Um, mas do vend', 'resolved'))
    const ev = await stream.next()
    assert.equal(ev.ns, 'vend-server')
    assert.equal(ev.event, 'message')
    assert.equal(effortOf(ev.board, 'comum').closed, 1)

    // E o board de casa não se moveu: a escrita do vend não o reconstruiu na tela de ninguém.
    assert.equal(effortOf((await boards()).projetos, 'comum').closed, 1)
  } finally {
    stream.close()
  }
})

test('a edição de corpo numa origem emite o `files` dela — a gaveta viva vale em todas', async () => {
  const header = 'Status: resolved\nType: task\n\n# 01 — Um, mas do vend\n\n'
  const alvo = join(mounts, 'vend-server', '.scratch', 'comum/issues/01-um.md')

  const stream = await openStream()
  try {
    await put('vend-server', 'comum/issues/01-um.md', `${header}## Answer\n\nA resposta.\n`)

    const ev = await stream.next()
    assert.equal(ev.event, 'files')
    assert.equal(ev.ns, 'vend-server', 'nem o evento dos caminhos pode ser anônimo')
    assert.deepEqual(ev.changed, [alvo])
    assert.equal('board' in ev, false)
  } finally {
    stream.close()
  }
})

test('uma origem vazia aparece vazia — e vazia não é quebrada', async () => {
  const b = await boards()
  assert.deepEqual(b.vazia.efforts, [])
  assert.deepEqual(b.vazia.archived, [])
  assert.equal('error' in b.vazia, false, 'um repo sem esforço não é uma falha de leitura')
  // Ela ainda é uma origem completa: tem o vocabulário do board e o seu `ref`.
  assert.equal(b.vazia.ref, 'vazia/.scratch')
  assert.ok(b.vazia.columns.length)
})

test('uma falha de leitura fica contida na origem que a sofreu', async () => {
  const b = await boards()

  // A origem quebrada **diz que quebrou**. Servir uma lista vazia aqui seria a mentira cara:
  // um repositório cheio de esforços apareceria como um repositório sem nenhum.
  assert.ok(b.quebrada.error, 'a origem quebrada não disse que quebrou')
  assert.match(b.quebrada.error, /EISDIR|illegal operation/i)
  assert.deepEqual(b.quebrada.efforts, [])

  // E as outras continuam de pé, inteiras. Sem contenção, um `readFile` que estoura numa
  // origem derrubaria a montagem de todas — o board inteiro vira tela vazia por um arquivo.
  assert.equal(effortOf(b.projetos, 'comum').total, 2)
  assert.equal(effortOf(b['vend-server'], 'comum').total, 2)
})

test('o erro de uma origem passa pelo hash: ele é empurrado uma vez, não a cada varredura', async () => {
  // A origem quebrada continua quebrada, e a varredura continua passando por ela. Se o board
  // de erro não passasse pela supressão, ela empurraria o mesmo erro para sempre — o board
  // gritando de 90 em 90 segundos que um arquivo continua sendo um diretório.
  const stream = await openStream()
  try {
    await stream.silence(600)
  } finally {
    stream.close()
  }
})

test('o snapshot de conexão traz TODAS as origens, uma por frame — quem reconecta não sabe quanto perdeu', async () => {
  const stream = await openStream({ snapshot: false })
  try {
    const frames = await stream.drain(400)

    assert.deepEqual(
      frames.map((f) => f.ns),
      ['projetos', 'quebrada', 'vazia', 'vend-server'],
      'o snapshot não mandou uma origem por frame, na ordem das abas',
    )
    for (const f of frames) {
      assert.equal(f.event, 'message')
      assert.ok(f.board, 'o snapshot tem que carregar o board, não só anunciá-lo')
      // `changed: []` quer dizer "não sei o que mudou" — e é assim que a gaveta o lê.
      assert.deepEqual(f.changed, [])
    }
  } finally {
    stream.close()
  }
})

test('o /api/file alcança as duas origens, e continua recusando o que está fora de todas', async () => {
  // O `safePath()` é o de sempre, com a lista dos roots descobertos no lugar dos dois roots
  // fixos. Nenhuma política nova de `realpath`, nenhum endurecimento novo de symlink.
  const b = await boards()

  for (const [ns, trecho] of [
    ['projetos', 'O esforço de casa'],
    ['vend-server', 'O esforço do vend'],
  ]) {
    const alvo = `${effortOf(b[ns], 'comum').path}/map.md`
    const res = await fetch(`${base}/api/file?path=${encodeURIComponent(alvo)}`)
    assert.equal(res.status, 200, `o /api/file não leu o map.md da origem ${ns}`)
    assert.match((await res.json()).content, new RegExp(trecho))
  }

  const fora = await fetch(`${base}/api/file?path=/etc/passwd`)
  assert.equal(fora.status, 400)
  assert.match((await fora.json()).error, /fora dos diretórios permitidos/)

  // E o diretório comum **não** é um root: ele contém as origens, mas não é uma delas.
  const comum = await fetch(`${base}/api/file?path=${encodeURIComponent(join(mounts, 'qualquer.md'))}`)
  assert.equal(comum.status, 400)
})
