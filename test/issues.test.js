/**
 * O rótulo `"em <coluna> há N"` — a conta que o **navegador** faz, e por que ela mora aqui.
 *
 * O servidor publica um **fato absoluto e imóvel**: `issue.held = { at, floor }`, o instante em
 * que o ticket entrou na coluna atual (uma transição de `Status:`, do catálogo — não o `mtime`)
 * e se esse instante é um piso. Ele não publica `"há 6 dias"`, não escolhe a unidade e não
 * decide se o rótulo aparece — as três coisas mudariam com o relógio, e a varredura de 90s as
 * recalcularia: o board empurraria sozinho, parado, para sempre. Então o relativo, a unidade e o
 * limiar são conta de cliente.
 *
 * O que sobra do lado do browser é aritmética de tempo — que erra por um na borda e ninguém
 * percebe olhando. Daí este arquivo: `public/issues.js` é puro (o `graph-layout.test.js` já tem
 * o guarda que o impede de tocar no DOM), então a conta se afirma sem um DOM falso, com o "agora"
 * entrando por parâmetro — não há relógio a mockar.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { MIN_COLUMN_MS, columnLabel } from '../public/issues.js'

const AGORA = Date.parse('2026-07-14T15:00:00Z')

/** Uma issue como o `/api/board` a serializa, na coluna `column` desde `ms` atrás. */
const naColuna = (column, ms, { floor = false, closed = false } = {}) => ({
  closed,
  column,
  held: { at: new Date(AGORA - ms).toISOString(), floor },
})

const MIN = 60_000
const HORA = 60 * MIN
const DIA = 24 * HORA

describe('a unidade acompanha a idade', () => {
  test('em dias quando passa de um dia — e conta os dias de verdade', () => {
    assert.equal(columnLabel(naColuna('pronto', 6 * DIA), AGORA), 'em pronto há 6 dias')
    assert.equal(columnLabel(naColuna('pronto', 41 * DIA), AGORA), 'em pronto há 41 dias')
  })

  test('"1 dia", não "1 dias" — a borda do singular', () => {
    assert.equal(columnLabel(naColuna('curso', DIA + 3 * HORA), AGORA), 'em curso há 1 dia')
  })

  test('abaixo de um dia desce para horas', () => {
    assert.equal(columnLabel(naColuna('curso', 5 * HORA), AGORA), 'em curso há 5h')
    assert.equal(columnLabel(naColuna('curso', 23 * HORA), AGORA), 'em curso há 23h')
  })

  test('abaixo de uma hora desce para minutos — "em curso há 40min"', () => {
    assert.equal(columnLabel(naColuna('curso', 40 * MIN), AGORA), 'em curso há 40min')
  })

  test('a coluna sai no rótulo, seja qual for', () => {
    assert.equal(columnLabel(naColuna('triagem', 2 * DIA), AGORA), 'em triagem há 2 dias')
  })
})

describe('o piso: o servidor diz o que sabe em vez de calar', () => {
  test('não observado ⇒ prefixo ≥, e ele não some sozinho', () => {
    assert.equal(columnLabel(naColuna('pronto', 3 * DIA, { floor: true }), AGORA), 'em pronto há ≥3 dias')
  })

  test('observado ⇒ fato, sem o ≥', () => {
    assert.equal(columnLabel(naColuna('pronto', 3 * DIA, { floor: false }), AGORA), 'em pronto há 3 dias')
  })

  test('o piso vale em qualquer unidade', () => {
    assert.equal(columnLabel(naColuna('curso', 40 * MIN, { floor: true }), AGORA), 'em curso há ≥40min')
  })
})

describe('o que não informa não recebe rótulo', () => {
  test('issue FECHADA não está numa coluna esperando — está pronta', () => {
    // O `held` até viaja numa issue fechada (o Gantt quer a barra), mas "em fechado há 30 dias"
    // seria uma data verdadeira contando uma história falsa: ela não encalhou, terminou.
    assert.equal(columnLabel(naColuna('fechado', 30 * DIA, { closed: true }), AGORA), null)
  })

  test('sem `held.at`, o board diz nada — o catálogo ainda não sabe, e não se inventa uma data', () => {
    assert.equal(columnLabel({ closed: false, column: 'pronto', held: { at: null, floor: false } }, AGORA), null)
    assert.equal(columnLabel({ closed: false, column: 'pronto' }, AGORA), null)
  })

  test('recém-entrado (abaixo de um minuto) cala — não informa encalhe nenhum', () => {
    assert.equal(MIN_COLUMN_MS, 60_000)
    assert.equal(columnLabel(naColuna('curso', 30_000), AGORA), null)
    // No próprio limiar ele já informa: um minuto redondo é "há 1min".
    assert.equal(columnLabel(naColuna('curso', MIN), AGORA), 'em curso há 1min')
  })

  test('um instante no futuro (relógio torto) não vira rótulo — fica abaixo do limiar', () => {
    assert.equal(columnLabel(naColuna('curso', -3 * DIA), AGORA), null)
  })
})
