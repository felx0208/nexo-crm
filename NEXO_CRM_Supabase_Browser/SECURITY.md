# Segurança — NEXO CRM Supabase

- Nunca publique `secret`/`service_role` keys.
- A publishable key é usada no navegador, mas somente com RLS e grants restritivos.
- Não habilite cadastro público para um projeto CRM de uma empresa.
- Este MVP assume um projeto Supabase separado por empresa.
- Não use dados reais sensíveis até concluir teste funcional, autorização, backups e restauração.
- Para comercialização, revise LGPD, contratos, suporte e plano de continuidade.
