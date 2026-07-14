/**
 * O servidor de verdade, contra um `.scratch/` de verdade.
 *
 * Esta é a costura mais alta do projeto e a que cobre mais: sobe o servidor numa **porta
 * efêmera** apontando para um diretório temporário, abre o stream SSE com o `fetch` nativo
 * e **escreve arquivos no disco** — arquivos mesmo, não mocks de `fs`. O que se afirma é o
 * que chega pelo fio.
 *
 * É aqui que a promessa central do push vira teste. Não basta o servidor conseguir emitir:
 * ele tem que emitir **quando** e **só quando** o board mudou.
 *
 *   - escrita empurra;
 *   - escrita sem mudança semântica **não** empurra (a supressão por hash);
 *   - rajada de seis arquivos vira **um** evento (o debounce);
 *   - diretório novo aparece sem reiniciar nada;
 *   - fechar um ticket que bloqueia outro **desbloqueia** o outro no board empurrado.
 *
 * E o `/shared/doc.js`: um teste de unidade nunca o pegaria — a rede do parser roda no
 * filesystem, não pela HTTP. Se aquela rota morrer, o `md.js` do browser falha no import,
 * e um import de módulo falha **em silêncio**: o board simplesmente não monta. A rota só é
 * defensável por HTTP, e é por isso que ela é testada aqui.
 *
 * Os roots do board saem do ambiente (`SCRATCHES_DIR`, `PADS_DIR`) e o `paths.js` os resolve
 * no import — daí o `import()` dinâmico depois de plantar o ambiente.
 *
 * Aqui há **uma** origem, `projetos`, e é de propósito: o que se afirma neste arquivo é o
 * push, e ele não deve depender de quantas origens existem. As garantias que só aparecem com
 * mais de uma — isolamento, slugs colidentes, supressão que não atravessa — moram no
 * `namespaces.test.js`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rename, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mounts // o diretório comum: cada filho dele é uma origem
let root // o `.scratch/` da origem `projetos`
let pads
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
 * O stream SSE, lido com o `fetch` nativo — sem `EventSource` (que é do browser) e sem
 * biblioteca. Um frame é o texto até a linha em branco; as linhas `data: ` carregam o
 * payload e a linha `event: ` (quando existe) o nome — sem ela, o SSE chama `message`.
 *
 * **O nome importa e é asserção**: `message` carrega o board inteiro; `files` carrega só os
 * caminhos que mexeram no disco, e é o que avisa a gaveta de uma edição que o board não vê.
 * Cada evento chega aqui como `{ event, ...payload }`.
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
    /** O próximo evento, ou explode no timeout. */
    async next(ms = 4000) {
      const deadline = Date.now() + ms
      while (!queue.length) {
        if (Date.now() > deadline) throw new Error('o servidor não empurrou nada')
        await Promise.race([new Promise((ok) => (wake = ok)), nap(50)])
      }
      return queue.shift()
    },
    /** Afirma que **nada** chega em `ms`. É a supressão virando asserção. */
    async silence(ms = 700) {
      await nap(ms)
      assert.deepEqual(queue, [], 'o servidor empurrou um evento que não devia existir')
    },
    /** Quantos eventos chegaram em `ms`. É o debounce virando asserção. */
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
/** O `/api/board` serve **todas** as origens; aqui só existe uma, e é dela que se fala. */
const board = async () => (await (await get('/api/board')).json()).boards.projetos
const effortOf = (b, slug) => b.efforts.find((e) => e.slug === slug)

/**
 * A posição de um esforço na lista que o servidor publica.
 *
 * **Cuidado com o que isso significa na tela.** No kanban, sim: `effort.js` desenha a coluna
 * filtrando `effort.issues`, e `filter` preserva a ordem — a ordem do array *é* a ordem da
 * coluna. **Na visão geral, não**: o `overview.js` **particiona** os esforços em seções de
 * ordem fixa (Ativos, Prontos para arquivar, Parados), então esta ordem vale **dentro de
 * cada seção**, não na tela inteira. É uma limitação assumida — ver "A ordem por atividade"
 * no `AGENTS.md`.
 */
const posOf = (b, slug) => b.efforts.findIndex((e) => e.slug === slug)

/** Envelhece um arquivo. `utimes` fabrica o tempo no disco — não há relógio a mockar. */
const age = (rel, days) => {
  const when = new Date(Date.now() - days * 864e5)
  return utimes(join(root, rel), when, when)
}

before(async () => {
  mounts = await mkdtemp(join(tmpdir(), 'board-mounts-'))
  root = join(mounts, 'projetos')
  await mkdir(root, { recursive: true })
  pads = await mkdtemp(join(tmpdir(), 'board-pads-'))
  process.env.SCRATCHES_DIR = mounts
  process.env.PADS_DIR = pads

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
  await rm(pads, { recursive: true, force: true })
})

test('a origem de casa produz refs nus — é ela que o agente já tem debaixo dos pés', async () => {
  // O `ref` é o que se cola num prompt, e os comandos partem de `/root/projetos`. Um
  // `projetos/.scratch/...` seria um caminho que não existe a partir de lá.
  const alpha = effortOf(await board(), 'alpha')
  assert.equal(alpha.ref, '.scratch/alpha')
  // Procura-se a issue **pelo arquivo**, não pela posição: o que se afirma aqui é o
  // vocabulário do `ref`, e ele não pode depender da ordem — que é por atividade, e muda.
  const um = alpha.issues.find((i) => i.file === '01-um.md')
  assert.equal(um.ref, '.scratch/alpha/issues/01-um.md')
  // E o caminho do container nunca vaza para o vocabulário do humano.
  assert.equal(alpha.ref.includes(mounts), false)
})

test('/api/board projeta o disco', async () => {
  const b = await board()
  const alpha = effortOf(b, 'alpha')
  assert.equal(alpha.title, 'Mapa do alpha')
  assert.equal(alpha.total, 2)
  assert.equal(alpha.closed, 1)
})

test('effort.mtime não está no payload — o carimbo que mataria a supressão saiu', async () => {
  const b = await board()
  const alpha = effortOf(b, 'alpha')
  assert.equal('mtime' in alpha, false)
  // E não é só o esforço: nada do board carrega carimbo de filesystem.
  assert.equal(JSON.stringify(b).includes('mtime'), false)

  // **E o carimbo não volta com outro nome.** O `board.js` lê o `mtime` para *ordenar* e o
  // chama de `at` — um `grep` por "mtime" não o veria. A proibição é do **carimbo**, não da
  // palavra: publicá-lo como `at` mataria a supressão exatamente do mesmo jeito.
  assert.equal('at' in alpha, false, 'o carimbo que ordena não pode viajar no esforço')
  for (const i of alpha.issues) {
    assert.equal('at' in i, false, 'o carimbo que ordena não pode viajar na issue')
  }
})

test('escrever um .md empurra um board novo, e ele reflete a mudança', async () => {
  const stream = await openStream()
  try {
    await put('alpha/issues/02-dois.md', issue('02 — Dois', 'resolved'))

    const { event, board: pushed, changed } = await stream.next()
    assert.equal(event, 'message', 'o board mudou: o evento tem que ser o que carrega o board')
    const alpha = effortOf(pushed, 'alpha')
    assert.equal(alpha.closed, 2)
    assert.equal(alpha.archivable, true)
    assert.ok(
      changed.some((p) => p.endsWith('02-dois.md')),
      'o evento carrega os caminhos que mexeram — é o que a gaveta viva vai consultar',
    )
  } finally {
    stream.close()
  }
})

test('reescrever um arquivo com o mesmo conteúdo NÃO empurra nada', async () => {
  const same = issue('02 — Dois', 'resolved')
  const stream = await openStream()
  try {
    await put('alpha/issues/02-dois.md', same)
    await stream.silence()
  } finally {
    stream.close()
  }
})

test('tocar um arquivo (mtime novo, conteúdo igual) NÃO empurra nada', async () => {
  const stream = await openStream()
  try {
    const now = new Date()
    await utimes(join(root, 'alpha/issues/02-dois.md'), now, now)
    await stream.silence()
  } finally {
    stream.close()
  }
})

test('um arquivo que o board não projeta (.swp) NÃO empurra nada', async () => {
  const stream = await openStream()
  try {
    // Ele mexe no `mtime` do diretório do esforço — que é exatamente o campo que saiu do
    // payload. Se ele voltasse, este teste falharia, e a supressão seria decoração.
    //
    // E nem sequer um `files`: o disco de fato mexeu, mas um caminho **oculto** não pode
    // estar aberto em gaveta nenhuma (o board nunca projeta entrada oculta). Aqui o evento
    // dos caminhos desfaria, pela porta dos fundos, a supressão que o push existe para ter.
    await put('alpha/issues/.02-dois.md.swp', 'lixo de editor')
    await rm(join(root, 'alpha/issues/.02-dois.md.swp'))
    await stream.silence()
  } finally {
    stream.close()
  }
})

test('escrever só o CORPO de um .md emite um evento `files` — os caminhos, e nenhum board', async () => {
  // O caso de uso que dá nome à gaveta viva: o agente está escrevendo o ticket que você
  // está lendo. O cabeçalho não muda, então o **board** não muda — e antes deste evento o
  // servidor calava, com toda a razão do hash e nenhuma razão de quem estava lendo.
  const header = 'Status: resolved\nType: task\n\n# 02 — Dois\n\n'
  const alvo = join(root, 'alpha/issues/02-dois.md')

  const stream = await openStream()
  try {
    await put('alpha/issues/02-dois.md', `${header}## Answer\n\nDuzentas linhas de resposta.\n`)

    const ev = await stream.next()
    assert.equal(ev.event, 'files', 'a edição de corpo tem que emitir o evento dos caminhos')
    assert.ok(ev.changed.includes(alvo), 'o evento tem que dizer QUAL arquivo mudou')
    // Só os caminhos: o board não viaja aqui. São centenas de bytes, não os 62 KB da
    // projeção — e mandá-la seria mentir que a tela precisa se redesenhar.
    assert.equal('board' in ev, false, 'o evento `files` não pode carregar o board')

    // E é **um** evento: o board não mudou, então nenhum `message` o segue.
    assert.equal(await stream.count(400), 0)

    // O board continua exatamente o mesmo — a supressão por hash não foi ferida, ela só
    // deixou de ser o único sinal do mundo.
    assert.equal(effortOf(await board(), 'alpha').closed, 2)
  } finally {
    stream.close()
  }
})

test('a SEGUNDA escrita atômica do mesmo arquivo também chega — o watcher perde o nome, o digest não', async () => {
  // O caso que derruba a prescrição ingênua, e é justamente **como os agentes escrevem**:
  // grava um `arquivo.md.tmp.NNNN` e faz `rename` por cima do alvo. O `fs.watch` recursivo
  // do Node para de reportar o nome depois que o `rename` troca o inode por baixo dele —
  // medido: a primeira edição aparece na lista de caminhos do kernel, a segunda vem só com
  // o `.tmp`, e o `.md` de verdade some do relato.
  //
  // Se o `changed` saísse do watcher, a gaveta viva funcionaria **uma vez por arquivo** e
  // depois calaria em silêncio — pior que não existir, porque pareceria funcionar. Ele sai
  // do digest do conteúdo, e o watcher serve só de **gatilho**: cada `.tmp` é um nome novo,
  // e nome novo o kernel sempre reporta.
  //
  // O arquivo é só deste teste de propósito: o mesmo `rename` que cega o watcher para o
  // nome cega-o para **as escritas diretas** seguintes (`writeFile` sem tmp), e os outros
  // testes escrevem assim. É o mesmo fato do parágrafo acima, visto do outro lado.
  const alvo = join(root, 'alpha/issues/03-atomica.md')
  const header = 'Status: resolved\nType: task\n\n# 03 — Atômica\n\n'

  const atomica = async (corpo) => {
    const tmp = `${alvo}.tmp.${Math.random().toString(16).slice(2)}`
    await writeFile(tmp, header + corpo)
    await rename(tmp, alvo)
  }

  const stream = await openStream()
  try {
    // A primeira escrita cria a issue: o board muda, e quem vai é o board.
    await atomica('O corpo original.\n')
    assert.equal((await stream.next()).event, 'message')

    // Da segunda em diante é só corpo — e é aqui que o watcher já perdeu o nome do arquivo.
    for (const corpo of ['## Answer\n\nPrimeira versão.\n', '## Answer\n\nSegunda, por cima.\n']) {
      await atomica(corpo)

      const ev = await stream.next()
      assert.equal(ev.event, 'files')
      assert.ok(
        ev.changed.includes(alvo),
        `a edição atômica sumiu do \`changed\`: ${JSON.stringify(ev.changed)}`,
      )
      // O `.tmp` nasceu e morreu: ele não é documento de ninguém e não viaja.
      assert.equal(ev.changed.length, 1, 'só o arquivo de verdade viaja — nem o .tmp, nem mais nada')
    }
  } finally {
    stream.close()
  }
})

test('reescrever o CORPO com bytes idênticos não emite nem `files` — a supressão do arquivo', async () => {
  // O `fs.watch` fala de **escrita**, não de conteúdo: reescrever o mesmo texto É uma
  // escrita e ele a vê. Se o evento `files` confiasse nele, um agente que salva um `.md` sem
  // mudar nada acordaria toda gaveta aberta — e a propriedade central do push (mudança sem
  // efeito não emite byte nenhum) morreria pela porta dos fundos.
  //
  // O caminho só viaja se o **conteúdo** mudou. É o hash do board, um andar abaixo.
  const mesmo = 'Status: resolved\nType: task\n\n# 02 — Dois\n\n## Answer\n\nA resposta, e ela não muda mais.\n'
  const stream = await openStream()
  try {
    // A primeira escrita é **preparo**, e o que ela empurra não interessa aqui: pode ser um
    // `files` (só o corpo mudou) ou um `message` (se ela também reordenou a coluna — ordem é
    // board, ver "a ordem por atividade" no fim deste arquivo). O teste não afirma sobre ela,
    // de propósito: amarrá-la a um evento específico prenderia este teste ao estado que os
    // testes anteriores deixaram no disco, e ele quebraria ao se reordenar um vizinho.
    await put('alpha/issues/02-dois.md', mesmo)
    await stream.next()
    stream.drain()

    // **É esta a asserção.** Os mesmos bytes, de novo: o conteúdo não mudou, e o `02` agora
    // já é o primeiro — nem o digest se move, nem o ranking. Zero byte no fio.
    await put('alpha/issues/02-dois.md', mesmo)
    await stream.silence()
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

    const { board: pushed } = await stream.next()
    assert.equal(effortOf(pushed, 'rajada').total, 6)
  } finally {
    stream.close()
  }
})

test('um esforço novo — diretório que não existia quando o servidor subiu — aparece sem reiniciar nada', async () => {
  const stream = await openStream()
  try {
    await put('nasceu-agora/PRD.md', '# Esforço recém-nascido\n\nExiste agora.\n')

    const { board: pushed } = await stream.next()
    const novo = effortOf(pushed, 'nasceu-agora')
    assert.ok(novo, 'o watch recursivo não pegou o diretório novo')
    assert.equal(novo.title, 'Esforço recém-nascido')
  } finally {
    stream.close()
  }
})

test('fechar um ticket que bloqueia outro desbloqueia o outro no board empurrado', async () => {
  await put('bloqueio/issues/01-base.md', issue('01 — Base', 'ready-for-agent'))
  await put(
    'bloqueio/issues/02-preso.md',
    issue('02 — Preso', 'ready-for-agent', 'Blocked by: 01 — a base tem que existir antes'),
  )

  const antes = effortOf(await board(), 'bloqueio')
  const preso = antes.issues.find((i) => i.number === '02')
  assert.equal(preso.blocked, true)
  // O contrato do payload: `{ number, note, raw }`, e nada mais — campo que vaze move o hash.
  assert.deepEqual(Object.keys(preso.blockedBy[0]).sort(), ['note', 'number', 'raw'])
  assert.equal(preso.blockedBy[0].number, '01')
  // A nota é tudo que vem depois do número, como o autor escreveu — travessão incluído.
  assert.equal(preso.blockedBy[0].note, '— a base tem que existir antes')

  const stream = await openStream()
  try {
    await put('bloqueio/issues/01-base.md', issue('01 — Base', 'resolved'))

    const { board: pushed } = await stream.next()
    const depois = effortOf(pushed, 'bloqueio')
    assert.equal(depois.issues.find((i) => i.number === '02').blocked, false)
    assert.equal(depois.issues.find((i) => i.number === '01').closed, true)
  } finally {
    stream.close()
  }
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

test('/api/file lê um arquivo de dentro do root', async () => {
  const res = await get(`/api/file?path=${encodeURIComponent(join(root, 'alpha/map.md'))}`)
  assert.equal(res.status, 200)
  assert.match((await res.json()).content, /Mapa do alpha/)
})

test('o board é servível: /, /app.js e o /shared/doc.js que o browser importa', async () => {
  // O `md.js` do browser faz `import ... from '../shared/doc.js'` — que na URL vira
  // `/shared/doc.js`. Se essa rota morrer num corte, o import falha **em silêncio** e o
  // board não monta. Nenhum teste de unidade percebe: a rede do parser roda no filesystem.
  for (const [path, type] of [
    ['/', /text\/html/],
    ['/app.js', /javascript/],
    ['/md.js', /javascript/],
    ['/router.js', /javascript/],
    ['/shared/doc.js', /javascript/],
  ]) {
    const res = await get(path)
    assert.equal(res.status, 200, `${path} não respondeu 200`)
    assert.match(res.headers.get('content-type'), type, `${path} veio com o tipo errado`)
  }

  const doc = await (await get('/shared/doc.js')).text()
  assert.match(doc, /export function parseDoc/, 'o /shared/doc.js não é o parser')

  // E o estático não escapa do seu root.
  assert.equal((await get('/shared/../src/server.js')).status, 404)
})

// ---------- a ordem por atividade ----------
//
// O board saía em ordem **alfabética**, que não carrega informação nenhuma: abrir a visão
// geral não dizia onde o trabalho estava acontecendo. Agora o esforço onde o agente está
// escrevendo é o primeiro card, e dentro dele o ticket quente é o primeiro da coluna.
//
// **Para ordenar, publica-se a ordem — não o carimbo.** O `mtime` cru mudaria a cada
// salvamento, moveria o hash do board e faria o evento virar `message` (~71 KB + re-render)
// em vez do `files` (~126 bytes) — colapsando as duas supressões. O teste que proíbe a
// string `mtime` no board serializado é o guarda disso, e ele continua verde acima.

test('os esforços saem ordenados por atividade: o trabalho quente é o primeiro card', async () => {
  await put('gelado/PRD.md', '# Gelado\n\nNinguém toca nele há uma semana.\n')
  await put('quente/PRD.md', '# Quente\n\nAcabaram de mexer.\n')
  await age('gelado/PRD.md', 7)

  const b = await board()

  // Na ordem alfabética, `gelado` vinha **antes** de `quente` — é essa a ordem que morreu.
  assert.equal(posOf(b, 'quente'), 0, 'o esforço mexido por último tem que abrir a tela')
  assert.equal(
    posOf(b, 'gelado'),
    b.efforts.length - 1,
    'o esforço parado há uma semana tem que ser o último',
  )
})

test('as issues saem ordenadas por atividade dentro da coluna do kanban', async () => {
  // Os três na **mesma** coluna, de propósito: é dentro de uma coluna que o olho procura o
  // ticket quente, e o kanban (`public/effort.js`) a desenha filtrando esta lista. Como
  // `filter` preserva a ordem, ordenar o array uma vez ordena **dentro de cada coluna**.
  for (const [file, titulo] of [
    ['01-velho.md', '01 — Velho'],
    ['02-medio.md', '02 — Médio'],
    ['03-novo.md', '03 — Novo'],
  ]) {
    await put(`kanban/issues/${file}`, issue(titulo, 'ready-for-agent'))
  }
  await age('kanban/issues/01-velho.md', 9)
  await age('kanban/issues/02-medio.md', 3)

  const k = effortOf(await board(), 'kanban')

  assert.equal(
    new Set(k.issues.map((i) => i.column)).size,
    1,
    'os três têm que estar na mesma coluna, senão o teste não fala de coluna nenhuma',
  )
  // A ordem **numérica** — a de antes — sairia `01, 02, 03`. A de atividade a inverte, e é
  // essa inversão que prova que a ordenação é por tempo e não pelo nome do arquivo.
  assert.deepEqual(
    k.issues.map((i) => i.file),
    ['03-novo.md', '02-medio.md', '01-velho.md'],
  )
})

test('tickets nascidos na mesma rajada saem em ordem numérica — rajada não é atividade', async () => {
  // O `/to-tickets` escreve `01…07` de uma vez só. Com o `mtime` **cru**, o `07` é o mais
  // recente e a coluna sai invertida — a frontier (`01`) no fim, que é o pior lugar para ela.
  //
  // E isso **não se conserta sozinho**: um ticket em `ready-for-agent` é, por definição, um
  // que ninguém tocou desde que nasceu — tocá-lo muda o `Status:`, e mudar o status o **tira
  // da coluna**. A inversão seria permanente, justamente na coluna de onde se escolhe trabalho.
  //
  // Daí a regra: **abaixo do dia, o carimbo de um ticket é ruído; o `NN` é informação** — ele
  // é a espinha do `Blocked by:`. O dia manda, e dentro do dia manda o número.
  // A rajada de verdade leva **~20s** entre um ticket e o outro — medido na frota: os gaps de
  // criação vão de 4s a 25s, enquanto o menor gap entre dois trabalhos reais é de 389s. É esse
  // vale que separa as duas coisas.
  //
  // Escrever os cinco num loop cairia no mesmo milissegundo, empataria, e o teste passaria sem
  // provar nada — daí o `utimes` escalonando de verdade.
  const rajada = Date.now() - 3_600_000 // uma hora atrás, e ainda hoje
  for (const n of [1, 2, 3, 4, 5]) {
    const file = `rajada-nn/issues/0${n}-t.md`
    await put(file, issue(`0${n} — T`, 'ready-for-agent'))
    const nasceu = new Date(rajada + n * 20_000) // 20s entre cada: o 05 é o mais novo
    await utimes(join(root, file), nasceu, nasceu)
  }

  const e = effortOf(await board(), 'rajada-nn')
  assert.deepEqual(
    e.issues.map((i) => i.file),
    ['01-t.md', '02-t.md', '03-t.md', '04-t.md', '05-t.md'],
    'a rajada de criação não carrega informação: dentro dela, quem manda é o número',
  )
})

test('mas trabalhar num ticket o traz ao topo NO MESMO DIA — tempo continua sendo o critério', async () => {
  // O contraponto do teste acima, e é ele que impede a "correção" preguiçosa: quantizar o
  // carimbo por **dia** também colapsaria a rajada — e mataria isto, que é o ponto do board.
  //
  // A rajada do teste acima nasceu **uma hora atrás — hoje**. Agora o agente toca o `02`. Ele
  // **tem** que abrir a coluna: é a resposta à pergunta que originou o esforço inteiro —
  // *"qual issue está sendo trabalhada agora?"*.
  //
  // Uma hora de distância, mas o **mesmo dia**: é exatamente isto que uma quantização por dia
  // apagaria. O critério é tempo; a rajada é a exceção, não a regra.
  //
  // E o ticket é reescrito com **o mesmo conteúdo** de propósito: nada nele muda, nem status
  // nem coluna. A única coisa que se move é o carimbo — e é só ele que o traz ao topo.
  await put('rajada-nn/issues/02-t.md', issue('02 — T', 'ready-for-agent'))

  const e = effortOf(await board(), 'rajada-nn')
  assert.equal(
    e.issues[0].file,
    '02-t.md',
    'o ticket tocado tem que subir ao topo mesmo estando no mesmo dia da rajada',
  )
  // E os outros, que continuam intocados, seguem na ordem numérica da rajada.
  assert.deepEqual(
    e.issues.slice(1).map((i) => i.file),
    ['01-t.md', '03-t.md', '04-t.md', '05-t.md'],
  )
})

/**
 * O corpo de uma issue **não é projetado** — o board lê dela o `Status:`, o `Type:`, o título
 * e o `Blocked by:`, e nada mais. Então reescrever só o corpo deixa a projeção byte-a-byte
 * idêntica, e a **única** coisa que pode mover o hash do board é o `mtime` mudando a **ordem**.
 *
 * É o que isola a propriedade nos dois testes abaixo: o que empurra ali é o ranking, e nada
 * além dele.
 */
const body = (n) => `Status: ready-for-agent\nType: task\n\n# 01 — A\n\nParágrafo ${n}.\n`

test('escrever o ticket que NÃO era o primeiro reordena a coluna e empurra o board', async () => {
  await put('fila/issues/01-a.md', issue('01 — A', 'ready-for-agent'))
  await put('fila/issues/02-b.md', issue('02 — B', 'ready-for-agent'))
  await age('fila/issues/01-a.md', 5)

  const antes = effortOf(await board(), 'fila')
  assert.deepEqual(antes.issues.map((i) => i.file), ['02-b.md', '01-a.md'], 'o 02 é o quente')

  const stream = await openStream()
  try {
    // O agente mexe no `01` — o que estava em **segundo**. Só o corpo: nenhum campo que o
    // board projeta muda. O que muda é o ranking.
    await put('fila/issues/01-a.md', body(1))

    const ev = await stream.next()
    assert.equal(ev.event, 'message', 'a tela reordenou de verdade: isso é um push legítimo')
    assert.deepEqual(
      effortOf(ev.board, 'fila').issues.map((i) => i.file),
      ['01-a.md', '02-b.md'],
      'o ticket em que o agente está escrevendo tem que subir ao topo da coluna',
    )
  } finally {
    stream.close()
  }
})

test('e os salvamentos seguintes — com ele já em primeiro — não movem o board', async () => {
  // "O agente salva o ticket X: ele sobe ao topo (um push), e os dez salvamentos seguintes
  // **não movem nada**, porque ele já está em primeiro." É esta a frase virando teste, e é
  // ela que faz a ordenação ser barata: o hash só se mexe quando o **ranking** se mexe.
  //
  // Os ~126 bytes do `files` continuam indo — eles são o que mantém a gaveta viva enquanto o
  // agente escreve. O que **não** vai é o board inteiro (~71 KB) e o re-render que ele arrasta.
  const stream = await openStream()
  try {
    for (const n of [2, 3, 4]) {
      await put('fila/issues/01-a.md', body(n))

      const ev = await stream.next()
      assert.equal(ev.event, 'files', `o salvamento ${n} repintou o board sem o ranking ter mudado`)
      assert.equal('board' in ev, false, 'o board não pode viajar quando ninguém reordenou')
    }
  } finally {
    stream.close()
  }
})
