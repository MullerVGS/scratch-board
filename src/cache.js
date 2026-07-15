// O board em memória, e a única pergunta que autoriza um push: **mudou de verdade?**
//
// `buildBoard()` é "leia o disco agora" — sem estado, sem memória, sem cache. É de
// propósito: o `board.js` sabe *como* montar a projeção, o cache decide *quando* montá-la e
// se alguém precisa saber. Cache dentro do `board.js` fecharia as duas coisas num nó só e a
// supressão deixaria de ser demonstrável.
//
// **A supressão é o coração do push.** Um evento de disco não é uma mudança no board: um
// `.swp` que nasce e some, uma reescrita com o conteúdo igual, um `touch`. Todos mexem no
// `.scratch/` e nenhum muda um pixel do que a tela mostra. O board novo é serializado e
// comparado com o que já foi empurrado: **byte-idêntico ⇒ ninguém é avisado.**
//
// Daí `effort.mtime` não poder voltar ao payload: o `mtime` de um *diretório* pula quando
// qualquer entrada nasce, morre ou é renomeada dentro dele — inclusive por arquivo que o
// board nem projeta. Ele moveria o hash sem o board mudar, e a supressão viraria decoração.
// Vale para qualquer campo instável.
//
// **Um cache por origem, e é uma fábrica por isso.** O hash e o digest eram estado de
// módulo, o que valia enquanto o board tinha um root só. Com vários, um `Map` global por
// namespace seria a mesma coisa escrita pior: duas origens dividiriam o módulo e a
// primeira que esquecesse a chave contaminaria a outra. `createCache(ns)` fecha o estado
// dentro da origem — a supressão de uma **não alcança** a outra, e isso deixa de ser uma
// regra a lembrar. (De quebra, dois servidores no mesmo processo deixam de brigar pelo
// mesmo hash: era por isso que o teste da varredura tinha que morar num arquivo separado.)

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { buildBoard, errorBoard } from './board.js'

const hashOf = (json) => createHash('sha1').update(json).digest('hex')

/** Arquivo grande a gaveta nem exibe (o servidor manda o tamanho). Não se lê um PNG para saber que ele mexeu. */
const BIG = 512 * 1024

/**
 * Os arquivos que a gaveta pode ter aberto: tudo sob o root, menos o oculto.
 *
 * O board **nunca projeta entrada oculta** (`listSlugs`), e a gaveta só abre o que o board
 * lhe entregou — então um `.swp` de editor não pode estar aberto em gaveta nenhuma, e o
 * caminho dele não tem por que viajar.
 */
async function walk(dir, out = []) {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch { return out /* sumiu no meio da varredura, ou nunca existiu */ }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const path = join(dir, e.name)
    if (e.isDirectory()) await walk(path, out)
    else if (e.isFile()) out.push(path)
  }
  return out
}

/**
 * A memória de **uma** origem: o hash do último board que saiu dela, e o digest de cada
 * arquivo que ela tem. Nada aqui é compartilhado com outra origem, e é o que garante que
 * uma escrita no `vend-server` não suprima — nem acorde — o board do `projetos`.
 */
export function createCache(ns, history) {
  // O `history` é o catálogo (um só, do servidor), repassado ao `buildBoard()` para ele
  // destilar a barra do Gantt de cada issue. É leitura pura daqui: o cache não o alimenta —
  // quem observa e escreve é o `sync()`, depois que o board é lido. `undefined` degrada para
  // barras hachuradas, sem quebrar nada.

  // O hash do último board que **saiu daqui**. É contra ele que toda leitura nova se
  // compara — e é a razão de a varredura de segurança (90s) custar quase nada: ela
  // reconstrói, não reconhece nada de novo, e cala a boca.
  let hash = null

  // Por arquivo: o carimbo (`size:mtime`) e o digest do conteúdo. **Os dois, e cada um faz
  // uma coisa.** O carimbo é o portão barato — um `stat` diz que o arquivo *não* foi
  // escrito, e aí não se lê nada. O digest é quem decide: escrita não é mudança, e um
  // `touch` ou uma reescrita com os mesmos bytes têm carimbo novo e conteúdo igual. Sem o
  // digest, o board voltaria a emitir por relógio de filesystem; sem o carimbo, ele leria a
  // árvore inteira a cada rajada para descobrir que quase nada mudou.
  const seen = new Map()

  /**
   * Relê o disco, remonta o board desta origem e diz se ele mudou.
   *
   * `changed` é o único sinal que autoriza um push — e é falso sempre que a leitura nova é
   * byte-a-byte a leitura velha. A primeira leitura sempre muda: não havia board antes.
   *
   * Não existe um `current()` que devolva "o que eu acredito": todo caminho até o board
   * passa por uma leitura de disco. Um board de memória servido sem reler é exatamente o
   * silêncio mentiroso que o push corre o risco de virar — e o cache que existe aqui é para
   * **suprimir** o que não mudou, nunca para *responder* no lugar do disco.
   *
   * Uma leitura que estoura vira um board de erro, não uma exceção que sobe: a falha fica
   * **contida nesta origem**, e as outras continuam de pé. Ela também passa pelo hash, então
   * um erro que persiste é empurrado uma vez, não a cada volta da varredura.
   *
   * O **objeto** do board sai junto com o JSON dele. O catálogo (`history.js`) precisa dos
   * status das issues, e eles já foram parseados aqui: reabrir os `.md` lá seria um segundo
   * leitor de disco, capaz de divergir deste. O board é a única leitura, e todo mundo come
   * dela.
   */
  async function refresh() {
    let board
    try {
      board = await buildBoard(ns, history)
    } catch (err) {
      board = errorBoard(ns, err.message)
    }
    const json = JSON.stringify(board)
    const next = hashOf(json)
    const changed = next !== hash
    hash = next
    return { json, hash, changed, board }
  }

  // ---------- a supressão do arquivo ----------
  //
  // O mesmo raciocínio, um andar abaixo. **O board e o arquivo são duas coisas diferentes**:
  // o board projeta `Status:`, título e `Blocked by:`, e nada do *corpo*. Escrever a
  // `## Answer` de uma issue não move o hash do board — e é justamente a mudança que interessa
  // a quem está lendo aquele arquivo na gaveta. Avisar sobre o arquivo exige um sinal sobre o
  // arquivo, e é isto aqui.
  //
  // **Por que não usar a lista de caminhos do `watch.js`.** O `fs.watch` recursivo do Node
  // **para de reportar um nome depois que um `rename` troca o inode por baixo dele** — e é
  // assim que os agentes escrevem (`.md.tmp.NNNN` + `rename` por cima). A **primeira** edição
  // de um arquivo aparece na lista; da segunda em diante só o `.tmp` aparece, e o `.md` some
  // do relato do kernel. Construída sobre essa lista, a gaveta viva funcionaria uma vez por
  // arquivo e depois calaria — o pior modo de falha, porque *parece* funcionar.
  //
  // Então o watcher é **gatilho**, não testemunha: ele diz *que* o disco mexeu (para isso ele
  // basta, porque o `.tmp` sempre dispara algo), e quem diz *o quê* é o digest do conteúdo.
  //
  // E é o conteúdo, não a escrita. `fs.watch` fala de escrita: um `touch`, uma reescrita com
  // os mesmos bytes. Nada disso mudou o que alguém está lendo, e emitir por eles reintroduziria
  // pela porta dos fundos o barulho que o push veio matar.

  /**
   * Quais arquivos **desta origem** de fato mudaram de conteúdo desde a última olhada.
   *
   * Varre o disco e digere — como o `buildBoard()`, é "leia o disco agora", e só roda quando
   * alguém pergunta: no gatilho do watcher e na varredura de segurança. **Ocioso não varre**,
   * e é isso que mantém o ocioso em zero.
   *
   * Sumiço conta como mudança: quem estava lendo o arquivo precisa saber que ele não existe
   * mais. E arquivo novo também — **no escuro, avisa-se**. A assimetria é deliberada: um
   * evento a mais custa algumas centenas de bytes e a gaveta o descarta; um evento a menos é
   * silêncio, e silêncio é o modo de falha que o push existe para eliminar.
   */
  async function movedFiles() {
    const files = await walk(ns.root)
    const moved = []
    const vivos = new Set()

    for (const path of files) {
      let info
      try {
        const { size, mtimeMs } = await stat(path)
        const stamp = `${size}:${mtimeMs}`
        const prev = seen.get(path)
        vivos.add(path)
        if (prev?.stamp === stamp) continue // não foi escrito: não se lê
        const digest = size > BIG ? `big:${stamp}` : hashOf(await readFile(path))
        info = { stamp, digest }
        if (prev?.digest !== digest) moved.push(path)
      } catch {
        continue // nasceu e morreu no meio da varredura
      }
      seen.set(path, info)
    }
    for (const path of seen.keys()) {
      if (vivos.has(path)) continue
      seen.delete(path)
      moved.push(path) // sumiu: quem o estava lendo precisa saber
    }
    return moved
  }

  /**
   * A primeira olhada, no `start()`: o disco de agora não é novidade nenhuma.
   *
   * Sem ela, a primeira rajada acharia que **todo** arquivo da origem acabou de mudar (nunca
   * os vira) e empurraria uma lista de cento e quarenta caminhos. Com ela, o servidor nasce
   * sabendo o que está lá — e o que mudar depois é mudança de verdade.
   */
  const seed = () => movedFiles()

  return { refresh, movedFiles, seed }
}
