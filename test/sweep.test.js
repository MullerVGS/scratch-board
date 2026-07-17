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
 * silêncio do outro arquivo. (Já foi separado por outro motivo — o `cache.js` guardava o hash
 * num módulo, e dois servidores no mesmo processo o dividiriam. Isso acabou: o cache agora é
 * uma fábrica por origem, e o estado nasce dentro do `start()`.)
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SWEEP = 300 // a varredura de 90s, encurtada para caber num teste

let mounts
let root
let pads
let hist // o catálogo: temporário, para o teste não escrever no volume de produção
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

const effortOf = (b, slug) => b.efforts.find((e) => e.slug === slug)

before(async () => {
  mounts = await mkdtemp(join(tmpdir(), 'board-sweep-'))
  root = join(mounts, 'projetos', '.scratch')
  await mkdir(root, { recursive: true })
  pads = await mkdtemp(join(tmpdir(), 'board-sweep-pads-'))
  hist = await mkdtemp(join(tmpdir(), 'board-sweep-hist-'))
  process.env.REPOS_DIR = mounts
  process.env.PADS_DIR = pads
  // O catálogo também sai do ambiente, e também é resolvido no import. Sem isto o
  // servidor do teste escreveria no `HISTORY` de produção (`/workspace/history`).
  process.env.HISTORY_DIR = hist

  await put('alpha/map.md', '# Mapa do alpha\n\nO primeiro parágrafo.\n')
  await put('alpha/issues/01-um.md', issue('01 — Um', 'ready-for-agent'))

  // Um ticket **encalhado há seis dias**, que é o board que este arquivo precisa ter para
  // dizer algo sobre o eixo de tempo: é o único cujo card carrega um carimbo, e é ele que a
  // varredura poderia repintar sozinha se o carimbo envelhecesse com o relógio.
  await put('encalhado/issues/01-frio.md', issue('01 — Frio', 'ready-for-agent'))
  const seisDias = new Date(Date.now() - 6 * 864e5)
  await utimes(join(root, 'encalhado/issues/01-frio.md'), seisDias, seisDias)

  const mod = await import('../src/server.js')
  server = await mod.start(0, { sweep: SWEEP })
  base = `http://127.0.0.1:${server.port}`
})

after(async () => {
  await server?.close()
  await rm(mounts, { recursive: true, force: true })
  await rm(pads, { recursive: true, force: true })
  await rm(hist, { recursive: true, force: true })
})

test('num board parado, a varredura roda e NÃO emite nada', async () => {
  const stream = await openStream()
  try {
    // Várias voltas inteiras da varredura. Ela reconstrói o board a cada uma — e o hash
    // não se move, então o fio fica mudo. É isto que a faz custar quase nada: 40 leituras
    // por hora, zero re-render. Se ela empurrasse "por via das dúvidas", seria o polling.
    await stream.silence(SWEEP * 4)
  } finally {
    stream.close()
  }
})

test('e o board com um ticket ENCALHADO continua mudo — o carimbo não envelhece sozinho', async () => {
  // O modo de falha que o eixo de tempo poderia introduzir, e a razão de ele existir aqui: um
  // `"em pronto há 6 dias"` **calculado no servidor** seria uma string que muda com o relógio.
  // Ela sobreviveria a esta varredura, mas não à seguinte — e o board empurraria 71 KB e um
  // re-render **sozinho, parado**, sem ninguém ter escrito um byte. Seria o polling ressuscitado,
  // e pior: barulhento. O que viaja é o **instante** em que o ticket entrou na coluna, imóvel:
  // um carimbo de transição (aqui, o primeiro `seen`, que a subida semeou) não envelhece.
  const stream = await openStream()
  try {
    const { boards } = await (await fetch(`${base}/api/board`)).json()
    const frio = effortOf(boards.projetos, 'encalhado').issues[0]
    assert.match(frio.held.at, /^\d{4}-\d{2}-\d{2}T/, 'o card do encalhado tem que carregar o instante da coluna')
    assert.equal(frio.held.floor, true, 'nunca observado transicionar: o número é um piso')

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
    const { board: pushed, changed } = await stream.next()
    const alpha = effortOf(pushed, 'alpha')
    assert.equal(alpha.total, 2, 'a varredura empurrou um board velho')
    assert.equal(alpha.closed, 1)

    // E ela **sabe quais caminhos mexeram**, mesmo tendo perdido o evento que os carregava.
    // Enquanto o `changed` viesse do watcher, o melhor que a varredura podia dizer aqui era
    // uma lista vazia. Ele vem do **digest do conteúdo** (`cache.js`), que não depende de o
    // kernel ter avisado: a varredura relê o disco e compara. Consequência prática: com o
    // watcher morto, a **gaveta aberta se cura junto com o board**.
    assert.deepEqual(changed, [alvo])
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

test('o /api/board relê o disco de verdade — o botão de refresh não é uma mentira', async () => {
  // O watcher está morto e a varredura acabou de calar: se o `/api/board` servisse cache,
  // um arquivo novo escrito agora seria invisível para ele. É o que o botão do cabeçalho
  // chama, e é o que faz dele uma válvula de escape em vez de um placebo.
  const stream = await openStream()
  try {
    server.stopWatch()
    await put('beta/PRD.md', '# Esforço beta\n\nNasceu agora.\n')

    const { boards } = await (await fetch(`${base}/api/board`)).json()
    assert.ok(effortOf(boards.projetos, 'beta'), 'o /api/board serviu cache: o esforço novo não apareceu')

    // E mais: a releitura que descobriu a novidade avisa **as outras abas**. Quem aperta
    // refresh numa aba não guarda a descoberta para si.
    const { board: pushed } = await stream.next()
    assert.ok(effortOf(pushed, 'beta'), 'a releitura por HTTP não avisou o stream')
  } finally {
    stream.close()
  }
})
