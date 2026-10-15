# Guia sem instalar nada: GitHub + Supabase pelo navegador

## Parte A — Criar o banco online
1. Acesse https://supabase.com/ e entre/crie uma conta.
2. Clique em **New project**.
3. Escolha a organização, nomeie `nexo-crm`, defina uma senha forte para o banco e região.
4. Espere até o projeto ficar pronto.
5. No menu lateral, abra **SQL Editor** → **New query**.
6. Abra o arquivo `supabase/schema.sql` deste pacote com o Bloco de Notas, copie tudo, cole no SQL Editor e clique **Run**.
7. Verifique se aparece sucesso. Isso cria tabelas e políticas de segurança; não cria clientes fictícios.

## Parte B — Criar o administrador
1. No Supabase, abra **Authentication** → **Users** → **Add user**.
2. Digite seu e-mail e uma senha forte e confirme a criação do usuário (se houver a opção de confirmar e-mail, confirme para uso de teste).
3. O SQL cria o perfil no banco automaticamente. O primeiro perfil receberá a função `admin`.
4. Vá a **Authentication** → configurações de Sign In/Providers e desative o cadastro público. O texto exato do controle pode variar conforme a interface. Não publique com cadastro aberto.

## Parte C — Configurar a chave pública no código
1. No painel Supabase, abra **Project Settings** ou **Connect** e copie:
   - Project URL (ex.: `https://xxxxxxxx.supabase.co`)
   - Publishable key (ex.: `sb_publishable_...`)
2. Abra `supabase-config.js` no Bloco de Notas ou no editor do GitHub (sem instalar programa).
3. Substitua:
   - `https://SEU_PROJECT_ID.supabase.co` pela Project URL real
   - `SUA_CHAVE_PUBLISHABLE` pela publishable key real
4. Salve. **Nunca use `sb_secret_...` ou `service_role` no navegador.**

## Parte D — Colocar os arquivos no GitHub, só pelo site
1. Acesse https://github.com/ e entre na conta.
2. Clique no `+` no alto à direita → **New repository**.
3. Nome: `nexo-crm-supabase`.
4. Marque **Private** enquanto o projeto está em desenvolvimento; clique **Create repository**.
5. No repositório vazio: **Add file** → **Upload files**.
6. No computador, extraia o ZIP. Abra a pasta `NEXO_CRM_Supabase_Browser` e arraste os arquivos e pastas para a página do GitHub. O site permite carregar múltiplos arquivos pelo navegador; não suba apenas o ZIP como arquivo, pois o GitHub não o extrai em estrutura de código.
7. Espere o envio terminar. Em “Commit changes”, escreva `Primeira versão Supabase` e confirme.
8. Se a pasta tiver de ser enviada em partes, envie no máximo 100 arquivos por lote. Não envie nenhum `.env`, senha de banco, chave `secret` ou `service_role`.

## Parte E — Ver a aplicação sem instalar mais nada
Como o Laragon já está instalado no seu computador:
1. Faça uma cópia da pasta dos arquivos desta edição em `C:\laragon\www\nexo-crm-supabase`.
2. No Laragon, clique **Reload** (não precisa criar banco MySQL para essa edição).
3. Abra `http://nexo-crm-supabase.test`.
4. Faça login com a conta criada em Supabase Authentication.

## O que é e não é publicado
- O repositório GitHub privado guarda o código e o histórico de mudanças.
- Nesta primeira etapa, o CRM roda no seu computador pelo Laragon; o Supabase é o serviço online de autenticação e banco.
- O endereço `.test` só funciona no seu computador. Para entrar pelo celular ou compartilhar com clientes, será preciso publicar o front-end em um host HTTPS. GitHub Pages gratuito exige repositório público, o que não é recomendado para código comercial ainda em desenvolvimento. Se desejar publicar mantendo o repositório privado, podemos configurar hospedagem estática com uma opção que permita conectar repositório privado.
