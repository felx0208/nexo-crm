create table public.crm_help_requests (
 id bigint generated always as identity primary key,
 requester_id bigint not null default public.current_app_user_id() references public.users(id) on delete restrict,
 category text not null check(category in ('duvida','problema','sugestao','outro')),
 subject text not null check(char_length(btrim(subject)) between 3 and 120),
 message text not null check(char_length(btrim(message)) between 10 and 4000),
 status text not null default 'new' check(status in ('new','read','resolved')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index crm_help_requests_status_created_idx on public.crm_help_requests(status,created_at desc);
alter table public.crm_help_requests enable row level security;
revoke all on public.crm_help_requests from public,anon,authenticated;
grant select on public.crm_help_requests to authenticated;
grant insert(category,subject,message) on public.crm_help_requests to authenticated;
grant update(status,updated_at) on public.crm_help_requests to authenticated;
grant usage,select on sequence public.crm_help_requests_id_seq to authenticated;
create policy crm_help_submit_own on public.crm_help_requests for insert to authenticated with check(requester_id=(select public.current_app_user_id()) and status='new');
create policy crm_help_admin_read on public.crm_help_requests for select to authenticated using ((select public.current_app_role())='admin');
create policy crm_help_admin_update on public.crm_help_requests for update to authenticated using ((select public.current_app_role())='admin') with check ((select public.current_app_role())='admin');