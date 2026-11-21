create table if not exists public.crm_user_preferences (
 user_id bigint primary key references public.users(id) on delete cascade,
 theme_mode text not null default 'dark' check(theme_mode in ('dark','light')),
 accent_color text not null default '#052D60' check(accent_color ~ '^#[0-9A-Fa-f]{6}$'),
 view_scale smallint not null default 80 check(view_scale in (80,90,100,110)),
 updated_at timestamptz not null default now()
);
alter table public.crm_user_preferences enable row level security;
revoke all on public.crm_user_preferences from public, anon, authenticated;
grant select, insert, update on public.crm_user_preferences to authenticated;
create policy crm_pref_select_own on public.crm_user_preferences for select to authenticated using (user_id=(select public.current_app_user_id()));
create policy crm_pref_insert_own on public.crm_user_preferences for insert to authenticated with check (user_id=(select public.current_app_user_id()));
create policy crm_pref_update_own on public.crm_user_preferences for update to authenticated using (user_id=(select public.current_app_user_id())) with check (user_id=(select public.current_app_user_id()));
insert into public.crm_user_preferences (user_id,theme_mode,accent_color)
select u.id, case when c.theme_mode='light' then 'light' else 'dark' end,case when c.accent_color ~ '^#[0-9A-Fa-f]{6}$' then c.accent_color else '#052D60' end
from public.users u cross join public.company_settings c where u.role='admin' and u.is_active and c.id=1
on conflict (user_id) do nothing;
