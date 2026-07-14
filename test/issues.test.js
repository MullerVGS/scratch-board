/**
 * O rótulo "parado há N dias" — a conta que o **navegador** faz, e por que ela mora aqui.
 *
 * O servidor publica um **fato absoluto**: o dia em que o ticket parou (`touched`). Ele não
 * publica "há 6 dias", e não decide se o rótulo aparece — as duas coisas mudariam com o
 * relógio, e a varredura de 90s as recalcularia: o board empurraria sozinho, parado, para
 * sempre. Então o relativo é conta de cliente, e o limiar é decisão de cliente.
 *
 * O que sobra do lado do browser é aritmética de dia — que é exatamente o tipo de coisa que
 * erra por um na borda e ninguém percebe olhando. Daí este arquivo: `public/issues.js` é puro
 * (o `graph-layout.test.js` já tem o guarda que o impede de tocar no DOM), então a conta se
 * afirma sem um DOM falso, com o "agora" entrando por parâmetro — não há relógio a mockar.
 *
 * **O limiar é 3 dias**, e não é gosto: é o vale medido na frota. Dos 79 tickets abertos,
 * 70 foram tocados nos últimos 2 dias e 9 estão parados há 4 ou mais — e **nenhum** está no
 * dia 3. Dois dias cabem num fim de semana; três já são um vão de trabalho de verdade.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { STALE_DAYS, staleLabel } from '../public/issues.js'

const AGORA = Date.parse('2026-07-14T15:00:00Z')

/** Uma issue como o `/api/board` a serializa, parada há `dias`. */
const parada = (dias, extra = {}) => ({
  closed: false,
  touched: new Date(AGORA - dias * 864e5).toISOString().slice(0, 10),
  ...extra,
})

describe('o rótulo só aparece quando informa', () => {
  test('o limiar é 3 dias', () => {
    assert.equal(STALE_DAYS, 3)
  })

  test('um ticket tocado hoje não diz nada — o board não é um mural de datas', () => {
    assert.equal(staleLabel(parada(0), AGORA), null)
  })

  test('dois dias ainda calam: cabem num fim de semana', () => {
    assert.equal(staleLabel(parada(2), AGORA), null)
  })

  test('no terceiro dia o card admite que encalhou', () => {
    assert.equal(staleLabel(parada(3), AGORA), 'parado há 3 dias')
  })

  test('e conta os dias de verdade — o número é o que o disco diz', () => {
    assert.equal(staleLabel(parada(6), AGORA), 'parado há 6 dias')
    assert.equal(staleLabel(parada(41), AGORA), 'parado há 41 dias')
  })
})

describe('o que não é encalhado não recebe rótulo', () => {
  test('ticket FECHADO não está parado — está pronto', () => {
    // O `mtime` de um ticket `resolved` é a **resolução** dele, não um abandono. Um
    // "parado há 30 dias" num card fechado seria o board mentindo com cara de precisão —
    // e cobriria a coluna de resolvidos de rótulos que não informam nada.
    assert.equal(staleLabel(parada(30, { closed: true }), AGORA), null)
  })

  test('sem carimbo, o board diz nada — e não inventa uma data', () => {
    assert.equal(staleLabel({ closed: false }, AGORA), null)
  })
})

describe('a conta é de dias inteiros, e não escorrega na hora', () => {
  test('a hora não entra na conta: o número não escorrega ao longo do dia', () => {
    // O carimbo chega quantizado por dia justamente para isto. O mesmo ticket, olhado ao
    // amanhecer e à meia-noite do **mesmo dia**, diz o **mesmo número** — se a hora entrasse
    // na conta, o rótulo mudaria sozinho enquanto a aba fica aberta, e o board estaria de
    // volta a contar tempo em vez de mostrar o disco.
    const parado = { closed: false, touched: '2026-07-10' }
    assert.equal(staleLabel(parado, Date.parse('2026-07-14T00:00:01Z')), 'parado há 4 dias')
    assert.equal(staleLabel(parado, Date.parse('2026-07-14T23:59:59Z')), 'parado há 4 dias')
  })

  test('um carimbo no futuro (relógio torto, `touch -d`) não vira número negativo', () => {
    assert.equal(staleLabel(parada(-3), AGORA), null)
  })
})
