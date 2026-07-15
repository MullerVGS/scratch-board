/**
 * O layout do Gantt — **puro**, sem uma linha de DOM.
 *
 * É o grafo com o X virando tempo, e agora o tempo é **fato**, não carimbo de arquivo. As
 * bordas de cada barra vêm do **catálogo** (a transição de status que o servidor observou),
 * não do `mtime` que mentia. A regra é uma só, e é a espinha do desenho:
 *
 *   - **sólido** — o servidor **observou** a transição. A barra se subdivide pelas colunas
 *     (`triagem`/`pronto`/`curso`/`fechado`): é daí que sai o "tempo em coluna".
 *   - **hachurado** — ninguém viu, mas o disco **cerca** o intervalo (o `created`→`ended` do
 *     diretório do esforço). Hachurado é um intervalo que *contém* o fato, nunca um fato.
 *   - **até hoje** — ticket aberto corre até agora, para mostrar o quanto ele já custa.
 *
 * Recebe issues (objetos) e devolve geometria (números); quem desenha é o `gantt.js`. A
 * separação não é cosmética — é o que torna os invariantes testáveis sem um navegador
 * (`test/gantt-layout.test.js`), e o precedente do grafo já pagou essa aposta.
 *
 * **A escala entra por parâmetro** (`pxPerMs`), não como um `if`. O Gantt do esforço mede em
 * **horas** (`HOUR_W`) porque suas issues duram horas ou minutos; o Gantt global (ticket 05)
 * mede em **dias** (`DAY_W`) porque a frota se mede em meses — a mesma função, escalas
 * diferentes. Um `if` no meio do layout seria o desenho errado.
 *
 * **O "hoje" também entra por parâmetro.** Um relógio aqui dentro faria o desenho depender de
 * quando ele rodou, e os testes virariam loteria de meia-noite. Quem sabe que horas são é quem
 * desenha — a mesma doutrina do `now` do `staleLabel()`.
 */
import { depsOf } from './issues.js'

export const LABEL_W = 220
export const BAR_H = 26
export const ROW_GAP = 10
export const PAD = 18
export const AXIS_H = 26

/** Pixels por **hora** (Gantt do esforço) e por **dia** (Gantt global). A escala, materializada. */
export const HOUR_W = 80
export const DAY_W = 40

/**
 * O piso de legibilidade. Uma barra de duração sub-minuto vira uma lasca visível — zero pixel
 * seria a tela escondendo um ticket que existiu. Ele é **pequeno de propósito**: acima dele a
 * largura é proporcional à duração real, então dois tickets sub-hora de durações diferentes
 * têm larguras diferentes. Achatá-los no mesmo tamanho seria jogar fora a precisão que o
 * carimbo imóvel deu de graça — e foi por não tê-la que o Gantt de `master` virou um leque.
 */
export const MIN_BAR_W = 3

const HOUR = 3600e3
const DAY = 864e5

/**
 * O carimbo de uma faixa em ms. Ele chega como ISO (o `bar.segments[].start` do payload é o
 * instante imóvel da transição, absoluto); o guard de número é só para não estourar se um
 * chamador já o entregar em ms. As outras entradas — `now` e o `floor` — já são ms e não
 * passam por aqui.
 */
const ms = (t) => (typeof t === 'number' ? t : Date.parse(t))

/**
 * O intervalo de uma barra, e a sua natureza. Duas classes, e a fronteira entre elas é o que o
 * servidor **viu**:
 *
 * - **medido**: o catálogo tem a sequência de colunas que o ticket atravessou. A barra é
 *   sólida, vai do primeiro instante observado à resolução (ou a "hoje", se aberto), e se
 *   subdivide pelas faixas. A faixa de largura zero (o `fechado` de um ticket que termina ali)
 *   é descartada: o board não desenha tempo que não passou.
 * - **cercado**: o catálogo não viu nada. A barra é hachurada e abrange o esforço inteiro (o
 *   `floor`) — "aconteceu em algum momento aqui dentro". Aberto ou não, ela nunca afirma uma
 *   borda que ninguém observou.
 *
 * E o disco pode contradizer o cerco (um `ended` anterior ao `created`, um relógio trocado): a
 * barra se recolhe (`Math.max(end, start)`) em vez de nascer com largura negativa.
 */
function spanOf(issue, floor, now) {
  const bar = issue.bar
  if (bar?.measured && bar.segments?.length) {
    const starts = bar.segments.map((s) => ms(s.start))
    const start = starts[0]
    const end = Math.max(issue.closed ? starts[starts.length - 1] : now, start)
    const segments = bar.segments
      .map((s, i) => ({ column: s.column, start: starts[i], end: Math.min(i + 1 < starts.length ? starts[i + 1] : end, end) }))
      .filter((s) => s.end > s.start)
    return { start, end, kind: 'solid', segments }
  }
  const start = floor.start
  const end = Math.max(issue.closed ? floor.end : now, start)
  return { start, end, kind: 'hatched', segments: [] }
}

/**
 * As linhas contam a história na ordem em que ela aconteceu: quem fechou primeiro vem
 * primeiro, e as abertas — que correm até hoje — afundam para o fim. No empate, fechada antes
 * de aberta (terminar é anterior a continuar), e depois o número, para a ordem não flutuar
 * entre duas rodadas do mesmo dado.
 */
const byResolution = (spans) => (a, b) =>
  spans.get(a).end - spans.get(b).end ||
  (a.closed === b.closed ? a.number.localeCompare(b.number) : a.closed ? -1 : 1)

/**
 * O passo do eixo: o menor da lista que satisfaz **as duas** restrições — largura de tique que
 * ainda se lê (`MIN_TICK_PX`) **e** um número de tiques que não afoga o desenho (`MAX_TICKS`).
 *
 * As duas são necessárias porque a escala é fixa e o vão, não: em escala de horas, um esforço
 * de três horas quer tiques de hora, mas um de quarenta dias mediria **um tique por hora** —
 * novecentos gradis sobre um canvas gigante. O `MIN_TICK_PX` sozinho os deixaria passar (80px
 * cada); é o `MAX_TICKS` que faz o passo crescer com o vão, e é o que devolve daily/2-daily
 * quando o esforço é longo.
 */
const STEPS = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY, 365 * DAY]
const MIN_TICK_PX = 54
const MAX_TICKS = 24
const tickStep = (pxPerMs, span) =>
  STEPS.find((s) => s * pxPerMs >= MIN_TICK_PX && span / s <= MAX_TICKS) ?? STEPS[STEPS.length - 1]

export function ganttLayout(issues, byNumber, { now, pxPerMs, floor }) {
  const cercoStart = floor?.start ?? now
  const cercoEnd = floor?.end ?? now

  if (!issues.length) {
    return {
      bars: [],
      arrows: [],
      ticks: [],
      todayX: null,
      cerco: { x: LABEL_W + PAD, w: 0, start: cercoStart, end: cercoEnd },
      step: STEPS[0],
      width: LABEL_W + PAD * 2,
      height: AXIS_H + PAD * 2,
    }
  }

  const spans = new Map(issues.map((i) => [i, spanOf(i, { start: cercoStart, end: cercoEnd }, now)]))
  const rows = [...issues].sort(byResolution(spans))

  const minTime = Math.min(cercoStart, ...[...spans.values()].map((s) => s.start))
  const maxTime = Math.max(cercoEnd, ...[...spans.values()].map((s) => s.end))
  const x = (t) => LABEL_W + PAD + (t - minTime) * pxPerMs

  const bars = rows.map((issue, ri) => {
    const s = spans.get(issue)
    return {
      issue,
      x: x(s.start),
      y: AXIS_H + PAD + ri * (BAR_H + ROW_GAP),
      w: Math.max((s.end - s.start) * pxPerMs, MIN_BAR_W),
      // Os instantes crus (ms), para o tooltip dizer a duração exata — a largura em pixels já
      // passou pelo piso de legibilidade e não serve para medir.
      start: s.start,
      end: s.end,
      kind: s.kind,
      open: !issue.closed,
      // As faixas por coluna, já em pixels — o `gantt.js` só as pinta. Vazio na barra hachurada.
      segments: s.segments.map((seg) => ({ column: seg.column, x: x(seg.start), w: (seg.end - seg.start) * pxPerMs })),
    }
  })
  const barOf = new Map(bars.map((b) => [b.issue, b]))

  // A seta sai da resolução do bloqueante (a borda direita da barra dele) e entra na barra do
  // bloqueado **dali em diante** (`max`): apontar para a borda esquerda seria a seta voltando
  // no tempo quando o bloqueado "começou" antes de o bloqueante fechar. Não há recursão aqui —
  // cada aresta é geometria própria —, então ciclo não estoura; a referência morta o `depsOf`
  // já descarta.
  const arrows = []
  for (const issue of issues) {
    for (const { dep, note, raw } of depsOf(issue, byNumber)) {
      const from = barOf.get(dep)
      const to = barOf.get(issue)
      const x1 = from.x + from.w
      arrows.push({
        from: dep,
        to: issue,
        note,
        raw,
        blocking: !dep.closed,
        x1,
        y1: from.y + BAR_H / 2,
        x2: Math.max(x1, to.x),
        y2: to.y > from.y ? to.y : to.y + BAR_H,
      })
    }
  }

  // O eixo, do domínio inteiro, alinhado às fronteiras redondas de hora/dia (UTC, como o resto
  // do projeto). O passo cresce com o vão para os tiques não se atropelarem.
  const step = tickStep(pxPerMs, maxTime - minTime)
  const ticks = []
  for (let t = Math.ceil(minTime / step) * step; t <= maxTime; t += step) ticks.push({ at: t, x: x(t) })

  return {
    bars,
    arrows,
    ticks,
    step,
    // O intervalo do esforço, o **cerco**: onde vivem as barras hachuradas e a barra-pai do
    // Gantt global. Largura nunca negativa — o disco contraditório se recolhe, não inverte.
    cerco: { x: x(cercoStart), w: Math.max(0, cercoEnd - cercoStart) * pxPerMs, start: cercoStart, end: cercoEnd },
    // A linha de "hoje" só quando hoje cabe no desenho. Num esforço encerrado no passado,
    // marcá-lo seria esticar o eixo para apontar um dia em que nada daqui aconteceu.
    todayX: now >= minTime && now <= maxTime ? x(now) : null,
    width: x(maxTime) + PAD,
    height: AXIS_H + PAD * 2 + rows.length * (BAR_H + ROW_GAP) - ROW_GAP,
  }
}

/**
 * Sai da ponta do bloqueante e entra pela borda horizontal do bloqueado — um S vertical, que
 * degenera numa reta quando a queda é a pino (x1 === x2).
 */
export function arrowPath({ x1, y1, x2, y2 }) {
  const ym = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${ym}, ${x2} ${ym}, ${x2} ${y2}`
}
