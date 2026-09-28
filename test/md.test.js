/**
 * Caracterização do `renderMarkdown` — o segundo lado da duplicação.
 *
 * O renderer é puro (`string → string`) e não toca no DOM, então roda no Node sem
 * harness nenhum. O que estes testes travam não é a estética do HTML: são as duas
 * armadilhas que o `AGENTS.md` documenta como já pagas — a ordem das transformações e
 * o `Blocked by:` que não pode engolir a prosa —, mais a lista fechada de chaves e o
 * regex conservador de caminho, que são as mesmas regras do parser do servidor.
 *
 * As asserções olham para o que importa (um atributo, um chip, uma ausência), não para
 * o HTML inteiro: um `<div>` a mais não deve quebrar a rede.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { renderMarkdown } from '../public/md.js'

describe('a ordem das transformações — a armadilha que já foi paga', () => {
  test('o regex de caminho NÃO invade o href que o regex de link acabou de escrever', () => {
    const html = renderMarkdown('[o PRD](.scratch/x/PRD.md) tem o detalhe')

    // O destino sai inteiro e limpo no atributo. Se a ordem quebrar, o regex de caminho
    // encontra `.scratch/x/PRD.md` dentro do `data-open` e enfia um `<button>` ali —
    // HTML quebrado, e o link morre sem erro nenhum.
    assert.ok(html.includes('data-open=".scratch/x/PRD.md"'))
    assert.ok(!/data-open="[^"]*<button/.test(html), 'um <button> vazou para dentro do atributo')
    assert.ok(!/<button[^>]*>[^<]*<button/.test(html), 'botão dentro de botão — HTML inválido')
  })

  test('o rótulo do link não vira chip: dentro de um link, o link já é a ação', () => {
    const html = renderMarkdown('[.scratch/x/PRD.md](.scratch/x/PRD.md)')
    assert.equal(html.match(/class="ref"/g), null)
    assert.equal(html.match(/<button/g).length, 1)
  })

  test('um `*` dentro de código não vira itálico', () => {
    const html = renderMarkdown('use `a * b` aqui')
    assert.ok(html.includes('<code>a * b</code>'))
    assert.ok(!html.includes('<em>'))
  })

  test('link http vira âncora externa, não navegação da gaveta', () => {
    const html = renderMarkdown('[docs](https://ex.com/docs/a.md)')
    assert.ok(html.includes('<a href="https://ex.com/docs/a.md" target="_blank" rel="noreferrer">docs</a>'))
    assert.ok(!html.includes('data-open'))
  })
})

describe('`Blocked by:` — o número vira link, a prosa continua legível', () => {
  const html = renderMarkdown(
    ['Blocked by: 01 (resolvido), 08 — a revisão 01 achou defeito no decayOffline', '', '# T'].join('\n'),
  )

  test('cada fragmento rende um chip de issue pelo número que o abre', () => {
    assert.ok(html.includes('data-issue="01"'))
    assert.ok(html.includes('data-issue="08"'))
  })

  test('a justificativa NÃO é engolida pelo chip — ela é o que se lê antes de furar a fila', () => {
    assert.ok(html.includes('<span class="meta-note">(resolvido)</span>'))
    assert.ok(html.includes('a revisão 01 achou defeito no decayOffline'))
  })

  test('o número no MEIO da prosa não vira link: só o que abre o fragmento', () => {
    // Dois fragmentos, dois chips — o `01` dentro da nota do 08 não conta.
    assert.equal(html.match(/class="issueref"/g).length, 2)
  })

  test('harness POS: `Bloqueada por:` rende o mesmo chip, com a chave como o autor a escreveu', () => {
    const pt = renderMarkdown('Status: aberta\nBloqueada por: 01\n\n# T')
    assert.ok(pt.includes('data-issue="01"'))
    assert.ok(pt.includes('<span class="meta-k">bloqueada por</span>'))
  })

  test('fragmento sem número que o abra vira nota, não link', () => {
    const nada = renderMarkdown('Blocked by: (nada — pode começar já)\n\n# T')
    assert.ok(!nada.includes('issueref'))
    assert.ok(nada.includes('pode começar já'))
  })
})

describe('o cabeçalho vira metadado, não prosa', () => {
  test('os três dialetos rendem o mesmo bloco: chave antes ou depois do `# Título`', () => {
    const antes = renderMarkdown('Status: claimed\nType: task\n\n# T\n')
    const depois = renderMarkdown('# T\n\nStatus: claimed\nType: task\n')
    assert.ok(antes.includes('<span class="chip" data-s="claimed">claimed</span>'))
    assert.ok(depois.includes('<span class="chip" data-s="claimed">claimed</span>'))
    assert.ok(antes.includes('<h1>T</h1>') && depois.includes('<h1>T</h1>'))
  })

  test('o status é chip; as outras chaves são inline', () => {
    const html = renderMarkdown('Status: resolved\nRepo: scratch-board\n\n# T')
    assert.ok(html.includes('<span class="chip" data-s="resolved">resolved</span>'))
    assert.ok(html.includes('<span class="meta-k">repo</span>'))
  })

  test('chave desconhecida no preâmbulo continua prosa — não vira metadado', () => {
    const html = renderMarkdown('Data: 2026-07-12\n\n# T\n\nProsa.')
    assert.ok(!html.includes('meta-k'))
    assert.ok(html.includes('Data: 2026-07-12'))
  })

  test('`Status:` depois de um `## ` não é cabeçalho — a fronteira do `## ` vale aqui também', () => {
    const html = renderMarkdown('# T\n\n## Acceptance criteria\n\nStatus: ready-for-agent')
    assert.ok(!html.includes('class="chip"'))
  })
})

describe('comentário HTML some antes de qualquer outra transformação', () => {
  test('o comentário dos templates de skill não vira prosa escapada', () => {
    const html = renderMarkdown('# T\n\n<!-- uma linha por ticket fechado -->\n\nProsa.')
    assert.ok(!html.includes('&lt;!--'))
    assert.ok(!html.includes('uma linha por ticket'))
    assert.ok(html.includes('<p>Prosa.</p>'))
  })

  test('comentário de várias linhas também some inteiro', () => {
    const html = renderMarkdown('## S\n\n<!--\nfog\nde guerra\n-->\n\nProsa.')
    assert.ok(!html.includes('fog'))
    assert.ok(html.includes('<p>Prosa.</p>'))
  })
})

describe('caminho de arquivo — conservador de propósito', () => {
  test('caminho em crase vira chip copiável: é a forma mais comum de citar arquivo', () => {
    const html = renderMarkdown('O `public/md.js` é o renderer.')
    assert.ok(html.includes('<button type="button" class="ref" data-ref="public/md.js"'))
  })

  test('caminho na prosa, sem crase, também vira chip', () => {
    assert.ok(renderMarkdown('veja .scratch/x/map.md hoje').includes('data-ref=".scratch/x/map.md"'))
  })

  test('arquivo SEM diretório não é caminho — vira código, não chip', () => {
    const html = renderMarkdown('O `server.js` manda.')
    assert.ok(html.includes('<code>server.js</code>'))
    assert.ok(!html.includes('class="ref"'))
  })

  test('`e/ou` não vira botão de copiar — o regex frouxo é o que se evita aqui', () => {
    const html = renderMarkdown('a decisão é e/ou, não ambas')
    assert.ok(!html.includes('<button'))
  })
})

describe('os blocos do dialeto', () => {
  test('HTML é escapado — o `.md` não injeta marcação', () => {
    assert.ok(renderMarkdown('a < b & c > d').includes('a &lt; b &amp; c &gt; d'))
  })

  test('bloco de código preserva o conteúdo escapado e a linguagem', () => {
    const html = renderMarkdown('```js\nconst a = 1 < 2\n```')
    assert.ok(html.includes('<pre data-lang="js"><code>const a = 1 &lt; 2</code></pre>'))
  })

  test('checkbox vira `data-task`', () => {
    const html = renderMarkdown('- [ ] aberto\n- [x] feito')
    assert.ok(html.includes('data-task="open"'))
    assert.ok(html.includes('data-task="done"'))
  })

  test('item indentado é `nested`', () => {
    assert.ok(renderMarkdown('- pai\n  - filho').includes('<li class="nested">filho</li>'))
  })

  test('tabela só é tabela se a linha seguinte for o separador', () => {
    assert.ok(renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |').includes('<table>'))
    // Uma linha solta com `|` é prosa, e prosa não vira cabeçalho de tabela.
    assert.ok(renderMarkdown('prosa | com pipe').includes('<p>prosa | com pipe</p>'))
  })

  test('citação vira blockquote; `---` vira `<hr />`', () => {
    assert.ok(renderMarkdown('> citado').includes('<blockquote>citado</blockquote>'))
    assert.ok(renderMarkdown('a\n\n---\n\nb').includes('<hr />'))
  })

  test('CRLF não deixa resíduo', () => {
    assert.ok(!renderMarkdown('# T\r\n\r\nProsa.\r\n').includes('\r'))
  })
})
