// O catálogo: **o que o servidor lembra depois de morrer.**
//
// O board é uma projeção do disco, e o disco não guarda *quando* o trabalho andou. O `mtime`
// parece guardar e mente: ele é a última escrita no arquivo, e um `.md` é reescrito por
// motivos que nada têm a ver com a própria execução dele — o `Blocked by:` de outra issue, um
// typo, o resultado de outro ticket derramado no mesmo esforço. O sinal verdadeiro sempre
// esteve no **cabeçalho**: as skills trocam a linha `Status:` conforme o trabalho anda, e um
// toque tangencial não a move.
//
// Então o eixo de tempo é a **transição de status**, e é isso que este módulo persiste.
//
// **Ele observa a projeção, não o disco.** O `buildBoard()` já parseou todo `.md` e já
// produziu `issue.status`; reabrir os arquivos aqui seria um segundo leitor de disco, que
// pode divergir do primeiro. O `sync()` entrega o board recém-construído, e o catálogo só
// compara.
//
// **O fato é uma observação com janela, nunca uma transição com instante.** O servidor não
// vê transições: ele vê arquivos, quando varre. Se ficou fora dois dias e o ticket, nesse
// meio, andou de `pronto` para `curso` e depois fechou, ele acorda vendo só `resolved` —
// carimbar isso como "aconteceu agora" seria a mesma classe de mentira do `mtime`, e mais
// difícil de perceber. Cada linha carrega `after` (quando vi o status velho pela última vez)
// e `before` (quando vi o novo). Com o servidor de pé, a janela são segundos. Com ele fora,
// ela incha — e a tela desenha a incerteza em vez de escondê-la.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * O volume do catálogo. **Não é o `.scratch/`**, que continua `:ro` — a garantia de que o
 * board não corrompe os tickets é do mount, não da boa intenção. Aqui é o estado do
 * servidor, e é só dele.
 *
 * Resolvido no import, como o `SCRATCHES` do `paths.js`: o teste planta o ambiente antes.
 */
export const HISTORY = resolve(process.env.HISTORY_DIR ?? '/workspace/history')

const LOG = 'history.jsonl'
const ALIVE = 'alive'

// A identidade é a **tripla**, nunca o caminho. Arquivar é `mv .scratch/<slug>
// .scratch/archive/<slug>`: o caminho de *toda* issue do esforço muda de uma vez. Com chave
// por caminho, arquivar apagaria a história do esforço inteiro — e esforço arquivado é
// esforço **terminado**, exatamente aquele cuja duração o Gantt existe para mostrar. Com a
// tripla, arquivar não é nada: a chave não se mexeu.
//
// A origem entra porque dois esforços de slug igual em repos diferentes **existem**, e
// fundi-los não devolveria `undefined` — devolveria o esforço errado.
const keyOf = (ns, slug, number) => `${ns} ${slug} ${number}`

const iso = (ms) => new Date(ms).toISOString()

export async function createHistory(dir = HISTORY) {
  await mkdir(dir, { recursive: true })
  const log = join(dir, LOG)
  const beat = join(dir, ALIVE)

  /**
   * Por ticket: o último status que eu registrei, a janela em que ele entrou nesse status, e
   * **quando eu o vi pela última vez** — este só em memória, e de propósito.
   *
   * `lastSeen` se move a cada varredura (a cada 90s, e a cada escrita no disco). Persistí-lo
   * seria reescrever o log o dia inteiro para não dizer nada: "continua igual" não é um fato
   * que mereça uma linha. Ele existe para fechar o `after` da próxima transição, e através
   * de um restart quem faz esse papel é o **batimento** (ver abaixo).
   */
  const state = new Map()

  /**
   * Por ticket: a **sequência ordenada** dos status que eu observei, cada um com o instante em
   * que eu o confirmei (`at`). O `state` acima guarda só o último; isto guarda o caminho —
   * é dele que o Gantt (ticket 04) tira a subdivisão da barra por coluna, o "tempo em coluna".
   *
   * O `at` de um status é o `before` da transição que entrou nele (para uma transição) ou o
   * `at` do primeiro encontro (para um `seen`): o **limite esquerdo** confiável da faixa
   * daquela coluna. Não é o nascimento do ticket nem o instante em que o arquivo foi escrito —
   * é o instante em que o servidor viu aquele estado pela primeira vez.
   *
   * Como o `state`, é reconstruído do log na subida e vive só em memória: o log é a verdade
   * durável, isto é o índice que o serve.
   */
  const trail = new Map()

  /**
   * A última lembrança confirmada por alvo. O log continua guardando **todas**; este mapa é
   * só a projeção que o board lê, e por isso uma segunda confirmação vence sem apagar a
   * primeira. Para esforço, `number` é ausente e a mesma chave termina vazia.
   */
  const confirmed = new Map()

  // O `seen` **abre** a trilha (é o primeiro encontro, uma vez por ticket); o `move` a
  // **estende**. Um `move` antes de qualquer `seen` não acontece — o servidor sempre vê o
  // ticket parado antes de vê-lo andar —, mas se o log estiver assim, a trilha começa nele
  // em vez de estourar.
  const open = (key, status, at) => trail.set(key, [{ status, at }])
  const extend = (key, status, at) => (trail.get(key) ?? trail.set(key, []).get(key)).push({ status, at })

  /**
   * O último instante em que o servidor esteve vivo — e, por indução, o último em que ele viu
   * cada ticket no status registrado. É o que permite fechar a janela de uma transição que
   * aconteceu **enquanto ele estava fora**: ela caiu em algum ponto entre o batimento e
   * agora, e num `restart` isso são segundos.
   *
   * Sem ele, o servidor teria que escolher entre inventar um instante (mentir) ou abrir a
   * janela até o nascimento do ticket (jogar fora tudo o que ele de fato observou).
   *
   * `null` no primeiro boot da vida: não havia ninguém vigiando, e é isso que ele diz.
   */
  let alive = null

  // ---------- a subida: relê o que ficou ----------

  const replay = (ev) => {
    if (ev.kind === 'seen') {
      const key = keyOf(ev.ns, ev.e, ev.n)
      state.set(key, {
        status: ev.status,
        since: { after: null, before: ev.at },
        lastSeen: null,
      })
      open(key, ev.status, ev.at)
      return
    }
    if (ev.kind === 'move') {
      const key = keyOf(ev.ns, ev.e, ev.n)
      state.set(key, {
        status: ev.to,
        since: { after: ev.after, before: ev.before },
        lastSeen: null,
      })
      // A faixa da coluna nova começa quando eu a **confirmei** — o `before` —, não quando o
      // ticket saiu da anterior (o `after`, que pode ser uma janela larga através de um restart).
      extend(key, ev.to, ev.before)
      return
    }
    if (ev.kind === 'confirm' && ev.src === 'confirmado') {
      confirmed.set(keyOf(ev.ns, ev.e, ev.n), { start: ev.start, end: ev.end })
    }
  }

  try {
    // Linha a linha, e uma linha ruim é **descartada sozinha**. É a razão de o formato ser
    // append-only em vez de um snapshot reescrito: um `append` interrompido perde no máximo
    // a última linha, enquanto um snapshot cortado no meio de um crash leva a história
    // inteira. Um `JSON.parse` do arquivo todo devolveria zero história por causa de meia
    // linha — e zerar em silêncio é o pior modo de falha que este projeto tem.
    for (const line of (await readFile(log, 'utf8')).split('\n')) {
      if (!line) continue
      try {
        replay(JSON.parse(line))
      } catch { /* linha truncada: o processo morreu no meio do append */ }
    }
  } catch { /* não há log ainda — é o primeiro boot da vida */ }

  try {
    // Normaliza o batimento de string ISO para ms. Data inválida resulta em `null` —
    // o mesmo caminho seguro de "arquivo não existe". `lastSeen` é sempre `number | null`.
    const parsed = JSON.parse(await readFile(beat, 'utf8')).at
    const parsedMs = new Date(parsed).getTime()
    alive = Number.isFinite(parsedMs) ? parsedMs : null
  } catch { /* sem batimento: ninguém estava vigiando antes de mim */ }

  // Todo ticket que eu conhecia, eu o vi no batimento — foi o último instante em que estive
  // de pé, e até ali ele estava no status que o log registra.
  for (const entry of state.values()) entry.lastSeen = alive

  // ---------- a observação ----------

  const append = (ev) => appendFile(log, JSON.stringify(ev) + '\n')

  /**
   * Compara o board recém-construído com o que eu lembro, e escreve **só o que mudou**.
   *
   * O `now` entra por parâmetro, e não é zelo de testabilidade: é a mesma doutrina do resto
   * do projeto (o "hoje" do Gantt vem do navegador, o "agora" do rótulo de encalhe vem de
   * quem olha). Relógio que o módulo lê sozinho é relógio que o teste não consegue fabricar.
   */
  async function observe(ns, efforts, now) {
    const events = []
    for (const effort of efforts) {
      for (const issue of effort.issues) {
        const key = keyOf(ns, effort.slug, issue.number)
        const known = state.get(key)

        if (!known) {
          // Primeiro encontro. **O limite inferior é desconhecido, e é isso que se grava** —
          // um `after: null` que a tela vai desenhar como hachura. Chutar o nascimento aqui
          // (o `birthtime` do arquivo, o `mtime`) seria inventar uma data, e data podre mente
          // com mais confiança que a ausência dela.
          const at = iso(now)
          events.push({ src: 'medido', kind: 'seen', ns, e: effort.slug, n: issue.number, status: issue.status, at })
          state.set(key, { status: issue.status, since: { after: null, before: at }, lastSeen: now })
          open(key, issue.status, at)
          continue
        }

        if (known.status === issue.status) {
          known.lastSeen = now // em memória, e só: "continua igual" não merece uma linha
          continue
        }

        // A transição. `after` é o **último instante em que eu vi o status velho** — não o
        // nascimento do ticket, não o instante em que o arquivo foi escrito. É o limite
        // inferior mais apertado que eu posso afirmar sem inventar nada.
        const after = known.lastSeen === null ? null : iso(known.lastSeen)
        const before = iso(now)
        events.push({
          src: 'medido',
          kind: 'move',
          ns,
          e: effort.slug,
          n: issue.number,
          from: known.status,
          to: issue.status,
          after,
          before,
        })
        state.set(key, { status: issue.status, since: { after, before }, lastSeen: now })
        extend(key, issue.status, before)
      }
    }

    // Um `append` por evento, em ordem. Não se agrupa: uma linha por fato é o que torna o
    // arquivo legível num `cat` e o que faz uma escrita interrompida perder um fato, não uma
    // rajada.
    for (const ev of events) await append(ev)

    // O batimento, a cada varredura. É um arquivo minúsculo reescrito por cima, e ele **não**
    // vive no `.scratch/` — logo não acorda watcher nenhum e não pode empurrar o board.
    await writeFile(beat, JSON.stringify({ at: iso(now) }) + '\n')
  }

  /** O que eu sei sobre um ticket — ou `null`, que é uma resposta legítima e a tela sabe desenhar. */
  const of = (ns, slug, number) => {
    const entry = state.get(keyOf(ns, slug, number))
    return entry ? { status: entry.status, since: entry.since } : null
  }

  /**
   * A sequência de status observados de um ticket, do primeiro encontro até agora — cada um
   * com o instante em que entrou nele. **Lista vazia** para um ticket que o catálogo nunca
   * viu: é uma resposta legítima, e o Gantt a desenha como uma barra hachurada (o disco
   * *cerca* o fato, mas ninguém o observou).
   *
   * Uma cópia, nunca o array interno: quem lê o catálogo não pode mutar a memória dele.
   */
  const observations = (ns, slug, number) =>
    (trail.get(keyOf(ns, slug, number)) ?? []).map((o) => ({ ...o }))

  /**
   * Soma uma lembrança ao mesmo JSONL das observações. O append acontece antes da memória:
   * se o disco recusar a escrita, a projeção não pode afirmar uma confirmação que não durou.
   */
  async function confirm(ns, slug, number, start, end, now) {
    const ev = {
      src: 'confirmado',
      kind: 'confirm',
      ns,
      e: slug,
      ...(number === undefined ? {} : { n: number }),
      start,
      end,
      at: iso(now),
    }
    await append(ev)
    confirmed.set(keyOf(ns, slug, number), { start, end })
    return { start, end }
  }

  const confirmation = (ns, slug, number) => {
    const range = confirmed.get(keyOf(ns, slug, number))
    return range ? { ...range } : null
  }

  return {
    observe,
    confirm,
    confirmation,
    of,
    observations,
    // Devolve a string ISO do último batimento, ou `null` se não houver.
    // `lastSeen` é sempre `number | null` em memória; a conversão sai aqui.
    get alive() {
      return alive === null ? null : iso(alive)
    },
  }
}
