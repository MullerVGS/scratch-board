# AGENTS.md — scratch-board

Board de leitura do `.scratch/` do workspace. Serve para enxergar os esforços em curso, lembrar do que cada um se trata, ler os documentos e sair com o comando que destrava o próximo passo.

## O princípio

**Os `.md` são a fonte da verdade. O board é uma projeção — e só isso.**

Não existe banco, cache nem índice: cada request relê o disco. E o board **não escreve**. Quem muda status é você ou a skill que resolve o ticket, no arquivo; o board mostra o resultado no refresh seguinte.

Houve um kanban com drag-and-drop que gravava `Status:` ao soltar o card. Saiu. Ele nasceu de uma palavra solta na especificação ("kanban"), não de uma necessidade — e ser a única superfície de escrita punha o board em contradição com a própria fronteira que ele defende (ver **Fronteira**, no fim). O `.scratch/` sobe montado **read-only**: a garantia agora é do mount, não da boa intenção.

Se for adicionar recurso, mantenha a propriedade: **nada de estado que não esteja nos `.md`, e nada de escrita.** A única exceção é a largura da gaveta (ver **Gaveta**), que é preferência de quem olha, não conteúdo.

## Rodar

```
docker compose up -d      # http://localhost:7777 (só loopback)
```

`server.js` e `public/` são montados como volume e não há build step — editar e `docker compose restart` basta.

## Stack

Node 22, **zero dependências** (só `node:http` e `node:fs`), frontend vanilla sem bundler. Não é minimalismo por esporte: sem `package.json` não há `npm install`, lockfile, nem árvore de dependência para manter numa ferramenta que existe para economizar seu tempo, não consumir.

## Os três dialetos de cabeçalho

O `.scratch/` acumulou três formatos, e o parser precisa dos três. As chaves `Chave: valor` podem vir **antes** do `# Título` (dialeto do wayfinder, com `Type:` e `Blocked by:`) ou **depois** dele (dialeto do issue tracker e do restore-tui).

Por isso `parseDoc()` varre o **preâmbulo inteiro** — do topo até a primeira seção `## ` — em vez de só o bloco inicial. E aceita apenas as chaves de `HEADER_KEYS`, para que uma frase em prosa com dois-pontos não vire estado por acidente. Há `Status:` em corpo de issue (dentro de `## Acceptance criteria`); a fronteira do `## ` é o que impede que sejam lidos.

A lista fechada de chaves protege o *parser*, mas atrapalha quem quer **resumir**: os documentos trazem `Data:`, `Labels:` e o que mais o autor inventar, e nenhuma dessas chaves está em `HEADER_KEYS`. Por isso `summarize()` não filtra por chave — começa **depois** do preâmbulo. Sem isso, `Data: 2026-07-12` vira o resumo de um PRD (aconteceu). A fronteira do `## ` não depende de adivinhar chave nenhuma: acima dela é metadado, abaixo é texto.

`Blocked by:` também não obedece ao formato que promete. Na prática existe `Blocked by: 01 (resolvido), 02 (done), 08 — a revisão achou defeito crítico…, senão o shadow emite lixo`. Só o número que **abre** cada fragmento separado por vírgula é referência; o resto é prosa, e prosa a ser lida — é a justificativa do bloqueio.

Isso vale no servidor e no renderer, e o servidor já errou aqui: ele guardava o fragmento inteiro e o procurava na lista de issues, o que nunca acha ninguém quando há prosa junto do número — a issue ficava silenciosamente **não bloqueada**. `parseBlockedBy()` agora quebra cada fragmento em `{ number, note }`: o número resolve a aresta, a nota é a justificativa que o hover do grafo devolve. Fragmento sem número que o abra (`(nada — pode começar já)`) não referencia issue nenhuma e não vira dependência.

## Dois vocabulários de caminho

Todo item da API carrega dois nomes para o mesmo arquivo: `path`, o caminho **dentro do container** (`/workspace/.scratch/...`), por onde o board lê; e `ref`, o caminho **como o workspace o vê** (`.scratch/...`), que é o único que faz sentido colar num agente.

O `ref` é derivado no servidor (`refOf`), não no cliente: quem sabe qual root montou o quê é o processo que resolveu os roots. `SCRATCH_REF` e `PADS_REF` ajustam o mapeamento se os volumes mudarem.

A regra prática: **o board lê por `path`; o humano copia `ref`.** Um comando com `/workspace/` dentro não leva a lugar nenhum.

## Do que se trata este esforço

`pos-2101-flapping-guard` não conta história nenhuma, e abrir o PRD para lembrar custa uma navegação. Cada esforço carrega, direto do `/api/board`, o **título** e o **primeiro parágrafo** (`summarize()`) do `map.md` — ou do `PRD.md`, quando não há mapa; o mapa manda porque é o documento que o wayfinder mantém vivo, enquanto o PRD congela na intenção original.

O card mostra o título abaixo do slug; o hover (ou o foco pelo teclado) abre o popup com o parágrafo. Esforço sem documento nenhum não tem resumo a dar — o popup lista os títulos das issues, que é o que existe. Em touch não há popup: sem hover, não há como mostrá-lo antes do toque, e o toque já entra no esforço.

## Copiar

Slug, título, caminho e comando são copiáveis com um clique. As regras de UI que o `copyBtn()` encapsula, e que qualquer alvo copiável novo deve herdar:

- **O botão fica sempre no DOM**, invisível por opacidade até o hover do container ou o foco. Escondê-lo com `display:none` o tiraria da ordem de tabulação — quem navega por teclado nunca chegaria nele. Em touch (`hover: none`) ele é sempre visível, porque não há hover para revelá-lo.
- **A confirmação é local**: o ícone vira ✓ verde por um instante. O toast do rodapé continua, mas com vários botões na tela ele não diz *qual* copiou; o ✓ diz.
- **Copiar não é navegar**: quase todo alvo mora dentro de algo clicável (card que navega, linha que abre a gaveta), então o clique do botão para no próprio botão (`stopPropagation`).
- **Copia-se o que se lê.** O comando aparece literal na tela e é ele que vai para a área de transferência. Nada de botão que copia algo que você não viu.

O título da issue é copiado **sem** o prefixo `NN — ` que o `.md` repete: o que se cola num prompt é o nome, não a numeração.

## Prompts de skill

Cada estado tem um comando que o destrava, e o board monta esse comando com os caminhos certos. Ele **não invoca skill nenhuma** — dispara quem lê.

| Estado | Comando |
| --- | --- |
| Esforço com `map.md` | `/wayfinder <ref>/map.md` |
| Esforço arquivável | `/scratch archive <slug>` |
| Só `PRD.md`, sem issues | `/to-tickets <ref>/PRD.md` |
| Esforço sem documento nenhum | `/wayfinder` (chartar o mapa) |
| Issue com `Type:` sob um mapa | `/wayfinder <ref>/map.md <issue-ref>` |
| Issue em `needs-triage`/`needs-info` | `/triage <issue-ref>` |
| Issue `ready-for-agent` | `/implement <issue-ref>` |
| Issue `ready-for-human` | `/grilling <issue-ref>` |

O wayfinder é o resolve-tudo: onde existe mapa, ele escolhe o ticket na frontier, reivindica e resolve — não há o que decidir no board, então ele vem primeiro e leva o destaque. Os outros comandos só aparecem onde o wayfinder não alcança.

Issue **bloqueada não recebe comando algum**. Oferecer o prompt seria convidar a furar a fila que o `Blocked by:` desenhou; o board mostra o bloqueio e cala a boca. Esforço arquivado também não: é leitura.

Se o vocabulário de skills mudar, o mapeamento vive inteiro em `effortPrompts()` e `issuePrompts()` (`public/app.js`) — um lugar só, e é onde ele deve continuar.

## A gaveta

Onde você lê o documento e decide o que fazer com ele. O `.md` chega **renderizado** (`public/md.js`); o que não é markdown — rascunho de agente, log, JSON — continua monoespaçado e literal.

`md.js` não é um renderer de propósito geral: é o dialeto que as skills escrevem, e é esse conhecimento que o faz valer mais que um `<pre>`.

- O **cabeçalho** vira bloco de metadados no topo, sempre na mesma ordem — o que normaliza a *exibição* dos três dialetos sem tocar no arquivo.
- **`Blocked by:`** vira link: clicar abre a issue bloqueante na própria gaveta.
- **Caminho de arquivo** vira alvo copiável (clicar copia; o texto na tela é o texto no clipboard).
- **Link relativo** (`[review-01.md](../review-01.md)`) — a forma como os documentos de um esforço se citam — vira navegação: abre o destino na gaveta. Uma **trilha** guarda o caminho de volta (`←` no topo, ou `Esc`); sem ela o link trocaria o contexto que você tinha por um que você não pediu.

Duas armadilhas do renderer, ambas já pagas:

- **Ordem das transformações.** Tudo que já virou HTML sai de cena como marcador e só volta no fim. Sem isso o regex de caminho encontra o `href` que o regex de link acabou de escrever e enfia um `<button>` dentro do atributo — HTML quebrado, e o link morre.
- **Especificidade.** As regras do corpo renderizado precisam do id (`#drawer-body.md`), não só da classe: `#drawer-body` vence `.md` e o documento inteiro sai monoespaçado, com os `\n` entre blocos virando linhas em branco.

A gaveta é **redimensionável** pela alça na borda esquerda (duplo clique volta ao padrão). A largura vive em `localStorage` — a única coisa que o board guarda fora dos `.md`, e não fere o princípio: a fonte da verdade é o *conteúdo*, e largura de painel não é conteúdo. Nenhum agente lê, nenhum arquivo depende, e perdê-la não perde nada. Em tela estreita a gaveta ocupa tudo e a alça some — não há o que arrastar.

## O grafo de dependências

A página de um esforço tem duas visões, e a escolhida vive no **hash** (`#/<slug>/grafo`) — não em `localStorage`: é onde já vive o resto da navegação, e assim o grafo de um esforço vira um link colável.

O grafo nasceu de querer as setas de um Gantt sem o Gantt. Um Gantt gasta o eixo X com tempo, e o `.scratch/` não tem data de início nem duração; inventá-las à mão em cada `.md` criaria um estado que ninguém mantém, e **data podre mente com mais confiança que a ausência dela**. Mas as setas não precisam de tempo: elas são as arestas do `Blocked by:`, e essas existem. Trocado o eixo por **profundidade**, a camada 0 passa a ser a frontier — o que dá para atacar agora — e cada coluna à direita é o que aquilo destrava. É a pergunta que o board já responde, agora desenhada.

Como ele se sustenta:

- **A camada é o maior caminho** até uma issue sem dependência, não o menor. Com o menor, um nó apareceria à esquerda de algo que ele espera e a seta andaria para trás.
- **Ciclo não estoura.** Não deveria existir num `Blocked by:`, mas se existir a aresta que fecha o laço é ignorada. O board mostra o que o arquivo diz, e um arquivo pode estar errado.
- **Dentro da camada, a ordem é o baricentro** das dependências: o nó fica na altura média de quem o bloqueia. É o que evita cruzamento gratuito de curvas.
- **A altura do nó é fixa** (`NODE_H`) porque entra no cálculo da posição das curvas. Título que estica desalinha as setas — daí o clamp de duas linhas.
- **Issue fechada continua no grafo**, esmaecida: é ela que explica o que soltou a frontier. Sem ela, uma issue destravada apareceria solta, sem história. A aresta já cumprida entra tracejada e verde; a que ainda segura alguém, sólida e vermelha.
- **A prosa do `Blocked by:` é o tooltip da aresta** — a justificativa do bloqueio é o que se lê antes de decidir furar a fila.
- **Os nós são HTML posicionado; o SVG só desenha as curvas.** Assim o chip de status, o foco por teclado e o clique que abre a gaveta são os mesmos da lista, sem reimplementar texto em SVG. Cuidado ao mexer: `el()` monta HTML, e um `<defs>`/`<marker>` criado por ele não estaria no namespace SVG — o navegador aceita e ignora, e as setas somem sem erro nenhum. Por isso o `svg()`.

O grafo não inventa nada: as referências do `Blocked by:` são locais ao esforço, então ele nunca cruza slugs, e um esforço sem nenhuma aresta vira uma coluna só — com uma nota dizendo isso, em vez de fingir um desenho.

## Scratchpads de sessão

`/tmp/claude-0/-root-projetos/<session-id>/scratchpad/` é onde os agentes largam arquivo temporário. O board monta isso em `/workspace/pads` **read-only** e serve em `#/pads`.

É um segundo root, não uma extensão do `.scratch`: `safePath()` prende qualquer caminho vindo do cliente a um dos dois. Rascunho de agente o board lê e não toca — como, aliás, ele não toca em nada.

Sessão sem nenhum arquivo é omitida — a maioria nunca escreve nada e listá-las afogaria as poucas com conteúdo. O diretório vive em `/tmp`: some no reboot do WSL, e o board não promete o contrário. Não construa nada que dependa dele persistir.

Artifacts do claude.ai ficaram **de fora** por não existirem em disco: são uma API remota que só o agente alcança. Não há o que montar.

## Vocabulário de status

Canônicos (`docs/agents/triage-labels.md`): `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
Do wayfinder: `claimed`, `resolved`. Vistos na prática: `done`, `partial`.

Um status fora dessa lista é exibido com `?` e em vermelho — vocabulário novo deve **aparecer**, não sumir num balde de "outros".

## Classificações do board

- **Arquivável** — tem issues e todas fecharam. Pronto para `/scratch archive`.
- **Parado** — nunca foi decomposto em issues (só PRD), ou tudo que existe está preso em triagem. Note que é sobre *movimento*, não progresso: um esforço com `ready-for-agent` está enfileirado, não parado, mesmo com zero issues fechadas.
- **Ativo** — o resto.

## Fronteira

O board mecaniza o que é determinístico: ler o estado, resumir o documento, **montar o comando**. O que exige julgamento — decidir que um ticket está resolvido, destilar o aprendizado de um esforço em memória antes de arquivá-lo, escolher como atacar uma issue — é das skills, e **muda os `.md`**. O board não muda `.md`.

É por isso que ele copia prompts em vez de disparar agentes, e é por isso que o drag-and-drop saiu. Compor `/wayfinder .scratch/x/map.md` é determinístico; decidir que agora é hora de rodá-lo, não. E marcar um ticket como `resolved` arrastando um card é dar o veredicto sem fazer o trabalho que o justifica.
