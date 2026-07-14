/**
 * Os invariantes do Gantt — o grafo com o X virando tempo.
 *
 * O precedente é o `graph-layout.test.js`, e ele já pagou: foi o teste do layout puro que
 * pegou o bug real do ciclo, numa linha que o `AGENTS.md` jurava que funcionava. Aqui os
 * invariantes são os do tempo, e todos falham em **silêncio** no navegador — a barra sai,
 * só sai mentindo:
 *
 *   - nenhuma barra começa depois de terminar, nem quando o disco contradiz o piso;
 *   - nenhuma seta anda para trás no tempo;
 *   - início incerto (piso) se distingue de início exato — e ausência de data não vira
 *     data inventada;
 *   - ticket aberto corre até hoje; ticket fechado termina quando terminou;
 *   - ciclo no `Blocked by:` não estoura.
 *
 * O "hoje" entra por parâmetro, como o `now` do `staleLabel()`: a conta é pura e não há
 * relógio a mockar.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { numberIndex, depsOf } from '../public/issues.js'
import { ganttLayout, arrowPath, BAR_H, LABEL_W, PAD } from '../public/gantt-layout.js'

/**
 * Uma issue como o `/api/board` a serializa — só os campos que o layout olha. O `created`
 * chega como o servidor o manda: `{ day, floor }`, ou `null` quando nem piso existe.
 */
const issue = (number, { blockedBy = [], closed = false, touched, created } = {}) => ({
  number,
  title: `${number} — issue ${number}`,
  status: closed ? 'resolved' : 'ready-for-agent',
  closed,
  blocked: false,
  blockedBy: blockedBy.map((n) => ({ number: n, note: `prosa do ${n}`, raw: n })),
  touched,
  created,
})

const HOJE = '2026-07-14'
const piso = (day) => ({ day, floor: true })
const exato = (day) => ({ day, floor: false })

const layout = (issues, today = HOJE) => ganttLayout(issues, numberIndex(issues), today)
const barOf = (l, number) => l.bars.find((b) => b.issue.number === number)

describe('as bordas da barra são fatos, e apontam para o lado certo', () => {
  test('nenhuma barra começa depois de terminar', () => {
    const l = layout([
      issue('01', { closed: true, touched: '2026-07-11', created: piso('2026-07-10') }),
      issue('02', { closed: true, touched: '2026-07-13', created: piso('2026-07-10') }),
      issue('03', { touched: '2026-07-13', created: piso('2026-07-10') }),
    ])
    for (const b of l.bars) assert.ok(b.w >= 0, `a barra ${b.issue.number} tem largura negativa`)
  })

  test('nem quando o disco contradiz o piso (um `cp -p` fabrica mtime anterior ao diretório)', () => {
    // O piso jura `created ≥ birthtime do diretório`, mas o disco pode mentir — um arquivo
    // copiado com `-p` para um diretório novo tem mtime mais velho que o `mkdir`. A barra
    // não repete a mentira: ela se recolhe à borda direita em vez de nascer negativa.
    const l = layout([issue('01', { closed: true, touched: '2026-07-08', created: piso('2026-07-14') })])
    const b = barOf(l, '01')
    assert.ok(b.w >= 0, 'a contradição do disco não pode virar largura negativa')
  })

  test('ticket fechado tem borda direita real: quem fechou depois termina mais à direita', () => {
    const l = layout([
      issue('01', { closed: true, touched: '2026-07-11', created: piso('2026-07-10') }),
      issue('02', { closed: true, touched: '2026-07-12', created: piso('2026-07-10') }),
    ])
    const [b01, b02] = [barOf(l, '01'), barOf(l, '02')]
    assert.equal(b02.x + b02.w - (b01.x + b01.w), l.dayW, 'um dia de diferença é um dayW de diferença')
  })

  test('ticket aberto corre até hoje — e "hoje" é de quem olha, não do layout', () => {
    const issues = () => [issue('01', { touched: '2026-07-10', created: piso('2026-07-10') })]
    const hoje = barOf(layout(issues(), '2026-07-14'), '01')
    const amanha = barOf(layout(issues(), '2026-07-15'), '01')
    assert.equal(amanha.w - hoje.w, layout(issues(), '2026-07-15').dayW, 'a barra aberta cresce com o relógio')
    assert.ok(hoje.open, 'a barra de ticket aberto se declara aberta')
  })
})

describe('piso não é fato, e a barra diz isso', () => {
  test('início incerto se distingue de início exato', () => {
    const l = layout([
      issue('01', { closed: true, touched: '2026-07-12', created: piso('2026-07-10') }),
      issue('02', { closed: true, touched: '2026-07-12', created: exato('2026-07-11') }),
    ])
    assert.equal(barOf(l, '01').floor, true, 'piso viaja como piso')
    assert.equal(barOf(l, '02').floor, false, 'o exato do catálogo (ticket 05) entra como fato')
  })

  test('ausência de data não vira data inventada', () => {
    // Sem `created` nenhum (filesystem sem birthtime), a barra não nasce em 1970 nem no
    // início do esforço vizinho: ela se ancora na única data que existe — a própria borda
    // direita — e se declara incerta.
    const l = layout([
      issue('01', { closed: true, touched: '2026-07-12', created: exato('2026-07-01') }),
      issue('02', { closed: true, touched: '2026-07-12', created: null }),
    ])
    const b = barOf(l, '02')
    assert.equal(b.floor, true, 'sem data, o início é incerto por definição')
    assert.ok(b.x > barOf(l, '01').x, 'a barra sem data não pode herdar o início de ninguém')
    assert.ok(b.w <= l.dayW, 'a barra sem início conhecido não estica sobre dias que ninguém mediu')
  })
})

describe('as setas do Blocked by:', () => {
  test('nenhuma seta anda para trás no tempo', () => {
    // O leque da fatia 1: todas as barras nascem do mesmo piso, e o bloqueante fecha DEPOIS
    // de o bloqueado "começar". A seta não pode voltar: ela sai da resolução do bloqueante
    // e entra na barra do bloqueado dali em diante.
    const issues = [
      issue('01', { closed: true, touched: '2026-07-12', created: piso('2026-07-10') }),
      issue('02', { blockedBy: ['01'], touched: '2026-07-13', created: piso('2026-07-10') }),
      issue('03', { blockedBy: ['01', '02'], touched: '2026-07-13', created: piso('2026-07-10') }),
    ]
    const l = layout(issues)
    assert.equal(l.arrows.length, 3)
    for (const a of l.arrows) {
      assert.ok(a.x2 >= a.x1, `a seta ${a.from.number} → ${a.to.number} anda para trás no tempo`)
    }
  })

  test('a prosa do bloqueio viaja com a seta — é ela que o tooltip devolve', () => {
    const issues = [
      issue('01', { closed: true, touched: '2026-07-12', created: piso('2026-07-10') }),
      issue('02', { blockedBy: ['01'], touched: '2026-07-13', created: piso('2026-07-10') }),
    ]
    const [a] = layout(issues).arrows
    assert.equal(a.note, 'prosa do 01')
    assert.equal(a.blocking, false, 'bloqueante fechado é história cumprida, não bloqueio vivo')
  })

  test('bloqueado que fechou ANTES do bloqueante: a seta continua sem voltar, mesmo que aponte para o vazio', () => {
    // Dado anômalo mas possível (um `Blocked by:` acrescentado tarde, um mtime fabricado):
    // o 02 resolveu antes de o 01 — que o "bloqueia" — fechar. "Nunca para trás no tempo" e
    // "entra na barra" ficam inconciliáveis, e a primeira é acceptance criteria: a seta sai
    // da resolução do bloqueante e aponta além da barra do bloqueado. A contradição do
    // disco fica visível em vez de redesenhada.
    const issues = [
      issue('01', { closed: true, touched: '2026-07-13', created: piso('2026-07-10') }),
      issue('02', { blockedBy: ['01'], closed: true, touched: '2026-07-11', created: piso('2026-07-10') }),
    ]
    const l = layout(issues)
    const [a] = l.arrows
    assert.ok(a.x2 >= a.x1, 'nem o dado anômalo autoriza a seta a voltar no tempo')
    const alvo = barOf(l, '02')
    assert.ok(a.x2 > alvo.x + alvo.w, 'a seta aponta além da barra: a contradição fica visível')
  })

  test('referência a issue inexistente não vira seta', () => {
    const issues = [issue('01', { blockedBy: ['99'], touched: '2026-07-13', created: piso('2026-07-10') })]
    assert.deepEqual(layout(issues).arrows, [])
  })

  test('ciclo no Blocked by: não estoura', () => {
    const issues = [
      issue('01', { blockedBy: ['02'], touched: '2026-07-13', created: piso('2026-07-10') }),
      issue('02', { blockedBy: ['01'], touched: '2026-07-13', created: piso('2026-07-10') }),
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
    // No leque, a seta cai da ponta do bloqueante direto sobre a barra de baixo: x1 === x2.
    const d = arrowPath({ x1: 100, y1: 40, x2: 100, y2: 80 })
    assert.match(d, /^M 100 40 C /)
    assert.equal(/NaN|Infinity/.test(d), false)
  })
})

describe('as linhas contam a história na ordem em que ela aconteceu', () => {
  test('fechadas saem na ordem da resolução, não na do número', () => {
    const l = layout([
      issue('01', { closed: true, touched: '2026-07-12', created: piso('2026-07-10') }),
      issue('02', { closed: true, touched: '2026-07-11', created: piso('2026-07-10') }),
    ])
    assert.ok(barOf(l, '02').y < barOf(l, '01').y, 'quem fechou primeiro vem primeiro')
  })

  test('as abertas correm até hoje e afundam para o fim', () => {
    const l = layout([
      issue('01', { touched: '2026-07-13', created: piso('2026-07-10') }),
      issue('02', { closed: true, touched: '2026-07-13', created: piso('2026-07-10') }),
    ])
    assert.ok(barOf(l, '02').y < barOf(l, '01').y, 'a fechada de hoje termina; a aberta continua')
  })
})

describe('o eixo de datas', () => {
  test('os tiques são dias, andam para a direita e cabem no domínio', () => {
    const l = layout([
      issue('01', { closed: true, touched: '2026-07-12', created: piso('2026-07-04') }),
      issue('02', { touched: '2026-07-13', created: piso('2026-07-04') }),
    ])
    assert.ok(l.ticks.length >= 2)
    assert.equal(l.ticks[0].day, '2026-07-04', 'o eixo começa onde a primeira barra começa')
    for (const t of l.ticks) assert.match(t.day, /^\d{4}-\d{2}-\d{2}$/)
    for (let i = 1; i < l.ticks.length; i++) assert.ok(l.ticks[i].x > l.ticks[i - 1].x)
    const fim = l.ticks.at(-1)
    assert.ok(fim.x <= l.width - PAD, 'nenhum tique vaza do desenho')
  })

  test('um esforço longo não vira um tique por dia — o passo cresce com o vão', () => {
    const l = layout([
      issue('01', { closed: true, touched: '2026-07-01', created: piso('2026-03-01') }),
      issue('02', { touched: '2026-07-01', created: piso('2026-03-01') }),
    ])
    assert.ok(l.ticks.length <= 24, `${l.ticks.length} tiques não se leem — o passo tem que crescer`)
  })

  test('a linha de "hoje" existe enquanto houver barra correndo — e some num esforço já encerrado', () => {
    const correndo = layout([issue('01', { touched: '2026-07-13', created: piso('2026-07-10') })])
    assert.equal(correndo.todayX, correndo.width - PAD, 'hoje é a borda direita de quem ainda corre')

    const encerrado = layout([issue('01', { closed: true, touched: '2026-07-10', created: piso('2026-07-08') })])
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
      issue('01', { closed: true, touched: '2026-07-11', created: piso('2026-07-10') }),
      issue('02', { closed: true, touched: '2026-07-12', created: piso('2026-07-10') }),
      issue('03', { touched: '2026-07-13', created: piso('2026-07-10') }),
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
    // O mesmo guarda do grafo: se o módulo passar a olhar `document`, os invariantes acima
    // voltam a ser indemonstráveis fora do navegador — e é assim que eles morrem. A
    // varredura é no *código*, com os comentários fora.
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
    // Um `Date.now()` aqui dentro faria o desenho depender de quando ele rodou — e o teste
    // inteiro viraria loteria de meia-noite. Quem sabe que horas são é quem desenha.
    const code = readFileSync(new URL('../public/gantt-layout.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    assert.equal(code.includes('Date.now'), false, 'o layout não pode ter relógio próprio')
  })
})
