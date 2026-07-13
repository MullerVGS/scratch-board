# scratch-board

Board de leitura para um diretório `.scratch/` — os esforços em curso, os documentos de cada um, e o comando que destrava o próximo passo.

Um esforço é uma pasta com um `PRD.md`, um `map.md` e issues numeradas. O board varre tudo, mostra em que estado cada coisa está, e deixa você ler o documento sem sair da página.

- **Esforços** com título e resumo, para lembrar do que se trata sem abrir o arquivo.
- **Issues** com status, bloqueios e o `Blocked by:` como link para a issue bloqueante.
- **Grafo de dependências** por esforço: as setas do `Blocked by:` com a profundidade no eixo X, em vez do tempo que o `.scratch/` não tem. A primeira coluna é a frontier; o que já fechou fica esmaecido, mostrando o que soltou o resto.
- **Gaveta** que renderiza o markdown, navega pelos links relativos entre documentos e volta pela trilha — e que é **viva**: quando o agente escreve o arquivo que você está lendo, o conteúdo troca sozinho, preservando a rolagem.
- **Comando por estado**: cada esforço e cada issue mostram, pronto para copiar, o comando que os move — e o que está bloqueado não mostra nenhum.

Esse último ponto é o encaixe com o [mattpocock/skills](https://github.com/mattpocock/skills): `wayfinder`, `to-tickets`, `triage`, `implement`. O board conhece o vocabulário delas e monta a invocação com os caminhos certos; quem decide rodar é você.

## Os `.md` são a fonte da verdade

Não há banco nem índice, e o board **não escreve** — nem um byte. Quem muda status é você, ou a skill que resolveu o ticket, no arquivo. O `.scratch/` sobe montado read-only para que isso seja uma garantia, não uma promessa.

E o board não pergunta ao disco: ele **é avisado**. Um `fs.watch` vê o arquivo tocar o disco, o servidor remonta a projeção e empurra por SSE — mas **só se ela mudou de verdade**. Nada de polling, nada de refresh, nada de piscar a tela para redesenhar o mesmo pixel. Existe cache, e ele é *derivado*: nenhuma rota o serve sem reler o disco. Um push pode falhar em silêncio, então há rede: uma varredura de segurança, um indicador de conexão que admite quando não sabe, e um botão de reler.

O que ele mecaniza é o que é determinístico: ler o estado, resumir o documento, compor o comando. O julgamento fica de fora.
