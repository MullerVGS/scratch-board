/**
 * As origens: N `.scratch/` no mesmo board, e o que isso obriga a ser verdade.
 *
 * Tudo que este arquivo afirma **só existe com mais de uma origem** — e é por isso que ele
 * existe. O `server.test.js` prova o push; aqui se prova que o push de uma origem não
 * atravessa a outra, que dois esforços com o mesmo slug são duas pastas distintas, e que uma
 * origem quebrada não derruba as demais.
 *
 * Os modos de falha que ele guarda são todos **silenciosos**:
 *
 *   - a supressão de uma origem engolir a mudança da outra (um hash compartilhado) — a árvore
 *     de uma delas simplesmente para de chegar, e "parou de chegar" é igual a "nada mudou";
 *   - o evento não dizer de que origem fala — o cliente guarda a árvore no lugar errado;
 *   - o `ref` sair com o caminho do container, ou nu numa origem que não é a de casa;
 *   - uma leitura que estoura numa origem derrubar a montagem das outras.
 *
 * Quatro origens, e o diretório comum é o único lugar em que elas são declaradas: cada
 * subpasta **é** um namespace. É o que o compose faz com um mount; aqui, com um `mkdir`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mounts // o diretório comum: cada filho dele é uma origem
let server
let base

/** Escreve dentro de uma origem, criando o que faltar. É o equivalente a um mount novo. */
async function put(ns, rel, body) {
  const path = join(mounts, ns, '.scratch', rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
  return path
}

/** Escreve na origem de subpasta: `docs/tarefas` do vend-server, declarada em `FOLDERS`. */
async function putTarefa(rel, body) {
  const path = join(mounts, 'vend-server', 'docs', 'tarefas', rel)
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

  if (snapshot) await stream.drain(250)
  return stream
}

const boardOf = async (ns) => (await fetch(`${base}/api/board?ns=${ns}`)).json()

/** Acha um nó pelo nome, em qualquer profundidade. */
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

before(async () => {
  mounts = await mkdtemp(join(tmpdir(), 'board-ns-'))
  process.env.REPOS_DIR = mounts
  process.env.FOLDERS = 'vend-tarefas=vend-server/docs/tarefas'

  // A origem de casa, e um esforço nela.
  await put('projetos', 'comum/map.md', '# O esforço de casa\n\nO primeiro parágrafo.\n')
  await put('projetos', 'comum/issues/01-um.md', issue('01 — Um', 'resolved'))
  await put('projetos', 'comum/issues/02-dois.md', issue('02 — Dois', 'ready-for-agent'))

  // A segunda origem — e **o mesmo slug**. Duas pastas de nome igual que não são a mesma.
  await put('vend-server', 'comum/map.md', '# O esforço do vend\n\nOutro parágrafo, outro repo.\n')
  await put('vend-server', 'comum/issues/01-um.md', issue('01 — Um, mas do vend', 'claimed'))

  // Uma origem montada e vazia: um repo que ainda não tem esforço nenhum. Vazio é um estado.
  await mkdir(join(mounts, 'vazia', '.scratch'), { recursive: true })

  // E uma que **não dá para ler**: o `.scratch/` é um **arquivo**, não um diretório. O
  // `readdir` do root estoura `ENOTDIR`, uma falha de leitura de verdade — e é o que prova que
  // ela fica contida na origem que a sofreu, em vez de derrubar a montagem das outras.
  await mkdir(join(mounts, 'quebrada'), { recursive: true })
  await writeFile(join(mounts, 'quebrada', '.scratch'), 'isto devia ser um diretório')

  // Uma subpasta do repo já montado como origem própria, no dialeto do harness POS.
  await putTarefa('presenca/spec.md', '# Presença\n\nA spec.\n')
  await putTarefa('presenca/issues/01-registro.md', 'Status: concluída\n\n# 01 — Registro\n')
  await putTarefa('presenca/issues/02-operador.md', 'Status: aberta\nBloqueada por: 01\n\n# 02 — Operador\n')

  const mod = await import('../src/server.js')
  server = await mod.start(0)
  base = `http://127.0.0.1:${server.port}`
})

after(async () => {
  await server?.close()
  await rm(mounts, { recursive: true, force: true })
})

test('cada subpasta do diretório comum é uma origem: casa primeiro, o resto em ordem alfabética', async () => {
  // A configuração é o compose e mais nada — não há lista em env nem arquivo de config, e é por
  // isso que o teste não passa lista nenhuma: ele cria pastas.
  assert.deepEqual(
    server.namespaces.map((ns) => ns.name),
    ['projetos', 'quebrada', 'vazia', 'vend-server', 'vend-tarefas'],
  )
})

test('o ref de casa é nu; o das outras origens é qualificado — e nenhum mostra o container', async () => {
  // O `ref` é o que se cola num agente, e o agente roda em `/root/projetos`. Um `ref` nu na
  // origem errada apontaria para o esforço errado — que **existe**, porque o slug é o mesmo.
  const casa = await boardOf('projetos')
  const vend = await boardOf('vend-server')

  assert.equal(find(casa.tree, 'comum').ref, '.scratch/comum')
  assert.equal(find(vend.tree, 'comum').ref, 'vend-server/.scratch/comum')
  assert.equal(find(vend.tree, '01-um.md').ref, 'vend-server/.scratch/comum/issues/01-um.md')

  for (const b of [casa, vend]) {
    const walk = (nodes) => {
      for (const n of nodes) {
        assert.equal(n.ref.includes(mounts), false, `o ref de ${n.name} vazou o container`)
        if (n.children) walk(n.children)
      }
    }
    walk(b.tree)
  }
})

test('duas pastas com o mesmo slug em origens diferentes são duas pastas', async () => {
  const casa = find((await boardOf('projetos')).tree, 'comum')
  const vend = find((await boardOf('vend-server')).tree, 'comum')

  assert.equal(casa.name, vend.name)
  assert.notEqual(casa.path, vend.path)
  assert.equal(casa.ref, '.scratch/comum')
  assert.equal(vend.ref, 'vend-server/.scratch/comum')
  // A de casa tem o map + duas issues; a do vend, map + uma. Estrutura distinta, mesmo nome.
  assert.equal(find(casa.children, 'issues').children.length, 2)
  assert.equal(find(vend.children, 'issues').children.length, 1)
})

test('escrever numa origem empurra só a árvore dela, e o evento diz de qual origem fala', async () => {
  const stream = await openStream()
  try {
    await put('vend-server', 'comum/issues/02-nova.md', issue('02 — Nova', 'ready-for-agent'))

    const ev = await stream.next()
    assert.equal(ev.event, 'message')
    // Sem o `ns`, o cliente guardaria esta árvore no lugar errado.
    assert.equal(ev.ns, 'vend-server', 'o evento não diz de que origem veio')
    assert.equal(ev.board.ns, 'vend-server')
    assert.ok(find(ev.board.tree, '02-nova.md'), 'a árvore empurrada é a do vend')

    // E **só** a árvore dela viaja: mandar as N em todo evento seria pagar as outras à toa.
    assert.equal('boards' in ev, false)

    // A origem que não mexeu não emite byte nenhum.
    await stream.silence()
  } finally {
    stream.close()
  }
})

test('a supressão não atravessa origens: cada uma tem o seu hash e o seu digest', async () => {
  const mesmo = issue('01 — Um', 'resolved')
  const fixed = new Date('2026-04-04T04:04:04.000Z')
  const casaPath = join(mounts, 'projetos', '.scratch', 'comum/issues/01-um.md')
  await writeFile(casaPath, mesmo)
  await utimes(casaPath, fixed, fixed)
  await boardOf('projetos') // fixa a baseline da origem de casa

  const stream = await openStream()
  try {
    // Reescrever, na origem de casa, os mesmos bytes com o mesmo mtime: byte-idêntico, mudo.
    await writeFile(casaPath, mesmo)
    await utimes(casaPath, fixed, fixed)
    await stream.silence(500)

    // E a escrita na **outra** origem, logo em seguida, continua chegando — um hash global a
    // teria confundido com a de casa.
    await put('vend-server', 'comum/issues/01-um.md', issue('01 — Um, mas do vend', 'resolved'))
    const ev = await stream.next()
    assert.equal(ev.ns, 'vend-server')
    assert.equal(find(ev.board.tree, '01-um.md').status, 'resolved')
  } finally {
    stream.close()
  }
})

test('a edição de corpo numa origem emite o `files` dela — o visualizador vivo vale em todas', async () => {
  const path = join(mounts, 'vend-server', '.scratch', 'comum/vivo.md')
  const fixed = new Date('2026-05-05T05:05:05.000Z')
  await writeFile(path, 'Status: claimed\n# Vivo\n\ncurto\n')
  await utimes(path, fixed, fixed)
  await boardOf('vend-server') // baseline com o mtime fixo

  const stream = await openStream()
  try {
    await writeFile(path, 'Status: claimed\n# Vivo\n\ncorpo bem mais comprido, mesmo status e mesmo mtime\n')
    await utimes(path, fixed, fixed)

    const ev = await stream.next()
    assert.equal(ev.event, 'files')
    assert.equal(ev.ns, 'vend-server', 'nem o evento dos caminhos pode ser anônimo')
    assert.deepEqual(ev.changed, [path])
    assert.equal('board' in ev, false)
  } finally {
    stream.close()
  }
})

test('uma origem vazia aparece vazia — e vazia não é quebrada', async () => {
  const b = await boardOf('vazia')
  assert.deepEqual(b.tree, [])
  assert.equal('error' in b, false, 'um repo sem esforço não é uma falha de leitura')
  assert.equal(b.ns, 'vazia')
})

test('uma falha de leitura fica contida na origem que a sofreu', async () => {
  const b = await boardOf('quebrada')

  // A origem quebrada **diz que quebrou**. Servir uma árvore vazia aqui seria a mentira cara:
  // um repositório cheio apareceria como um repositório sem nada.
  assert.ok(b.error, 'a origem quebrada não disse que quebrou')
  assert.match(b.error, /ENOTDIR|not a directory/i)
  assert.deepEqual(b.tree, [])

  // E as outras continuam de pé, inteiras.
  assert.ok(find((await boardOf('projetos')).tree, 'comum'))
  assert.ok(find((await boardOf('vend-server')).tree, 'comum'))
})

test('o erro de uma origem passa pelo hash: ele é empurrado uma vez, não a cada varredura', async () => {
  // A origem quebrada continua quebrada, e a varredura continua passando por ela. Se a árvore
  // de erro não passasse pela supressão, ela empurraria o mesmo erro para sempre.
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
      ['projetos', 'quebrada', 'vazia', 'vend-server', 'vend-tarefas'],
      'o snapshot não mandou uma origem por frame, na ordem das abas',
    )
    for (const f of frames) {
      assert.equal(f.event, 'message')
      assert.ok(f.board, 'o snapshot tem que carregar a árvore, não só anunciá-la')
      // `changed: []` quer dizer "não sei o que mudou" — e é assim que o visualizador o lê.
      assert.deepEqual(f.changed, [])
    }
    // A origem quebrada aparece no snapshot com o seu erro, sem derrubar o frame das outras.
    assert.ok(frames.find((f) => f.ns === 'quebrada').board.error)
  } finally {
    stream.close()
  }
})

test('o /api/file alcança as duas origens, e continua recusando o que está fora de todas', async () => {
  for (const [ns, trecho] of [
    ['projetos', 'O esforço de casa'],
    ['vend-server', 'O esforço do vend'],
  ]) {
    const alvo = `${find((await boardOf(ns)).tree, 'comum').path}/map.md`
    const res = await fetch(`${base}/api/file?path=${encodeURIComponent(alvo)}`)
    assert.equal(res.status, 200, `o /api/file não leu o map.md da origem ${ns}`)
    assert.match(await res.text(), new RegExp(trecho))
  }

  const fora = await fetch(`${base}/api/file?path=/etc/passwd`)
  assert.equal(fora.status, 400)
  assert.match((await fora.json()).error, /fora dos diretórios permitidos/)

  // E o diretório comum **não** é um root: ele contém as origens, mas não é uma delas.
  const comum = await fetch(`${base}/api/file?path=${encodeURIComponent(join(mounts, 'qualquer.md'))}`)
  assert.equal(comum.status, 400)
})

test('FOLDERS: a subpasta de um repo montado é uma origem com raiz nela, isolada do `.scratch/` dele', async () => {
  const tarefas = await boardOf('vend-tarefas')
  const vend = await boardOf('vend-server')

  assert.equal(tarefas.ref, 'vend-server/docs/tarefas')
  assert.equal(find(tarefas.tree, 'presenca').ref, 'vend-server/docs/tarefas/presenca')
  assert.equal(find(tarefas.tree, '02-operador.md').status, 'aberta')
  assert.equal(find(tarefas.tree, 'comum'), null, 'o `.scratch/` do repo vazou para a subpasta')
  assert.equal(find(vend.tree, 'presenca'), null, 'a subpasta vazou para o `.scratch/` do repo')

  const res = await fetch(`${base}/api/file?path=${encodeURIComponent(find(tarefas.tree, 'spec.md').path)}`)
  assert.equal(res.status, 200)
  assert.match(await res.text(), /A spec/)
})

test('FOLDERS: `Bloqueada por:` desenha o grafo de dependências da origem de subpasta', async () => {
  const folder = find((await boardOf('vend-tarefas')).tree, 'presenca').path
  const g = await (await fetch(`${base}/api/graph?ns=vend-tarefas&path=${encodeURIComponent(folder)}`)).json()

  assert.equal(g.mode, 'deps')
  assert.equal(g.edges.length, 1)
  assert.equal(g.nodes.find((n) => n.id === g.edges[0].from).name, '01-registro.md')
  assert.equal(g.nodes.find((n) => n.id === g.edges[0].to).name, '02-operador.md')
})

test('FOLDERS mal declarado não sobe calado', async () => {
  const { discover } = await import('../src/paths.js')
  // Cada um destes, calado, seria uma mentira: aba sumida, aba sobrescrita, aba vazia para sempre.
  await assert.rejects(discover(mounts, 'sem-igual'), /FOLDERS/)
  await assert.rejects(discover(mounts, 'x=vend-server'), /FOLDERS/)
  await assert.rejects(discover(mounts, 'vend-server=projetos/docs'), /já existe/)
  await assert.rejects(discover(mounts, 'x=nao-montado/docs/tarefas'), /não está montado/)
})

test('FOLDERS na origem de casa: o ref é nu, como o `.scratch/` dela', async () => {
  const { discover } = await import('../src/paths.js')
  const origins = await discover(mounts, 'agentes=projetos/docs/agents')
  assert.equal(origins.find((o) => o.name === 'agentes').ref, 'docs/agents')
})
