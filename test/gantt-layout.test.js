/**
 * Os invariantes do Gantt do esforço, refeito sobre o catálogo — **sólido é fato, hachurado
 * é cerco.**
 *
 * O precedente é o `graph-layout.test.js`, e ele já pagou: foi o teste do layout puro que
 * pegou o bug real do ciclo, numa linha que o `AGENTS.md` jurava que funcionava. Aqui os
 * invariantes são os do tempo, e todos falham em **silêncio** no navegador — a barra sai, só
 * sai mentindo:
 *
 *   - nenhuma barra começa depois de terminar, nem quando o disco contradiz o cerco;
 *   - nenhuma seta anda para trás no tempo;
 *   - a barra **hachurada** (nunca observada) se distingue da **sólida** (medida), e o
 *     intervalo do esforço que a **cerca** a contém;
 *   - ticket aberto corre até "hoje", e "hoje" é de quem olha — entra por parâmetro;
 *   - um ticket de **20 minutos** é uma fatia entre duas horas, com largura proporcional, e
 *     não uma lasca arredondada para a hora cheia — e o piso de legibilidade não achata duas
 *     durações sub-hora diferentes no mesmo tamanho;
 *   - a **mesma** função, chamada com escala de **dia**, produz as posições do Gantt global —
 *     a escala é parâmetro, não um `if`;
 *   - a barra-pai colapsada contém as filhas; expandir não move o que já estava no eixo;
 *   - as setas de um esforço expandido são as mesmas da visão filtrada;
 *   - ciclo no `Blocked by:` não estoura.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { numberIndex } from '../public/issues.js'
import {
  ganttLayout,
  groupedGanttLayout,
  arrowPath,
  HOUR_W,
  DAY_W,
  BAR_H,
  LABEL_W,
  PAD,
  MIN_BAR_W,
} from '../public/gantt-layout.js'

const HOUR = 3600e3
const DAY = 864e5

/** O relógio de quem olha, e o cerco do esforço (o `created`→`ended` do diretório). */
const T0 = Date.parse('2026-07-10T00:00:00.000Z') // o esforço nasceu aqui
const NOW = Date.parse('2026-07-14T00:00:00.000Z')
const FLOOR = { start: T0, end: NOW }

/** px por milissegundo: a escala. Horas para o Gantt do esforço, dias para o global. */
const HOUR_PX = HOUR_W / HOUR
const DAY_PX = DAY_W / DAY

/**
 * Uma issue como o `/api/board` a serializa — só o que o layout olha. A `bar` é a projeção do
 * catálogo: `{ measured, segments }` para o que o servidor observou, `{ measured: false }`
 * para o que ele só cercou.
 */
const at = (ms) => new Date(ms).toISOString()
const measured = (...segments) => ({ measured: true, segments })
const seg = (column, startMs) => ({ column, start: at(startMs) })
const cercado = { measured: false }

const issue = (number, { blockedBy = [], closed = false, status, bar = cercado } = {}) => ({
  number,
  title: `${number} — issue ${number}`,
  status: status ?? (closed ? 'resolved' : 'ready-for-agent'),
  closed,
  blocked: false,
  blockedBy: blockedBy.map((n) => ({ number: n, note: `prosa do ${n}`, raw: n })),
  bar,
})

const layout = (issues, opts = {}) =>
  ganttLayout(issues, numberIndex(issues), { now: NOW, pxPerMs: HOUR_PX, floor: FLOOR, ...opts })
const barOf = (l, number) => l.bars.find((b) => b.issue.number === number)

const group = (slug, issues, floor = FLOOR) => ({
  id: slug,
  effort: {
    slug,
    issues,
    total: issues.length,
    closed: issues.filter((i) => i.closed).length,
  },
  floor,
})

describe('as bordas da barra são fatos, e apontam para o lado certo', () => {
  test('nenhuma barra começa depois de terminar', () => {
    const l = layout([
      issue('01', { closed: true, bar: measured(seg('pronto', T0 + HOUR), seg('fechado', T0 + 3 * HOUR)) }),
      issue('02', { bar: measured(seg('pronto', T0 + 2 * HOUR)) }),
      issue('03', { closed: true }), // cercado: hachurado sobre o esforço
    ])
    for (const b of l.bars) assert.ok(b.w >= 0, `a barra ${b.issue.number} tem largura negativa`)
  })

  test('nem quando o disco contradiz o cerco (um esforço cujo `ended` é anterior ao `created`)', () => {
    // O `ended` (ctime do `mv`) jura ser posterior ao `created` (birthtime), mas um relógio
    // trocado, um `cp -p`, pode inverter os dois. A barra hachurada não repete a mentira: ela
    // se recolhe em vez de nascer negativa.
    const invertido = { start: NOW, end: T0 }
    const l = layout([issue('01', { closed: true })], { floor: invertido })
    assert.ok(barOf(l, '01').w >= 0, 'a contradição do disco não pode virar largura negativa')
  })

  test('ticket fechado termina na resolução — o último carimbo observado', () => {
    const l = layout([
      issue('01', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 2 * HOUR)) }),
      issue('02', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 5 * HOUR)) }),
    ])
    const [b01, b02] = [barOf(l, '01'), barOf(l, '02')]
    // 02 fechou 3h depois de 01: a borda direita fica 3h * HOUR_W à direita.
    assert.ok(Math.abs(b02.x + b02.w - (b01.x + b01.w) - 3 * HOUR_W) < 0.5, 'a resolução é ao minuto, não à hora')
  })

  test('ticket aberto corre até "hoje" — e "hoje" é de quem olha, não do layout', () => {
    const issues = () => [issue('01', { bar: measured(seg('curso', T0 + HOUR)) })]
    const hoje = barOf(layout(issues()), '01')
    const amanha = barOf(layout(issues(), { now: NOW + DAY }), '01')
    assert.ok(hoje.open, 'a barra de ticket aberto se declara aberta')
    assert.ok(Math.abs(amanha.w - hoje.w - DAY * HOUR_PX) < 0.5, 'a barra aberta cresce com o relógio')
  })
})

describe('sólido é fato, hachurado é cerco', () => {
  test('a barra medida é sólida; a nunca observada é hachurada', () => {
    const l = layout([
      issue('01', { closed: true, bar: measured(seg('pronto', T0 + HOUR), seg('fechado', T0 + 4 * HOUR)) }),
      issue('02', { closed: true }), // o servidor nunca viu: só o disco cerca
    ])
    assert.equal(barOf(l, '01').kind, 'solid', 'o que o servidor observou é fato')
    assert.equal(barOf(l, '02').kind, 'hatched', 'o que ele só cercou é hachura')
  })

  test('o intervalo do esforço cerca as barras que ele contém', () => {
    const l = layout([
      issue('01', { closed: true, bar: measured(seg('pronto', T0 + 2 * HOUR), seg('fechado', T0 + 6 * HOUR)) }),
      issue('02', { closed: true }),
    ])
    const cerco = l.cerco
    assert.ok(cerco.w > 0, 'o cerco tem largura — o esforço durou')
    for (const b of l.bars) {
      assert.ok(b.x >= cerco.x - 0.5, `a barra ${b.issue.number} começa antes do esforço`)
      assert.ok(b.x + b.w <= cerco.x + cerco.w + 0.5, `a barra ${b.issue.number} termina depois do esforço`)
    }
  })

  test('a barra hachurada abrange o cerco de ponta a ponta — "aconteceu em algum lugar aqui dentro"', () => {
    const l = layout([issue('01', { closed: true })])
    const b = barOf(l, '01')
    assert.ok(Math.abs(b.x - l.cerco.x) < 0.5, 'a hachura começa onde o esforço começou')
    assert.ok(Math.abs(b.x + b.w - (l.cerco.x + l.cerco.w)) < 0.5, 'e termina onde o esforço terminou')
  })

  test('a barra medida se subdivide pelas colunas que o servidor viu', () => {
    const l = layout([
      issue('01', {
        closed: true,
        bar: measured(seg('pronto', T0 + HOUR), seg('curso', T0 + 3 * HOUR), seg('fechado', T0 + 4 * HOUR)),
      }),
    ])
    const b = barOf(l, '01')
    // pronto [+1h,+3h] e curso [+3h,+4h]; a faixa 'fechado' tem largura zero (o ticket não
    // passa tempo em "fechado" — ele termina ali) e não vira retângulo.
    const cols = b.segments.map((s) => s.column)
    assert.deepEqual(cols, ['pronto', 'curso'], 'as faixas são as colunas percorridas, sem a de largura zero')
    assert.ok(Math.abs(b.segments[0].w - 2 * HOUR_W) < 0.5, 'pronto durou duas horas')
    assert.ok(Math.abs(b.segments[1].w - 1 * HOUR_W) < 0.5, 'curso durou uma hora')
    // As faixas ladrilham a barra: a soma bate com a largura total.
    assert.ok(Math.abs(b.segments.reduce((a, s) => a + s.w, 0) - b.w) < 0.5, 'as faixas ladrilham a barra')
  })

  test('a barra hachurada não tem faixas — o board não fabrica uma transição que ninguém viu', () => {
    const l = layout([issue('01', { closed: true })])
    assert.equal(barOf(l, '01').segments.length, 0)
  })
})

describe('a fatia entre duas horas — a precisão sub-dia que o carimbo imóvel deu', () => {
  test('um ticket de 20 minutos é uma fatia proporcional, não uma lasca arredondada para a hora', () => {
    // Nasce e resolve dentro da MESMA hora do eixo: 14:10 → 14:30 do dia +4h.
    const ini = T0 + 4 * HOUR + 10 * 60e3
    const l = layout([issue('01', { closed: true, bar: measured(seg('curso', ini), seg('fechado', ini + 20 * 60e3)) })])
    const b = barOf(l, '01')
    assert.ok(Math.abs(b.w - 20 * 60e3 * HOUR_PX) < 0.5, 'a largura é a dos 20 minutos, ao minuto')
    assert.ok(b.w < HOUR_W, 'não foi arredondada para a hora cheia')
    // "começa e termina dentro da mesma hora do eixo": as duas bordas caem no mesmo balde de
    // hora (o eixo alinha os tiques às horas UTC, e o domínio começa na meia-noite T0).
    assert.equal(
      Math.floor((b.start - T0) / HOUR),
      Math.floor((b.end - 1 - T0) / HOUR),
      'a fatia não atravessa uma fronteira de hora do eixo',
    )
  })

  test('duas durações sub-hora diferentes têm larguras diferentes — o piso não as achata', () => {
    const ini = T0 + 4 * HOUR
    const vinte = layout([issue('01', { closed: true, bar: measured(seg('curso', ini), seg('fechado', ini + 20 * 60e3)) })])
    const quarenta = layout([issue('01', { closed: true, bar: measured(seg('curso', ini), seg('fechado', ini + 45 * 60e3)) })])
    const w20 = barOf(vinte, '01').w
    const w45 = barOf(quarenta, '01').w
    assert.ok(w20 >= MIN_BAR_W && w45 >= MIN_BAR_W, 'nenhuma some abaixo do piso de legibilidade')
    assert.ok(w45 > w20, 'a de 45 min é mais larga que a de 20 min — a proporção sobrevive ao piso')
  })
})

describe('a escala é parâmetro: a mesma função serve o esforço (horas) e o global (dias)', () => {
  test('trocar a escala de hora para dia reescala as posições, sem um `if` no meio', () => {
    const issues = [
      issue('01', { closed: true, bar: measured(seg('pronto', T0 + DAY), seg('fechado', T0 + 3 * DAY)) }),
      issue('02', { bar: measured(seg('curso', T0 + 2 * DAY)) }),
    ]
    const emHoras = ganttLayout(issues, numberIndex(issues), { now: NOW, pxPerMs: HOUR_PX, floor: FLOOR })
    const emDias = ganttLayout(issues, numberIndex(issues), { now: NOW, pxPerMs: DAY_PX, floor: FLOOR })

    const dxH = barOf(emHoras, '01').x - LABEL_W - PAD
    const dxD = barOf(emDias, '01').x - LABEL_W - PAD
    // A mesma issue, o mesmo instante: só a escala mudou. O deslocamento é proporcional a ela.
    assert.ok(dxH > 0 && dxD > 0)
    assert.ok(Math.abs(dxH / dxD - HOUR_PX / DAY_PX) < 1e-6, 'a posição escala com pxPerMs')
    assert.ok(Math.abs(barOf(emHoras, '01').w / barOf(emDias, '01').w - HOUR_PX / DAY_PX) < 1e-6, 'a largura também')
  })
})

describe('o Gantt global agrupa esforços sem inventar outro eixo', () => {
  const issues = () => [
    issue('01', { closed: true, bar: measured(seg('pronto', T0 + DAY), seg('fechado', T0 + 2 * DAY)) }),
    issue('02', { blockedBy: ['01'], bar: measured(seg('curso', T0 + 2 * DAY)) }),
    issue('03', { closed: true, bar: measured(seg('fechado', NOW)) }),
  ]

  test('a barra-pai colapsada abrange as issues que esconde', () => {
    const collapsed = groupedGanttLayout([group('alpha', issues())], {
      now: NOW,
      pxPerMs: DAY_PX,
    })
    const expanded = groupedGanttLayout([group('alpha', issues())], {
      now: NOW,
      pxPerMs: DAY_PX,
      expanded: ['alpha'],
    })
    const [parent] = collapsed.parents
    assert.equal(collapsed.bars.length, 0, 'colapsado desenha só a linha-pai')
    for (const child of expanded.bars) {
      assert.ok(child.x >= parent.x - 0.5, `a issue ${child.issue.number} começa dentro da pai`)
      assert.ok(child.x + child.w <= parent.x + parent.w + 0.5, `a issue ${child.issue.number} termina dentro da pai`)
    }
  })

  test('expandir só abre linhas: não move no tempo as barras-pai já desenhadas', () => {
    const groups = [group('alpha', issues()), group('beta', [issue('01', { closed: true })])]
    const collapsed = groupedGanttLayout(groups, { now: NOW, pxPerMs: DAY_PX })
    const expanded = groupedGanttLayout(groups, { now: NOW, pxPerMs: DAY_PX, expanded: ['alpha'] })
    for (const before of collapsed.parents) {
      const after = expanded.parents.find((p) => p.group.id === before.group.id)
      assert.equal(after.x, before.x, `${before.group.id} conserva o instante inicial`)
      assert.equal(after.w, before.w, `${before.group.id} conserva a duração`)
    }
  })

  test('confirmar fora do cerco amplia o eixo, nunca a camada medida da barra-pai', () => {
    const [baseline] = groupedGanttLayout([group('alpha', issues())], { now: NOW, pxPerMs: DAY_PX }).parents
    const alpha = group('alpha', issues())
    alpha.effort.confirmed = { start: at(T0 - 20 * DAY), end: at(T0 - 10 * DAY) }
    alpha.effort.issues[0].bar.confirmed = { start: at(T0 - 15 * DAY), end: at(T0 - 12 * DAY) }

    const withConfirmation = groupedGanttLayout([alpha], { now: NOW, pxPerMs: DAY_PX })
    const [parent] = withConfirmation.parents
    assert.equal(parent.start, FLOOR.start, 'a lembrança não muda o início medido')
    assert.equal(parent.end, FLOOR.end, 'a lembrança não muda o fim medido')
    assert.equal(parent.w, baseline.w, 'a largura medida conserva o mesmo cerco de antes da lembrança')
    assert.ok(parent.confirmed.x < parent.x, 'a camada confirmada ainda cabe no eixo, separada da medida')
  })

  test('as setas das issues expandidas são as mesmas do layout filtrado', () => {
    const children = issues()
    const filtered = ganttLayout(children, numberIndex(children), {
      now: NOW,
      pxPerMs: DAY_PX,
      floor: FLOOR,
    })
    const global = groupedGanttLayout([group('alpha', children)], {
      now: NOW,
      pxPerMs: DAY_PX,
      expanded: ['alpha'],
    })
    assert.equal(global.arrows.length, filtered.arrows.length)
    for (let i = 0; i < filtered.arrows.length; i++) {
      assert.equal(global.arrows[i].from.number, filtered.arrows[i].from.number)
      assert.equal(global.arrows[i].to.number, filtered.arrows[i].to.number)
      assert.equal(global.arrows[i].x1, filtered.arrows[i].x1)
      assert.equal(global.arrows[i].x2, filtered.arrows[i].x2)
    }
  })
})

describe('o futuro do eixo: `axisPad` abre espaço à direita do "agora"', () => {
  test('o eixo se estica para o futuro, mas as barras e o cerco param no tempo real', () => {
    // Esforço vivo: uma issue aberta corre até "hoje" (NOW). O `axisPad` de 6h põe eixo além dela.
    const floor = { start: T0, end: NOW }
    const issues = [issue('01', { bar: measured(seg('curso', NOW - 2 * HOUR)) })]
    const semPad = ganttLayout(issues, numberIndex(issues), { now: NOW, pxPerMs: HOUR_PX, floor, tickEvery: HOUR })
    const comPad = ganttLayout(issues, numberIndex(issues), { now: NOW, pxPerMs: HOUR_PX, floor, tickEvery: HOUR, axisPad: 6 * HOUR })
    assert.ok(Math.abs(comPad.width - semPad.width - 6 * HOUR_W) < 0.5, 'o eixo cresceu as 6h de futuro pedidas')
    assert.equal(comPad.todayX, semPad.todayX, 'o "hoje" fica onde estava — o futuro é à direita dele')
    assert.equal(barOf(comPad, '01').w, barOf(semPad, '01').w, 'a barra aberta não invade o futuro; ela para em "hoje"')
    assert.equal(comPad.cerco.w, semPad.cerco.w, 'o cerco também não se estica')
    assert.ok(comPad.ticks.at(-1).at > semPad.ticks.at(-1).at, 'há tiques de hora no futuro, rotulados')
  })

  test('num esforço encerrado no passado, o futuro NÃO se estica — não há "hoje" para centralizar', () => {
    // Todas fechadas, cerco terminando antes de NOW: "hoje" está fora do desenho.
    const floor = { start: T0, end: T0 + 6 * HOUR }
    const issues = [issue('01', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 5 * HOUR)) })]
    const l = ganttLayout(issues, numberIndex(issues), { now: NOW, pxPerMs: HOUR_PX, floor, tickEvery: HOUR, axisPad: 6 * HOUR })
    assert.equal(l.todayX, null, 'um desenho todo no passado não tem "hoje"')
    assert.ok(l.ticks.at(-1).at <= T0 + 6 * HOUR, 'sem futuro esticado: o eixo para no fim do esforço')
  })
})

describe('o eixo preenchido: `tickEvery` põe um tique por unidade', () => {
  test('com `tickEvery: HORA`, todo horário aparece — um tique por hora, sem pular', () => {
    // Cerco de 6 horas: o eixo tem que trazer as 7 fronteiras (00h..06h), não de 2 em 2.
    const floor = { start: T0, end: T0 + 6 * HOUR }
    const issues = [issue('01', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 5 * HOUR)) })]
    const l = ganttLayout(issues, numberIndex(issues), { now: NOW, pxPerMs: HOUR_PX, floor, tickEvery: HOUR })
    assert.equal(l.step, HOUR, 'o passo é a hora que se pediu, não o automático')
    assert.equal(l.ticks.length, 7, 'as 7 fronteiras de hora do vão de 6h estão todas lá')
    for (let i = 1; i < l.ticks.length; i++) {
      assert.ok(Math.abs(l.ticks[i].x - l.ticks[i - 1].x - HOUR_W) < 0.5, 'os tiques distam uma hora um do outro')
    }
  })

  test('a rede: um vão de semanas em escala de hora não gera milhares de tiques — o passo volta a crescer', () => {
    const floor = { start: T0, end: T0 + 30 * DAY }
    const issues = [issue('01', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 20 * DAY)) })]
    const l = ganttLayout(issues, numberIndex(issues), { now: NOW, pxPerMs: HOUR_PX, floor, tickEvery: HOUR })
    assert.ok(l.step > HOUR, 'passar da rede devolve o passo automático, maior que a hora')
    assert.ok(l.ticks.length <= 40, `${l.ticks.length} tiques ainda se leem — a rede segurou o preenchimento`)
  })

  test('sem `tickEvery`, o passo é o automático — é assim que o global mede em dias', () => {
    const issues = [issue('01', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 3 * DAY)) })]
    const l = ganttLayout(issues, numberIndex(issues), { now: NOW, pxPerMs: DAY_PX, floor: FLOOR })
    assert.ok(l.step >= DAY, 'sem preencher, o passo cresce sozinho para os dias não se atropelarem')
  })
})

describe('as setas do Blocked by:', () => {
  test('nenhuma seta anda para trás no tempo', () => {
    const issues = [
      issue('01', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 3 * HOUR)) }),
      issue('02', { blockedBy: ['01'], bar: measured(seg('curso', T0 + 3 * HOUR)) }),
      issue('03', { blockedBy: ['01', '02'], bar: measured(seg('curso', T0 + 4 * HOUR)) }),
    ]
    const l = layout(issues)
    assert.equal(l.arrows.length, 3)
    for (const a of l.arrows) {
      assert.ok(a.x2 >= a.x1, `a seta ${a.from.number} → ${a.to.number} anda para trás no tempo`)
    }
  })

  test('a prosa do bloqueio viaja com a seta — é ela que o tooltip devolve', () => {
    const issues = [
      issue('01', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 3 * HOUR)) }),
      issue('02', { blockedBy: ['01'], bar: measured(seg('curso', T0 + 3 * HOUR)) }),
    ]
    const [a] = layout(issues).arrows
    assert.equal(a.note, 'prosa do 01')
    assert.equal(a.blocking, false, 'bloqueante fechado é história cumprida, não bloqueio vivo')
  })

  test('bloqueado que fechou ANTES do bloqueante: a seta continua sem voltar', () => {
    // Dado anômalo mas possível (um `Blocked by:` acrescentado tarde): o 02 resolveu antes de
    // o 01 fechar. "Nunca para trás no tempo" é acceptance criteria: a seta sai da resolução do
    // bloqueante e aponta além da barra do bloqueado. A contradição do disco fica visível.
    const issues = [
      issue('01', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 5 * HOUR)) }),
      issue('02', { blockedBy: ['01'], closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 2 * HOUR)) }),
    ]
    const l = layout(issues)
    const [a] = l.arrows
    assert.ok(a.x2 >= a.x1, 'nem o dado anômalo autoriza a seta a voltar no tempo')
    const alvo = barOf(l, '02')
    assert.ok(a.x2 > alvo.x + alvo.w, 'a seta aponta além da barra: a contradição fica visível')
  })

  test('referência a issue inexistente não vira seta', () => {
    const issues = [issue('01', { blockedBy: ['99'], bar: measured(seg('curso', T0 + HOUR)) })]
    assert.deepEqual(layout(issues).arrows, [])
  })

  test('ciclo no Blocked by: não estoura', () => {
    const issues = [
      issue('01', { blockedBy: ['02'], bar: measured(seg('curso', T0 + HOUR)) }),
      issue('02', { blockedBy: ['01'], bar: measured(seg('curso', T0 + HOUR)) }),
    ]
    const l = layout(issues)
    assert.equal(l.bars.length, 2)
    for (const b of l.bars) assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y))
    for (const a of l.arrows) {
      assert.ok(Number.isFinite(a.x1) && Number.isFinite(a.x2))
      assert.ok(a.x2 >= a.x1)
    }
  })

  test('o caminho da seta é finito mesmo na vertical pura', () => {
    const d = arrowPath({ x1: 100, y1: 40, x2: 100, y2: 80 })
    assert.match(d, /^M 100 40 C /)
    assert.equal(/NaN|Infinity/.test(d), false)
  })
})

describe('as linhas contam a história na ordem em que ela aconteceu', () => {
  test('fechadas saem na ordem da resolução, não na do número', () => {
    const l = layout([
      issue('01', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 4 * HOUR)) }),
      issue('02', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 2 * HOUR)) }),
    ])
    assert.ok(barOf(l, '02').y < barOf(l, '01').y, 'quem fechou primeiro vem primeiro')
  })

  test('as abertas correm até hoje e afundam para o fim', () => {
    const l = layout([
      issue('01', { bar: measured(seg('curso', T0 + HOUR)) }),
      issue('02', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 5 * HOUR)) }),
    ])
    assert.ok(barOf(l, '02').y < barOf(l, '01').y, 'a fechada termina; a aberta continua')
  })
})

describe('o eixo de tempo', () => {
  test('os tiques andam para a direita e cabem no domínio', () => {
    const l = layout([
      issue('01', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 6 * HOUR)) }),
      issue('02', { bar: measured(seg('curso', T0 + 2 * HOUR)) }),
    ])
    assert.ok(l.ticks.length >= 2)
    for (let i = 1; i < l.ticks.length; i++) assert.ok(l.ticks[i].x > l.ticks[i - 1].x)
    assert.ok(l.ticks.at(-1).x <= l.width - PAD, 'nenhum tique vaza do desenho')
  })

  test('um vão longo não vira um tique por hora — o passo cresce', () => {
    const l = layout([issue('01', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 40 * DAY)) })], {
      floor: { start: T0, end: T0 + 40 * DAY },
    })
    assert.ok(l.ticks.length <= 30, `${l.ticks.length} tiques não se leem — o passo tem que crescer`)
  })

  test('a linha de "hoje" existe enquanto houver barra correndo — e some num esforço encerrado', () => {
    const correndo = layout([issue('01', { bar: measured(seg('curso', T0 + HOUR)) })])
    assert.ok(correndo.todayX !== null, 'hoje tem lugar quando algo ainda corre')

    // Esforço encerrado no passado: todas fechadas, cerco terminando antes de "hoje".
    const passado = { start: T0, end: T0 + 6 * HOUR }
    const encerrado = layout(
      [issue('01', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 5 * HOUR)) })],
      { floor: passado },
    )
    assert.equal(encerrado.todayX, null, 'um desenho todo no passado não tem onde pôr o "hoje"')
  })

  test('esforço sem issues devolve um layout vazio, não uma exceção', () => {
    const l = layout([])
    assert.deepEqual(l.bars, [])
    assert.deepEqual(l.arrows, [])
    assert.ok(Number.isFinite(l.width) && Number.isFinite(l.height))
  })
})

describe('a geometria que o desenho assume', () => {
  test('as linhas se empilham a passo fixo, e a barra referencia a issue que a origina', () => {
    const l = layout([
      issue('01', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 2 * HOUR)) }),
      issue('02', { closed: true, bar: measured(seg('pronto', T0), seg('fechado', T0 + 3 * HOUR)) }),
      issue('03', { bar: measured(seg('curso', T0 + HOUR)) }),
    ])
    const passo = l.bars[1].y - l.bars[0].y
    assert.equal(l.bars[2].y - l.bars[1].y, passo, 'o passo entre linhas é constante')
    assert.ok(passo >= BAR_H, 'uma linha não atropela a outra')
    for (const b of l.bars) assert.ok(b.x >= LABEL_W, 'nenhuma barra invade a coluna dos rótulos')
    assert.ok(l.height >= l.bars.at(-1).y + BAR_H, 'a última linha cabe na altura anunciada')
  })
})

describe('o layout é puro', () => {
  test('`gantt-layout.js` não toca no DOM nem arrasta módulo impuro', () => {
    const code = readFileSync(new URL('../public/gantt-layout.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    for (const forbidden of ['document', 'window', 'navigator', 'localStorage', 'innerHTML']) {
      assert.ok(!code.includes(forbidden), `gantt-layout.js não pode tocar em \`${forbidden}\``)
    }
    const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    assert.deepEqual(
      imports.filter((i) => !['./issues.js'].includes(i)),
      [],
      'gantt-layout.js só pode importar de módulos puros',
    )
  })

  test('e não tem relógio dentro: o "hoje" entra por parâmetro', () => {
    const code = readFileSync(new URL('../public/gantt-layout.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    assert.equal(code.includes('Date.now'), false, 'o layout não pode ter relógio próprio')
  })
})
