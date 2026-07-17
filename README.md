# SOLOCONTROL 360

Sistema integrado de gestão de massa asfáltica: **Usina → Transporte → Pista → Laboratório → Coordenação**.

- 3 papéis com login próprio: **técnico de usina**, **técnico de obra** e **coordenador geral**
- Boletim de descarga aberto automaticamente na obra quando a usina lança a carga
- Módulo de ensaios da usina: **teor de ligante (Rotarex)** e **granulometria** com projeto de mistura, tolerâncias, conformidade por eixo e relatório diário da usina
- Fechamento do dia na obra: retorno de caminhões, ensaios de pista (GC ≥ 97%), amostras p/ laboratório
- Relatório diário consolidado + resumo geral da obra (início → conclusão)
- **Offline-first**: tudo salva no aparelho na hora e sincroniza sozinho com a nuvem; fotos entram numa fila de reenvio automático

## Stack

Vite + React 18 + Firebase (Auth, Firestore com cache offline persistente, Storage) + Vercel (PWA instalável).

## Implantação (passo a passo)

### 1. Criar o projeto Firebase
1. Acesse https://console.firebase.google.com → **Adicionar projeto** (ex.: `solocontrol-360`).
2. **Authentication** → Métodos de login → ative **E-mail/senha**.
3. **Firestore Database** → Criar banco → região `southamerica-east1` → modo produção.
4. **Storage** → Começar (mesma região).
5. Configurações do projeto → **Seus apps** → ícone `</>` (Web) → registre o app e copie o `firebaseConfig`.

### 2. Colar a configuração
Abra `src/firebase.js` e substitua os valores `COLE_AQUI` pelo `firebaseConfig` copiado.

### 3. Publicar as regras de segurança
- Firestore → Regras → cole o conteúdo de `firestore.rules` → Publicar.
- Storage → Regras → cole o conteúdo de `storage.rules` → Publicar.

### 4. Rodar local (teste)
```bash
npm install
npm run dev
```

### 5. Deploy na Vercel
1. Suba o projeto para um repositório GitHub (ex.: `solocontrol-360`).
2. Na Vercel: **Add New → Project** → importe o repositório (framework: Vite, sem variáveis extras).
3. Deploy. Pronto — instale como app pelo navegador do celular (Adicionar à tela inicial).

### 6. Primeiro acesso
1. Na tela de login, toque em **"Primeiro acesso? Configurar coordenador"**.
2. Preencha nome, e-mail, senha e o código de configuração: **`SOLO360`** (altere a constante `CODIGO_SETUP` em `src/App.jsx` depois da implantação, por segurança).
3. Logado como coordenador: cadastre as **obras**, depois crie os acessos da **equipe** (cada funcionário recebe e-mail + senha).

## Fluxo operacional

1. **Usina** lança a carga (placa, NF, tonelagem, temperatura 150–177 °C, fotos) → boletim abre em tempo real na obra.
2. **Obra** registra chegada (hora, temperatura, fotos georreferenciadas), inicia e finaliza a descarga (temp. aplicação ≥ 120 °C, trecho, espessura no gabarito).
3. **Usina** executa os ensaios da jornada (teor de ligante e granulometria) vinculados ao lote/intervalo de cargas, conforme a frequência configurada na obra.
4. **Obra** fecha o dia: retorno de caminhões, ensaios de pista, amostras p/ laboratório, fotos.
5. **Coordenador** acompanha tudo ao vivo no painel, gera o relatório diário consolidado e, ao final, **conclui a obra** gerando o resumo geral.

## Garantias de dados (não perder nada)

- Firestore com **persistência offline multi-aba**: cada campo digitado grava no aparelho imediatamente e sobe pra nuvem quando houver sinal.
- Fotos: comprimidas + marca d'água (data/hora, UTM, obra); se o upload falhar, entram na **fila local de reenvio** (`localStorage`) processada automaticamente a cada 25 s e ao voltar a conexão.
- Rascunho local do formulário de nova carga (sobrevive a fechar o app).
- Todo registro carrega **assinatura de auditoria** (quem, quando).
- Recomendado: ativar backup diário do Firestore (agendado via GitHub Actions, mesmo padrão já usado no app da tesouraria do Lions).

## Migração do app atual

O aplicativo atual (solocontrol-app.vercel.app) **continua rodando intocado**. Veja `docs/plano-migracao.md` para o roteiro de homologação, operação paralela e migração definitiva.
