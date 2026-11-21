-- CIRANDAÊ CRM 1.7: melhorias aplicadas ao projeto Supabase.
CREATE OR REPLACE FUNCTION public.import_crm_leads(p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
 r jsonb; results jsonb := '[]'::jsonb; pid bigint; sid bigint; cid bigint; did bigint; uid bigint;
 leadname text; contactname text; company text; stage_text text; owner_text text; amount numeric;
 email_text text; phone_text text; hist text; hist_date text; desc_text text; stage_won boolean; stage_lost boolean; actor bigint;
begin
 actor:=public.current_app_user_id();
 if actor is null then raise exception 'Acesso não autorizado'; end if;
 if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows)>500 then raise exception 'Envie até 500 leads por arquivo'; end if;
 select id into pid from public.pipelines where is_active order by is_default desc,id limit 1;
 if pid is null then raise exception 'Nenhum funil disponível'; end if;
 perform pg_advisory_xact_lock(718202611);
 for r in select value from jsonb_array_elements(p_rows) loop
  begin
   leadname:=btrim(coalesce(r->>'lead','')); company:=coalesce(nullif(btrim(r->>'company'),''),leadname);
   contactname:=coalesce(nullif(btrim(r->>'contact'),''),company);
   email_text:=nullif(btrim(r->>'email'),''); phone_text:=nullif(btrim(r->>'phone'),'');
   stage_text:=coalesce(nullif(btrim(r->>'stage'),''),'Prospecção'); owner_text:=nullif(btrim(r->>'owner'),'');
   desc_text:=nullif(btrim(r->>'description'),''); hist:=nullif(btrim(r->>'history'),''); hist_date:=nullif(btrim(r->>'history_date'),'');
   if length(leadname)=0 or length(leadname)>190 then raise exception 'Nome do lead obrigatório (até 190 caracteres)'; end if;
   if length(contactname)>190 or length(company)>190 or length(coalesce(phone_text,''))>100 or length(coalesce(email_text,''))>190 or length(coalesce(desc_text,''))>20000 or length(coalesce(hist,''))>20000 then raise exception 'Campo excede o tamanho permitido'; end if;
   if email_text is not null and email_text !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'E-mail inválido'; end if;
   select id,is_won,is_lost into sid,stage_won,stage_lost from public.pipeline_stages where pipeline_id=pid and lower(btrim(name))=lower(stage_text) limit 1;
   if sid is null then raise exception 'Etapa não encontrada: %',stage_text; end if;
   uid:=null;
   if owner_text is not null then
     select id into uid from public.users where is_active and role<>'admin' and lower(btrim(name))=lower(owner_text) limit 1;
     if uid is null then raise exception 'Responsável não encontrado: %',owner_text; end if;
   end if;
   amount:=nullif(r->>'value','')::numeric;
   if amount is not null and (amount<0 or amount>9999999999.99) then raise exception 'Valor inválido'; end if;
   if (stage_won or lower(stage_text) in ('negociação','fechado')) and coalesce(amount,0)<=0 then raise exception 'Informe valor positivo em Negociação ou Fechado'; end if;
   if hist_date is not null and (hist_date !~ '^\d{4}-\d{2}-\d{2}$' or hist_date::date>current_date) then raise exception 'Data do histórico inválida ou futura'; end if;
   if exists(select 1 from public.deals where pipeline_id=pid and deleted_at is null and lower(btrim(title))=lower(leadname)) then
     results:=results||jsonb_build_array(jsonb_build_object('row',r->'row','lead',leadname,'status','duplicate','message','Lead já existente')); continue;
   end if;
   cid:=null;
   select id into cid from public.contacts where deleted_at is null and lower(btrim(coalesce(company_name,'')))=lower(company) and lower(btrim(name))=lower(contactname) order by id limit 1;
   if cid is null then
     insert into public.contacts(name,company_name,email,phone,source,status,owner_id,notes)
     values(contactname,company,email_text,phone_text,coalesce(nullif(btrim(r->>'source'),''),'Importação de planilha'),'lead',uid,desc_text) returning id into cid;
   end if;
   insert into public.deals(contact_id,pipeline_id,stage_id,title,description,value,owner_id,closed_at)
   values(cid,pid,sid,leadname,desc_text,coalesce(amount,0),uid,case when stage_won or stage_lost then now() else null end) returning id into did;
   if hist is not null then
     insert into public.activities(contact_id,deal_id,user_id,title,body,type,metadata)
     values(cid,did,actor,'Histórico importado',hist,'note',jsonb_build_object('event_date',coalesce(hist_date,current_date::text),'source','planilha'));
   end if;
   results:=results||jsonb_build_array(jsonb_build_object('row',r->'row','lead',leadname,'status','created','id',did));
  exception when others then
   results:=results||jsonb_build_array(jsonb_build_object('row',r->'row','lead',leadname,'status','error','message',sqlerrm));
  end;
 end loop;
 return results;
end; $function$;

revoke execute on function public.import_crm_leads(jsonb) from public,anon;
grant execute on function public.import_crm_leads(jsonb) to authenticated;

CREATE OR REPLACE FUNCTION public.nexo_update_contact_touch_from_activity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare target_contact_id bigint; touch_at timestamptz; event_day date; raw_day text;
begin
 if lower(coalesce(new.type,'')) not in ('call','meeting','email') then return new; end if;
 target_contact_id:=new.contact_id;
 if target_contact_id is null and new.deal_id is not null then
   select d.contact_id into target_contact_id from public.deals d where d.id=new.deal_id;
 end if;
 touch_at:=coalesce(new.created_at,now());
 raw_day:=nullif(btrim(new.metadata->>'event_date'),'');
 if raw_day is not null then
   if raw_day !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Data da ocorrência inválida'; end if;
   event_day:=raw_day::date;
   if event_day>(now() at time zone 'America/Sao_Paulo')::date then raise exception 'A data da ocorrência não pode estar no futuro'; end if;
   touch_at:=least(touch_at,(event_day::timestamp at time zone 'America/Sao_Paulo'));
 end if;
 if target_contact_id is not null then
   update public.contacts set last_contact_at=greatest(coalesce(last_contact_at,'-infinity'::timestamptz),touch_at) where id=target_contact_id;
 end if;
 return new;
end; $function$;
