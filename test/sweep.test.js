/**
 * A varredura de segurança — o que o board faz quando o **watcher** falha.
 *
 * Este é o teste que só existe porque o push pode mentir. Um `fs.watch` morto não avisa
 * ninguém: o board simplesmente para de receber, e "parou de receber" é byte-a-byte igual
 * a "nada mudou". A varredura é a apólice — de 90 em 90 segundos o servidor relê o disco
 * por conta própria, e o hash decide se alguém precisa saber.
 *
 * O watcher aqui é **morto de verdade** (`stopWatch()`), não desligado por um flag: é
 * exatamente a falha que a varredura cobre. Depois disso, o único caminho que sobra até a
 * tela é a varredura — se ela não empurrar, ninguém empurra.
 *
 * E a outra metade, que é a que a torna barata: num board **parado**, a varredura roda,
 * roda de novo, e **não emite byte nenhum**. Reconstruir não é empurrar; quem decide é o
 * hash. Sem isso ela seria o polling de volta, só que mais lento.
 *
 * Arquivo separado do `server.test.js` porque a varredura precisa de um relógio curto
 * (`sweep: 300`), e um servidor que empurra sozinho a cada 300ms envenenaria as asserções de
 * silêncio do outro arquivo.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SWEEP = 300 // a varredura de 90s, encurtada para caber num teste

let mounts
let root
let server
let base

async function put(rel, body) {
  const path = join(root, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
  return path
}

const issue = (title, status) => `Status: ${status}\nType: task\n\n# ${title}\n\nCorpo.\n`

/** O stream SSE lido com o `fetch` nativo — o `EventSource` é do browser. */
async function openStream() {
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
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n')
          if (data) queue.push(JSON.parse(data))
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
    async silence(ms) {
      await nap(ms)
      assert.deepEqual(queue, [], 'o servidor empurrou um evento que não devia existir')
    },
    close: () => ac.abort(),
  }
  await stream.next() // o snapshot de conexão
  return stream
}

const boardOf = async () => (await (await fetch(`${base}/api/board?ns=projetos`)).json())

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
  mounts = await mkdtemp(join(tmpdir(), 'board-sweep-'))
  root = join(mounts, 'projetos', '.scratch')
  await mkdir(root, { recursive: true })
  process.env.REPOS_DIR = mounts

  await put('alpha/map.md', '# Mapa do alpha\n\nO primeiro parágrafo.\n')
  await put('alpha/issues/01-um.md', issue('01 — Um', 'ready-for-agent'))

  // Um arquivo **parado há seis dias**: o `mtime` dele está no nó, mas é **absoluto e imóvel**
  // — nenhuma volta da varredura o move. É o que prova que não há tempo relativo no payload: um
  // `"há 6 dias"` calculado no servidor mudaria com o relógio e empurraria o board parado.
  await put('encalhado/PRD.md', '# Encalhado\n\nNinguém toca há uma semana.\n')
  const seisDias = new Date(Date.now() - 6 * 864e5)
  await utimes(join(root, 'encalhado/PRD.md'), seisDias, seisDias)

  const mod = await import('../src/server.js')
  server = await mod.start(0, { sweep: SWEEP })
  base = `http://127.0.0.1:${server.port}`
})

after(async () => {
  await server?.close()
  await rm(mounts, { recursive: true, force: true })
})

test('num board parado, a varredura roda e NÃO emite nada — nem com um arquivo encalhado', async () => {
  // Várias voltas inteiras da varredura. Ela reconstrói a árvore a cada uma — e o hash não se
  // move (os `mtime` são imóveis), então o fio fica mudo. É isto que a faz custar quase nada.
  const stream = await openStream()
  try {
    await stream.silence(SWEEP * 4)
  } finally {
    stream.close()
  }
})

test('com o watcher MORTO, a varredura pega a mudança que ele perdeu', async () => {
  const stream = await openStream()
  try {
    // O watcher morre. A partir daqui, o disco pode mudar à vontade que ninguém avisa —
    // e o board mostraria dados velhos com cara de vivos, para sempre. É a doença.
    server.stopWatch()

    const alvo = await put('alpha/issues/02-dois.md', issue('02 — Dois', 'resolved'))

    // Nenhum evento de watch vai chegar. Quem tem que empurrar é a varredura, sozinha.
    const ev = await stream.next()
    assert.ok(find(ev.board.tree, '02-dois.md'), 'a varredura empurrou uma árvore velha')

    // E ela **sabe quais caminhos mexeram**, mesmo tendo perdido o evento que os carregava: o
    // `changed` vem do digest do conteúdo (`cache.js`), não do kernel. Com o watcher morto, o
    // visualizador aberto se cura junto com o board.
    assert.deepEqual(ev.changed, [alvo])
  } finally {
    stream.close()
  }
})

test('depois de repescar, ela volta a calar: a mesma varredura não empurra duas vezes', async () => {
  const stream = await openStream()
  try {
    // O watcher continua morto (do teste anterior) e o disco está parado. A varredura
    // segue rodando — e o hash, que ela acabou de atualizar, não se move mais.
    await stream.silence(SWEEP * 3)
  } finally {
    stream.close()
  }
})

test('o /api/board relê o disco de verdade — o botão de reler não é uma mentira', async () => {
  // O watcher está morto e a varredura acabou de calar: se o `/api/board` servisse cache,
  // um arquivo novo escrito agora seria invisível para ele. É o que o botão do cabeçalho
  // chama, e é o que faz dele uma válvula de escape em vez de um placebo.
  const stream = await openStream()
  try {
    server.stopWatch()
    await put('beta/PRD.md', '# Esforço beta\n\nNasceu agora.\n')

    const b = await boardOf()
    assert.ok(find(b.tree, 'beta'), 'o /api/board serviu cache: o esforço novo não apareceu')

    // E mais: a releitura que descobriu a novidade avisa **as outras abas**.
    const ev = await stream.next()
    assert.ok(find(ev.board.tree, 'beta'), 'a releitura por HTTP não avisou o stream')
  } finally {
    stream.close()
  }
})
