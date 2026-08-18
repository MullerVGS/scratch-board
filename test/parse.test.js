/**
 * Caracterização do parser do servidor — o comportamento que existe HOJE.
 *
 * Estes testes não julgam o parser: eles o congelam. São a rede que torna segura a
 * fusão das duas implementações num `shared/parse.js` só. Os dois bugs que o `AGENTS.md`
 * registra quebraram em silêncio — o parser não estoura, ele só passa a ler
 * `Data: 2026-07-12` como resumo, ou a marcar uma issue bloqueada como livre.
 *
 * Onde o comportamento atual parece estranho, o teste o documenta como estranho.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseDoc,
  normalizeStatus,
  parseBlockedBy,
  isClosed,
  preambleEnd,
  relLinks,
} from '../shared/parse.js'

describe('parseDoc — os três dialetos de cabeçalho', () => {
  test('wayfinder: chaves antes do `# Título`', () => {
    const { header, title } = parseDoc(
      ['Status: ready-for-agent', 'Type: task', 'Repo: scratch-board', 'Blocked by: 01', '', '# Extrair o shared/parse.js', '', 'Prosa.'].join('\n'),
    )
    assert.equal(title, 'Extrair o shared/parse.js')
    assert.deepEqual(header, {
      status: 'ready-for-agent',
      type: 'task',
      repo: 'scratch-board',
      'blocked by': '01',
    })
  })

  test('issue tracker e restore-tui: chaves depois do `# Título`', () => {
    const { header, title } = parseDoc(
      ['# 01 — Porte do core para TypeScript (zero UI)', '', 'Status: ready-for-agent', 'Repo: restore-tui', '', 'Portar a lógica.'].join('\n'),
    )
    assert.equal(title, '01 — Porte do core para TypeScript (zero UI)')
    assert.deepEqual(header, { status: 'ready-for-agent', repo: 'restore-tui' })
  })

  test('map do wayfinder: `Label:` e `PRD:` são chaves reconhecidas', () => {
    const { header } = parseDoc(
      ['Label: wayfinder:map', 'Repo: scratch-board', 'PRD: .scratch/x/PRD.md', '', '# Mapa'].join('\n'),
    )
    assert.equal(header.label, 'wayfinder:map')
    assert.equal(header.prd, '.scratch/x/PRD.md')
  })

  test('prosa com dois-pontos não vira estado — só as chaves de HEADER_KEYS entram', () => {
    const { header } = parseDoc(['Status: claimed', 'Nota: isto não é um campo', 'Data: 2026-07-12', '', '# Título'].join('\n'))
    assert.deepEqual(header, { status: 'claimed' })
  })

  test('a fronteira do `## ` protege o estado: `Status:` no corpo não é lido', () => {
    const raw = [
      'Status: resolved',
      '',
      '# Título',
      '',
      '## Acceptance criteria',
      '',
      'Status: ready-for-agent',
    ].join('\n')
    assert.equal(parseDoc(raw).header.status, 'resolved')
  })

  test('o título é o primeiro `# ` do documento inteiro, não só do preâmbulo', () => {
    assert.equal(parseDoc(['## Seção', '', '# Título tardio'].join('\n')).title, 'Título tardio')
  })

  test('documento sem `# ` nenhum: título indefinido', () => {
    assert.equal(parseDoc('Status: claimed\n\ntexto solto').title, undefined)
  })

  test('a chave é case-insensitive e o valor é trimado', () => {
    assert.equal(parseDoc('STATUS:   claimed   \n\n# T').header.status, 'claimed')
  })

  test('chave conhecida com valor vazio entra como string vazia', () => {
    assert.deepEqual(parseDoc('Status:\n\n# T').header, { status: '' })
  })

  test('preambleEnd: sem `## `, o preâmbulo é o documento inteiro', () => {
    assert.equal(preambleEnd(['a', 'b', 'c']), 3)
    assert.equal(preambleEnd(['a', '## x', 'c']), 1)
  })
})

describe('parseBlockedBy — número e prosa, separados', () => {
  test('lista limpa vira dependências sem nota', () => {
    assert.deepEqual(parseBlockedBy('03, 04'), [
      { number: '03', note: '', raw: '03' },
      { number: '04', note: '', raw: '04' },
    ])
  })

  test('o caso real: só o número que ABRE o fragmento é referência; o resto é a justificativa', () => {
    const deps = parseBlockedBy(
      '01 (resolvido), 02 (done), 08 — a revisão 01 achou defeito crítico no decayOffline; a bancada deve testar o binário corrigido',
    )
    assert.deepEqual(
      deps.map((d) => d.number),
      ['01', '02', '08'],
    )
    assert.equal(deps[0].note, '(resolvido)')
    // O `01` DENTRO da prosa do fragmento 08 não vira dependência nova — ele fica na nota.
    assert.equal(
      deps[2].note,
      '— a revisão 01 achou defeito crítico no decayOffline; a bancada deve testar o binário corrigido',
    )
  })

  test('fragmento sem número que o abra NÃO vira dependência', () => {
    assert.deepEqual(parseBlockedBy('(nada — pode começar já)'), [])
  })

  test('número de um dígito é normalizado para dois — é assim que ele casa com o arquivo', () => {
    assert.equal(parseBlockedBy('1')[0].number, '01')
  })

  test('valor ausente ou vazio não bloqueia', () => {
    assert.deepEqual(parseBlockedBy(undefined), [])
    assert.deepEqual(parseBlockedBy(''), [])
  })

  test('`raw` guarda o fragmento inteiro, trimado', () => {
    assert.equal(parseBlockedBy('  05 (parcial)  ')[0].raw, '05 (parcial)')
  })
})

describe('normalizeStatus — vocabulário novo aparece, não some', () => {
  test('status conhecido passa; a caixa é normalizada', () => {
    assert.equal(normalizeStatus('ready-for-agent'), 'ready-for-agent')
    assert.equal(normalizeStatus('  RESOLVED '), 'resolved')
  })

  test('status ausente é needs-triage', () => {
    assert.equal(normalizeStatus(undefined), 'needs-triage')
    assert.equal(normalizeStatus(''), 'needs-triage')
  })

  test('status fora do vocabulário vira `?<status>` — deve aparecer, não sumir', () => {
    assert.equal(normalizeStatus('em-analise'), '?em-analise')
  })

  test('`open` é vocabulário do wayfinder, não desconhecido', () => {
    assert.equal(normalizeStatus('open'), 'open')
    assert.equal(normalizeStatus(' Open '), 'open')
  })
})

describe('isClosed', () => {
  test('wontfix fecha — é uma decisão, não um limbo', () => {
    assert.equal(isClosed('wontfix'), true)
    assert.equal(isClosed('resolved'), true)
    assert.equal(isClosed('done'), true)
    assert.equal(isClosed('claimed'), false)
    assert.equal(isClosed('open'), false)
    assert.equal(isClosed('ready-for-agent'), false)
  })
})

test('relLinks pega só links relativos, dedup, em ordem', () => {
  const raw = 'ver [a](../a.md) e [b](./b.md), [ext](https://x.com), [anc](#top), [abs](/c.md), [a2](../a.md)'
  assert.deepEqual(relLinks(raw), ['../a.md', './b.md'])
})
