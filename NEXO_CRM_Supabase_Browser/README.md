# NEXO CRM — edição Supabase (sem instalação de ferramentas)

Esta variante usa HTML/CSS/JavaScript no navegador, Supabase Auth para login e PostgreSQL com Row Level Security (RLS). O PHP/MySQL não é necessário nesta edição.

> **Arquitetura diferente:** esta versão usa Supabase Cloud. Os dados ficam no projeto Supabase, não no servidor local do cliente. Isso facilita começar sem instalar ferramentas, mas cria dependência da hospedagem Supabase. Para o produto final auto-hospedado em servidor próprio/Docker, a arquitetura deverá ser tratada separadamente.

## Arquivos principais
- `index.html`: layout do NEXO CRM.
- `integration.js`: integração das telas com Supabase Auth/Postgres.
- `supabase-config.js`: somente Project URL e publishable key.
- `supabase/schema.sql`: tabelas, trigger de perfil, grants e políticas RLS.
- `.gitignore`: exclui arquivos de segredo e configurações locais.

## Configuração pelo navegador
1. Crie um projeto no Supabase Dashboard.
2. Abra SQL Editor e execute todo o conteúdo de `supabase/schema.sql`.
3. Em Authentication → Sign In / Providers, desative novos cadastros públicos (Disable signups / Allow new users sign up, conforme a interface). Faça isso antes de publicar o app.
4. Em Authentication → Users, clique em Add user e crie o usuário administrador inicial. O trigger SQL cria o perfil automaticamente; o primeiro vira `admin`, os próximos criados pelo administrador no Dashboard viram `sales`.
5. Em Project Settings / Connect, copie a Project URL e a publishable key (começa com `sb_publishable_` nos projetos que usam as novas chaves).
6. Edite `supabase-config.js` e troque os dois valores de exemplo. Nunca use a chave `secret` ou `service_role` no navegador.
7. Abra os arquivos pelo servidor já instalado (por exemplo, colocando a pasta dentro do `C:\laragon\www` e usando o endereço local do Laragon) e entre com o e-mail e senha do usuário criado no Dashboard.

## Importante sobre usuários
- Não use cadastro público aberto para um CRM de empresa. Se qualquer pessoa puder criar conta no mesmo projeto, todos os usuários autenticados deste modelo compartilharão os dados daquele projeto.
- Este MVP presume um projeto Supabase separado por empresa/cliente. Não use o mesmo projeto para empresas clientes independentes.
- Para adicionar um membro: Authentication → Users → Add user. O perfil será criado pelo trigger. Não coloque `secret`/`service_role` no HTML.
- O primeiro perfil criado é administrador e os seguintes são vendedores. Promoção a gerente deve ser feita por administrador autorizado após avaliar o procedimento; a interface de gestão de perfis é parcial.
- A desativação no perfil bloqueia o acesso via RLS; o token de sessão pode continuar existindo até a sessão expirar/ser encerrada.

## Banco existente / migração
Esta edição não se conecta ao MySQL/Laragon atual. Ela usa um banco PostgreSQL do Supabase separado. Se há contatos importantes no MySQL, exporte-os em CSV e importe depois de testar o mapeamento. Não exclua o banco anterior.

## Segurança
O banco habilita RLS nas tabelas expostas e não concede acesso a `anon`. A chave `publishable` é feita para estar no navegador, mas segurança depende das políticas no banco. Não envie chaves `secret` ou `service_role` para GitHub. O SQL precisa ser executado integralmente antes do login. Antes de uso comercial, faça testes de isolamento, restauração e permissões por perfil.
