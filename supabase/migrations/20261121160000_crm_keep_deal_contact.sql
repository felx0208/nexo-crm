create or replace function public.nexo_keep_deal_contact()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.contact_id is distinct from old.contact_id then
   raise exception 'O contato vinculado ao lead não pode ser alterado. Arquive o lead e crie outro com o contato correto.' using errcode='23514';
 end if;
 return new;
end; $$;
drop trigger if exists nexo_keep_deal_contact on public.deals;
create trigger nexo_keep_deal_contact before update of contact_id on public.deals for each row execute function public.nexo_keep_deal_contact();
