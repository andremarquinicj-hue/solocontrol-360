# Plano de migração — Solocontrol Controle Tecnológico → Solocontrol 360

Premissa inegociável: **o aplicativo atual (solocontrol-app.vercel.app) não é alterado nem interrompido** até a validação completa do novo módulo da usina. O Solocontrol 360 roda em projeto Firebase próprio e URL própria.

## 1. Inventário do aplicativo atual

| Bloco | Campos / registros | Correspondência no Solocontrol 360 |
|---|---|---|
| Jornada | obra (texto), usina, data, técnico | Obra cadastrada pelo coordenador (`obras`), usina em texto livre, `dataRef`, técnico via login (`usuarios`) |
| Cargas | placa, NF, tonelagem, temp. saída (150–177 °C), hora, fotos, status LIBERADA/RETIDA | `cargas` com os mesmos campos + status ampliado (em trânsito → na obra → descarregando → concluída / não conforme) |
| Teor de ligante | método (Rotarex/Ignição/Soxhlet), massas Mi/Ma/Mf, teor calculado, teor projeto, tolerância ±0,3%, situação | `ensaios` tipo `teor` — mesma fórmula ((Mi−Ma−Mf)/Mi×100), memória de cálculo exibida, histórico de correção |
| Granulometria | faixas A/B/C DNIT, peneiras 3/4"→nº200, massas retidas, passante, tolerâncias ±7/5/3/2%, situação por peneira | `ensaios` tipo `granulometria` — mesmas faixas/tolerâncias + fechamento de massa, alertas de digitação e curva no relatório |
| Fotos | comprimidas, carimbo (logo, data/hora, UTM, tag) | Mesmo pipeline + fila de reenvio offline e legenda por etapa do ensaio |
| Relatório diário | cabeçalho, resumo, tabela de cargas, ensaios, análise técnica, fotos, responsáveis | Relatório da usina ampliado (nº doc, situação por eixo, curva granulométrica, gráfico de temperatura, código de verificação, histórico de revisão) |
| Projeto de mistura | teor projeto + faixa informados no ensaio | Cadastro estruturado (`projetos`) com versão, status e trava para técnico após aprovação |

Novos no 360 (não existiam no atual): vínculo ensaio↔produção (carga/intervalo/lote), frequência de ensaios configurável por obra, equipamentos com patrimônio e validade de calibração, minuta de análise técnica aprovável, papéis obra/coordenador, relatório consolidado usina+pista e resumo geral da obra.

## 2. Roteiro de homologação

1. **Ambiente separado** — Firebase e Vercel próprios do 360 (feito por construção).
2. **Importação de cópia** — exportar 2–3 jornadas reais do app atual (dados digitados manualmente ou via export do Firestore) e recadastrar no 360.
3. **Comparação de resultados** — conferir, número a número: teor calculado, desvios, percentuais passantes, situações por peneira e por eixo. Critério: igualdade exata nos cálculos.
4. **Comparação dos PDFs** — imprimir o relatório do dia nos dois sistemas e conferir item a item da estrutura de 40 itens.
5. **Teste de cálculos-limite** — massas que não fecham, perda > 0,5%, teor no limite da tolerância, temperatura 149/150/177/178 °C.
6. **Teste com os técnicos** — 1 jornada acompanhada com o Júnior na usina e o técnico da pista usando os dois apps.
7. **Operação paralela** — mínimo 5 jornadas registrando nos dois sistemas; divergência = ajuste no 360, nunca no atual.
8. **Aprovação formal** — coordenador assina o relatório de homologação (checklist acima).
9. **Migração definitiva** — equipe passa a usar só o 360; o app atual permanece no ar como arquivo de consulta (somente leitura na prática).

## 3. Rollback

Se qualquer etapa falhar após a virada: a equipe volta a registrar no app atual no mesmo instante (ele nunca saiu do ar), e as jornadas feitas no 360 são reimpressas/arquivadas em PDF. Não há dependência técnica entre os dois bancos.

## 4. Backup contínuo (pós-migração)

- Export diário automático do Firestore via GitHub Actions (mesmo padrão do app da tesouraria do Lions, já validado).
- Fotos ficam no Firebase Storage com redundância do próprio Google Cloud.
- Relatórios importantes: salvar também o PDF impresso no Drive da empresa.
