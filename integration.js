/* NEXO CRM - conexão entre a interface e Supabase Auth/PostgreSQL */
(function () {
  'use strict';

  let csrfToken = '';
  let currentUser = null;
  let companySettings = null;
  let pendingCompanyLogo = undefined; // undefined = unchanged; null = remove; string = new data URL
  let isSubmitting = false;
  let authMode = 'login';
  let lastAuthMessage = '';
  // Cards virtuais para testar drag-and-drop; nunca são gravados no Supabase.
  let blankTestCards = [];
  let blankTestSequence = 0;

  const statusToApi = {
    'Novo lead': 'lead', 'Qualificado': 'prospect', 'Em negociação': 'negotiation',
    'Cliente': 'customer', 'Inativo': 'inactive'
  };
  const statusFromApi = {
    lead: 'Novo lead', prospect: 'Qualificado', negotiation: 'Em negociação',
    customer: 'Cliente', inactive: 'Inativo'
  };
  const taskStatusToApi = {'Pendente':'pending','Em andamento':'in_progress','Concluída':'completed','Cancelada':'cancelled'};
  const taskStatusFromApi = {pending:'Pendente',in_progress:'Em andamento',completed:'Concluída',cancelled:'Cancelada'};
  const taskTypeToApi = {'Tarefa':'other','Ligação':'call','E-mail':'email','Reunião':'meeting','Retorno':'follow_up'};
  const taskTypeFromApi = {other:'Tarefa',call:'Ligação',email:'E-mail',meeting:'Reunião',follow_up:'Retorno'};
  const priorityToApi = {'Baixa':'low','Média':'medium','Alta':'high'};
  const priorityFromApi = {low:'Baixa',medium:'Média',high:'Alta'};
  const stageAliases = {}; // Os nomes das colunas são personalizados pelo administrador e permanecem fiéis ao banco.

  function emptyState() { return {contacts:[],deals:[],tasks:[],activities:[],pipelines:[],pipelineStages:[],users:[]}; }
  window.loadState = function () { return emptyState(); };
  window.saveState = function () { /* O Supabase é a fonte oficial; não usamos localStorage. */ };


  let supabaseClient = null;

  function isLocalDevelopmentHost(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.test');
  }

  function isPrivilegedSupabaseKey(key) {
    const value = String(key || '').trim();
    // Modern secret keys must never ship in browser code.
    if (/^sb_secret_/i.test(value) || /service_role/i.test(value)) return true;
    // Legacy service_role keys are JWTs. Decode only the public payload field to reject them.
    const parts = value.split('.');
    if (parts.length === 3) {
      try {
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
        const payload = JSON.parse(atob(padded));
        if (payload && String(payload.role || '').toLowerCase() === 'service_role') return true;
      } catch (_) { /* Invalid keys will be rejected by Supabase; do not log them. */ }
    }
    return false;
  }

  function sb() {
    const cfg = window.NEXO_SUPABASE_CONFIG || {};
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      throw new Error('A biblioteca Supabase não carregou. Confira sua conexão com a internet e atualize a página.');
    }
    if (!cfg.url || !cfg.publishableKey || cfg.url.includes('SEU_PROJECT') || cfg.publishableKey.includes('SUA_CHAVE')) {
      throw new Error('Falta configurar o Supabase. Abra supabase-config.js e preencha a URL do projeto e a chave publishable.');
    }
    let parsedUrl;
    try { parsedUrl = new URL(String(cfg.url).trim()); }
    catch (_) { throw new Error('A URL do Supabase está inválida. Confira o valor em supabase-config.js.'); }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error('A conexão com o Supabase precisa usar HTTPS. Corrija a Project URL em supabase-config.js.');
    }
    if (window.location.protocol !== 'https:' && !isLocalDevelopmentHost(window.location.hostname)) {
      throw new Error('Abra o NEXO CRM por um endereço HTTPS para proteger os dados durante a transmissão.');
    }
    if (isPrivilegedSupabaseKey(cfg.publishableKey)) {
      throw new Error('A chave configurada é privilegiada e não pode ficar no navegador. Use somente a chave Publishable do Supabase.');
    }
    if (!supabaseClient) {
      supabaseClient = window.supabase.createClient(parsedUrl.toString().replace(/\/$/, ''), String(cfg.publishableKey).trim(), {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: 'pkce'
        }
      });
    }
    return supabaseClient;
  }

  function throwIfError(result) {
    if (result && result.error) {
      const err = result.error;
      // Keep detailed diagnostics in the developer console, not in the customer-facing UI.
      console.error('[NEXO CRM / Supabase]', { code: err.code || 'unknown', message: err.message || 'request failed' });
      if (err.code === 'PGRST116') throw new Error('Registro não encontrado ou sem permissão para acessá-lo.');
      if (err.code === '42501') throw new Error('A ação foi bloqueada pelas regras de segurança. Se acredita que deveria ter acesso, fale com o administrador.');
      if (err.code === '23505') throw new Error('Já existe um registro com essas informações.');
      if (err.code === '23503') throw new Error('Não foi possível salvar porque um registro relacionado não existe ou não está disponível.');
      if (err.code === '23514' || err.code === '22001' || err.code === '22P02') throw new Error('Algum campo está fora do formato permitido. Confira os dados e tente novamente.');
      if (err.status === 401 || err.status === 403) throw new Error('Sua sessão expirou ou você não tem permissão para esta ação. Entre novamente ou fale com o administrador.');
      throw new Error('Não foi possível concluir a operação. Tente novamente; se persistir, consulte o diagnóstico do Supabase.');
    }
    return result ? result.data : null;
  }

  function checkedText(value, label, maxLength, required = false) {
    if (value === null || value === undefined) {
      if (required) throw new Error(`${label} é obrigatório.`);
      return null;
    }
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${label} está em um formato inválido.`);
    const text = String(value).trim();
    if (required && !text) throw new Error(`${label} é obrigatório.`);
    if (text.length > maxLength) throw new Error(`${label} deve ter no máximo ${maxLength} caracteres.`);
    return text || null;
  }

  function checkedEmail(value) {
    const email = checkedText(value, 'E-mail', 190, false);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Informe um e-mail válido.');
    return email ? email.toLowerCase() : null;
  }

  function checkedId(value, label, optional = false) {
    if ((value === null || value === undefined || value === '') && optional) return null;
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error(`${label} inválido.`);
    return id;
  }

  function checkedChoice(value, label, choices, fallback) {
    const choice = String(value || fallback);
    if (!choices.includes(choice)) throw new Error(`${label} está em um formato inválido.`);
    return choice;
  }

  async function profileForAuth(authUser) {
    const result = await sb().from('users')
      .select('id,auth_user_id,name,email,role,is_active')
      .eq('auth_user_id', authUser.id)
      .maybeSingle();
    const profile = throwIfError(result);
    if (!profile) throw new Error('Sua conta existe no Supabase, mas o perfil do NEXO CRM não foi criado. Confira se o script SQL do NEXO CRM foi executado antes de criar o usuário.');
    if (!profile.is_active) {
      await sb().auth.signOut();
      throw new Error('Este usuário está desativado. Fale com o administrador da instalação.');
    }
    return { ...profile, id: Number(profile.id), is_active: Number(profile.is_active) };
  }

  function dbPayload(body, keys) {
    const out = {};
    keys.forEach(k => { if (Object.prototype.hasOwnProperty.call(body || {}, k)) out[k] = body[k]; });
    return out;
  }

  async function api(action, method='GET', body=null, query={}) {
    const client = sb();
    const d = body || {};
    const id = d.id ?? query.id;
    const now = new Date().toISOString();

    if (action === 'health') return { ok: true, app: 'NEXO CRM + Supabase' };
    if (action === 'setup-status') return { setup_required: false };
    if (action === 'setup-admin') {
      throw new Error('Crie o primeiro usuário em Supabase → Authentication → Users. Execute primeiro o SQL do NEXO CRM; o primeiro usuário criado receberá o perfil Administrador.');
    }

    if (action === 'login' && method === 'POST') {
      const result = await client.auth.signInWithPassword({
        email: String(d.email || '').trim().toLowerCase(),
        password: String(d.password || '')
      });
      const session = throwIfError(result);
      const user = await profileForAuth(session.user);
      return { user, csrf: '' };
    }

    if (action === 'logout' && method === 'POST') {
      const result = await client.auth.signOut();
      throwIfError(result);
      return { ok: true };
    }

    if (action === 'me') {
      const result = await client.auth.getUser();
      if (result.error || !result.data.user) throw new Error('Faça login para continuar.');
      const user = await profileForAuth(result.data.user);
      return { user, csrf: '' };
    }

    if (action === 'dashboard' && method === 'GET') {
      const [c, deals, tasks, wins] = await Promise.all([
        client.from('contacts').select('id', {count:'exact',head:true}).is('deleted_at', null),
        client.from('deals').select('id', {count:'exact',head:true}).is('deleted_at', null).is('closed_at', null),
        client.from('tasks').select('id', {count:'exact',head:true}).is('deleted_at', null).in('status',['pending','in_progress']),
        client.from('deals').select('value,stage:pipeline_stages!deals_stage_id_fkey(is_won)').is('deleted_at',null)
      ]);
      [c,deals,tasks,wins].forEach(throwIfError);
      const wonValue = (wins.data || []).filter(x => x.stage && x.stage.is_won).reduce((sum,x)=>sum+Number(x.value||0),0);
      return { contacts:c.count||0, open_deals:deals.count||0, pending_tasks:tasks.count||0, won_value:wonValue };
    }

    if (action === 'contacts') {
      if (method === 'GET') {
        let request = client.from('contacts')
          .select('*,owner:users!contacts_owner_id_fkey(name)')
          .is('deleted_at', null).order('created_at',{ascending:false}).limit(500);
        const safeQuery = String(query.q || '').normalize('NFKC').replace(/[%_(),]/g, ' ').replace(/[^\p{L}\p{N}\s@.+-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 100);
        if (safeQuery) request = request.or(`name.ilike.%${safeQuery}%,company_name.ilike.%${safeQuery}%,email.ilike.%${safeQuery}%`);
        const data = throwIfError(await request);
        return {data:(data||[]).map(r=>({...r,owner_name:r.owner?.name||null}))};
      }
      if (method === 'POST') {
        const payload = dbPayload(d,['name','company_name','email','phone','source','status','owner_id','notes']);
        payload.name = checkedText(d.name, 'Nome do contato', 160, true);
        payload.company_name = checkedText(d.company_name, 'Empresa', 190);
        payload.email = checkedEmail(d.email);
        payload.phone = checkedText(d.phone, 'Telefone', 40);
        payload.source = checkedText(d.source, 'Origem', 100);
        payload.notes = checkedText(d.notes, 'Observações', 10000);
        payload.status = checkedChoice(d.status, 'Situação do contato', ['lead','prospect','negotiation','customer','inactive'], 'lead');
        if (Object.prototype.hasOwnProperty.call(d,'owner_id')) payload.owner_id = checkedId(d.owner_id, 'Responsável', true);
        const data = throwIfError(await client.from('contacts').insert(payload).select('id').single());
        return {id:Number(data.id),message:'Contato criado.'};
      }
      if (['PUT','PATCH'].includes(method)) {
        const payload = dbPayload(d,['name','company_name','email','phone','source','status','owner_id','notes']);
        if (Object.prototype.hasOwnProperty.call(d,'name')) payload.name = checkedText(d.name, 'Nome do contato', 160, true);
        if (Object.prototype.hasOwnProperty.call(d,'company_name')) payload.company_name = checkedText(d.company_name, 'Empresa', 190);
        if (Object.prototype.hasOwnProperty.call(d,'email')) payload.email = checkedEmail(d.email);
        if (Object.prototype.hasOwnProperty.call(d,'phone')) payload.phone = checkedText(d.phone, 'Telefone', 40);
        if (Object.prototype.hasOwnProperty.call(d,'source')) payload.source = checkedText(d.source, 'Origem', 100);
        if (Object.prototype.hasOwnProperty.call(d,'notes')) payload.notes = checkedText(d.notes, 'Observações', 10000);
        if (Object.prototype.hasOwnProperty.call(d,'status')) payload.status = checkedChoice(d.status, 'Situação do contato', ['lead','prospect','negotiation','customer','inactive'], 'lead');
        if (Object.prototype.hasOwnProperty.call(d,'owner_id')) payload.owner_id = checkedId(d.owner_id, 'Responsável', true);
        const result = throwIfError(await client.from('contacts').update(payload).eq('id',id).is('deleted_at',null).select('id').maybeSingle());
        if (!result) throw new Error('Contato não encontrado ou sem permissão para alterá-lo.');
        return {ok:true,updated:1};
      }
      if (method === 'DELETE') {
        const result = throwIfError(await client.from('contacts').update({deleted_at:now}).eq('id',id).is('deleted_at',null).select('id').maybeSingle());
        if (!result) throw new Error('Contato não encontrado.');
        return {ok:true};
      }
    }

    if (action === 'deals') {
      if (method === 'GET') {
        const data = throwIfError(await client.from('deals')
          .select('*,contact:contacts!deals_contact_id_fkey(name,company_name,last_contact_at),stage:pipeline_stages!deals_stage_id_fkey(name,is_won,is_lost),owner:users!deals_owner_id_fkey(name)')
          .is('deleted_at',null).order('created_at',{ascending:false}).limit(500));
        return {data:(data||[]).map(r=>({...r,contact_name:r.contact?.name||'',contact_company_name:r.contact?.company_name||'',contact_last_contact_at:r.contact?.last_contact_at||null,stage_name:r.stage?.name||'',is_won:r.stage?.is_won||false,is_lost:r.stage?.is_lost||false,owner_name:r.owner?.name||null}))};
      }
      if (method === 'PATCH' && d.stage_id !== undefined && !Object.prototype.hasOwnProperty.call(d,'title')) {
        const dealId = Number(id);
        const current = throwIfError(await client.from('deals').select('id,pipeline_id').eq('id',dealId).is('deleted_at',null).maybeSingle());
        if (!current) throw new Error('Oportunidade não encontrada.');
        const pipelineId = Number(d.pipeline_id || current.pipeline_id);
        const stageId = Number(d.stage_id);
        const stage = throwIfError(await client.from('pipeline_stages').select('id,pipeline_id,is_won,is_lost,name').eq('id',stageId).maybeSingle());
        if (!stage || Number(stage.pipeline_id)!==pipelineId) throw new Error('A etapa selecionada não pertence ao funil informado.');
        const moved = throwIfError(await client.from('deals').update({stage_id:stageId,closed_at:(stage.is_won||stage.is_lost)?now:null}).eq('id',dealId).is('deleted_at',null).select('id').maybeSingle());
        if (!moved) throw new Error('Não foi possível mover a oportunidade.');
        return {ok:true,stage_name:stage.name,is_won:stage.is_won,is_lost:stage.is_lost};
      }
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const pipelineId = Number(d.pipeline_id);
        const stageId = Number(d.stage_id);
        const stage = throwIfError(await client.from('pipeline_stages').select('id,pipeline_id,is_won,is_lost').eq('id',stageId).maybeSingle());
        if (!stage || Number(stage.pipeline_id)!==pipelineId) throw new Error('A etapa selecionada não pertence ao funil informado.');
        const payload = dbPayload(d,['title','description','value','contact_id','pipeline_id','stage_id','owner_id','expected_close_date','lost_reason']);
        payload.title = checkedText(d.title, 'Nome da oportunidade', 190, true);
        payload.description = checkedText(d.description, 'Descrição', 20000);
        const value = Number(d.value ?? 0);
        if (!Number.isFinite(value) || value < 0 || value > 9999999999.99) throw new Error('O valor da oportunidade está fora do limite permitido.');
        payload.value = Math.round(value * 100) / 100;
        payload.contact_id = checkedId(d.contact_id, 'Contato');
        payload.pipeline_id = checkedId(d.pipeline_id, 'Funil');
        payload.stage_id = checkedId(d.stage_id, 'Etapa');
        if (Object.prototype.hasOwnProperty.call(d,'owner_id')) payload.owner_id = checkedId(d.owner_id, 'Responsável', true);
        if (Object.prototype.hasOwnProperty.call(d,'lost_reason')) payload.lost_reason = checkedText(d.lost_reason, 'Motivo da perda', 500);
        payload.closed_at = (stage.is_won || stage.is_lost) ? now : null;
        if (method === 'POST') {
          const created = throwIfError(await client.from('deals').insert(payload).select('id').single());
          return {id:Number(created.id),message:'Oportunidade criada.'};
        }
        const updated = throwIfError(await client.from('deals').update(payload).eq('id',id).is('deleted_at',null).select('id').maybeSingle());
        if (!updated) throw new Error('Oportunidade não encontrada.');
        return {ok:true};
      }
      if (method === 'DELETE') {
        const result = throwIfError(await client.from('deals').update({deleted_at:now}).eq('id',id).is('deleted_at',null).select('id').maybeSingle());
        if (!result) throw new Error('Oportunidade não encontrada.');
        return {ok:true};
      }
    }

    if (action === 'tasks') {
      if (method === 'GET') {
        const data = throwIfError(await client.from('tasks')
          .select('*,contact:contacts!tasks_contact_id_fkey(name),deal:deals!tasks_deal_id_fkey(title),assignee:users!tasks_assigned_to_fkey(name)')
          .is('deleted_at',null).order('created_at',{ascending:false}).limit(500));
        return {data:(data||[]).map(r=>({...r,contact_name:r.contact?.name||'',deal_title:r.deal?.title||'',assignee_name:r.assignee?.name||null}))};
      }
      if (method === 'POST') {
        const payload = dbPayload(d,['title','description','type','status','priority','due_at','assigned_to','created_by','contact_id','deal_id','completed_at']);
        payload.title = checkedText(d.title, 'Título da tarefa', 190, true);
        payload.description = checkedText(d.description, 'Descrição', 20000);
        payload.type = checkedChoice(d.type, 'Tipo da tarefa', ['call','meeting','email','follow_up','other'], 'other');
        payload.status = checkedChoice(d.status, 'Status da tarefa', ['pending','in_progress','completed','cancelled'], 'pending');
        payload.priority = checkedChoice(d.priority, 'Prioridade', ['low','medium','high'], 'medium');
        payload.assigned_to = checkedId(d.assigned_to ?? currentUser?.id, 'Responsável', true);
        payload.created_by = currentUser ? currentUser.id : null; // Never trust an actor ID supplied by the browser.
        if (d.contact_id !== undefined && d.contact_id !== null && d.contact_id !== '') payload.contact_id = checkedId(d.contact_id, 'Contato relacionado');
        if (d.deal_id !== undefined && d.deal_id !== null && d.deal_id !== '') payload.deal_id = checkedId(d.deal_id, 'Oportunidade relacionada');
        if (payload.status === 'completed') payload.completed_at = now;
        const created = throwIfError(await client.from('tasks').insert(payload).select('id').single());
        return {id:Number(created.id),message:'Tarefa criada.'};
      }
      if (['PUT','PATCH'].includes(method)) {
        const payload = dbPayload(d,['status','title','priority','due_at','description','assigned_to','contact_id','deal_id']);
        if (payload.status === 'completed') payload.completed_at = now;
        else if (payload.status) payload.completed_at = null;
        const updated = throwIfError(await client.from('tasks').update(payload).eq('id',id).is('deleted_at',null).select('id').maybeSingle());
        if (!updated) throw new Error('Tarefa não encontrada.');
        return {ok:true};
      }
      if (method === 'DELETE') {
        const result = throwIfError(await client.from('tasks').update({deleted_at:now}).eq('id',id).is('deleted_at',null).select('id').maybeSingle());
        if (!result) throw new Error('Tarefa não encontrada.');
        return {ok:true};
      }
    }

    if (action === 'activities') {
      if (method === 'GET') {
        const data = throwIfError(await client.from('activities')
          .select('*,user:users!activities_user_id_fkey(name),contact:contacts!activities_contact_id_fkey(name),deal:deals!activities_deal_id_fkey(title)')
          .order('created_at',{ascending:false}).limit(500));
        return {data:(data||[]).map(r=>({...r,user_name:r.user?.name||'Usuário',contact_name:r.contact?.name||'',deal_title:r.deal?.title||''}))};
      }
      if (method === 'POST') {
        const payload = dbPayload(d,['contact_id','deal_id','type','title','body','metadata']);
        payload.title = checkedText(d.title, 'Título da atividade', 190, true);
        payload.body = checkedText(d.body, 'Descrição da atividade', 20000);
        payload.type = checkedChoice(d.type, 'Tipo da atividade', ['note','call','meeting','email','stage_change','status_change','other'], 'note');
        if (d.contact_id !== undefined && d.contact_id !== null && d.contact_id !== '') payload.contact_id = checkedId(d.contact_id, 'Contato relacionado');
        if (d.deal_id !== undefined && d.deal_id !== null && d.deal_id !== '') payload.deal_id = checkedId(d.deal_id, 'Oportunidade relacionada');
        payload.user_id = currentUser ? currentUser.id : null; // Database trigger stamps the trusted actor again.
        const data = throwIfError(await client.from('activities').insert(payload).select('id').single());
        return {id:Number(data.id),message:'Atividade registrada.'};
      }
    }

    if (action === 'pipelines' && method === 'GET') {
      const [p,s] = await Promise.all([
        client.from('pipelines').select('id,name,is_default,is_active').eq('is_active',true).order('is_default',{ascending:false}),
        client.from('pipeline_stages').select('id,pipeline_id,name,position,probability,is_won,is_lost').order('pipeline_id').order('position')
      ]);
      const pdata=throwIfError(p), stages=throwIfError(s);
      return {data:pdata||[],stages:stages||[]};
    }

    if (action === 'pipeline-stages') {
      if (method === 'POST') {
        const name=checkedText(d.name, 'Nome da coluna', 100, true);
        const pipelineId=checkedId(d.pipeline_id, 'Funil');
        const pipeline=throwIfError(await client.from('pipelines').select('id').eq('id',pipelineId).eq('is_active',true).maybeSingle());
        if (!pipeline) throw new Error('O funil selecionado não existe ou está inativo.');
        const last=throwIfError(await client.from('pipeline_stages').select('position').eq('pipeline_id',pipelineId).order('position',{ascending:false}).limit(1).maybeSingle());
        const type=checkedChoice(d.stage_type, 'Tipo da etapa', ['open','won','lost'], 'open');
        const probabilityValue=Number(d.probability)||0;
        if (!Number.isFinite(probabilityValue) || probabilityValue < 0 || probabilityValue > 100) throw new Error('A probabilidade deve estar entre 0 e 100.');
        const isWon=type==='won', isLost=type==='lost';
        if (isWon) throwIfError(await client.from('pipeline_stages').update({is_won:false}).eq('pipeline_id',pipelineId).eq('is_won',true));
        if (isLost) throwIfError(await client.from('pipeline_stages').update({is_lost:false}).eq('pipeline_id',pipelineId).eq('is_lost',true));
        const payload={pipeline_id:pipelineId,name,position:Number(last?.position||0)+1,probability:Math.round(probabilityValue),is_won:isWon,is_lost:isLost};
        const created=throwIfError(await client.from('pipeline_stages').insert(payload).select('*').single());
        return {data:created,message:'Coluna criada.'};
      }
      if (method === 'PATCH' || method === 'PUT') {
        const stageId=Number(id); if (!stageId) throw new Error('Coluna inválida.');
        const existing=throwIfError(await client.from('pipeline_stages').select('id,pipeline_id').eq('id',stageId).maybeSingle());
        if (!existing) throw new Error('Coluna não encontrada.');
        const payload={};
        if (d.name !== undefined) payload.name=checkedText(d.name, 'Nome da coluna', 100, true);
        if (d.probability !== undefined) { const p=Number(d.probability); if(!Number.isFinite(p)||p<0||p>100)throw new Error('A probabilidade deve estar entre 0 e 100.'); payload.probability=Math.round(p); }
        if (d.stage_type !== undefined) {
          const type=checkedChoice(d.stage_type, 'Tipo da etapa', ['open','won','lost'], 'open');
          payload.is_won=type==='won'; payload.is_lost=type==='lost';
          if(payload.is_won) throwIfError(await client.from('pipeline_stages').update({is_won:false}).eq('pipeline_id',existing.pipeline_id).eq('is_won',true).neq('id',stageId));
          if(payload.is_lost) throwIfError(await client.from('pipeline_stages').update({is_lost:false}).eq('pipeline_id',existing.pipeline_id).eq('is_lost',true).neq('id',stageId));
        }
        if(!Object.keys(payload).length) throw new Error('Nenhuma alteração para salvar.');
        const updated=throwIfError(await client.from('pipeline_stages').update(payload).eq('id',stageId).select('*').maybeSingle());
        if(!updated) throw new Error('Não foi possível salvar a coluna. Confira se você é administrador.');
        return {data:updated,message:'Coluna atualizada.'};
      }
      if (method === 'DELETE') {
        const stageId=Number(id); if(!stageId) throw new Error('Coluna inválida.');
        const usage=await client.from('deals').select('id',{count:'exact',head:true}).eq('stage_id',stageId).is('deleted_at',null);
        if(usage.error) throw usage.error;
        if(Number(usage.count||0)>0) throw new Error('Esta coluna tem oportunidades. Mova os cards para outras colunas antes de excluí-la.');
        const deleted=throwIfError(await client.from('pipeline_stages').delete().eq('id',stageId).select('id').maybeSingle());
        if(!deleted) throw new Error('Não foi possível excluir a coluna. Confira se você é administrador.');
        return {ok:true};
      }
    }

    if (action === 'users') {
      if (method === 'GET') {
        const rows = throwIfError(await client.from('users').select('id,name,email,role,is_active,created_at').order('name'));
        return {data:(rows||[]).map(u=>({...u,id:Number(u.id),is_active:Number(u.is_active)}))};
      }
      if (method === 'POST') {
        throw new Error('Para adicionar um usuário, use Supabase → Authentication → Users → Add user. O perfil será criado automaticamente. Nunca coloque a chave secret/service_role no navegador.');
      }
      if (method === 'PATCH' || method === 'PUT') {
        const payload = dbPayload(d,['is_active','role']);
        if (payload.is_active !== undefined) payload.is_active = !!payload.is_active;
        const updated = throwIfError(await client.from('users').update(payload).eq('id',id).select('id').maybeSingle());
        if (!updated) throw new Error('Usuário não encontrado ou você não tem permissão para alterá-lo.');
        return {ok:true};
      }
    }

    if (action === 'settings') {
      if (method === 'GET') {
        const data=throwIfError(await client.from('company_settings').select('*').eq('id',1).maybeSingle());
        return {data:data||null};
      }
      if (method === 'POST' || method === 'PUT') {
        const name=checkedText(d.name, 'Nome da empresa', 160, true);
        const payload={id:1,name,email:checkedEmail(d.email),phone:checkedText(d.phone, 'Telefone', 40),currency:String(d.currency||'BRL').slice(0,3),timezone:String(d.timezone||'America/Sao_Paulo').slice(0,64)};
        if(Object.prototype.hasOwnProperty.call(d,'logo_data')) { const logo=d.logo_data; if(logo!==null && (typeof logo!=='string' || logo.length>350000 || !/^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(logo))) throw new Error('Logo inválida. Use PNG, JPG ou WebP, com arquivo até 5 MB; o sistema reduz a imagem antes de salvar.'); payload.logo_data=logo; }
        if(d.theme_mode!==undefined) payload.theme_mode = d.theme_mode==='light'?'light':'dark';
        if(d.accent_color!==undefined) { const c=String(d.accent_color||'').trim(); if(!/^#[0-9a-fA-F]{6}$/.test(c)) throw new Error('A cor deve estar no formato hexadecimal, por exemplo #788d52.'); payload.accent_color=c; }
        const data=throwIfError(await client.from('company_settings').upsert(payload,{onConflict:'id'}).select('*').single());
        return {ok:true,data};
      }
    }
    throw new Error(`Ação "${action}" ainda não está disponível no conector Supabase.`);
  }


  function dateOnly(value) {
    if (!value) return '';
    return String(value).slice(0,10);
  }
  function timeOnly(value) {
    if (!value) return '';
    return String(value).slice(11,16);
  }
  function toDbDateTime(date, time) {
    if (!date) return null;
    return `${date} ${time || '09:00'}:00`;
  }
  function toStageUi(name) { return name || 'Novo lead'; }
  function mapContact(c) {
    return {...c, id:Number(c.id), company:c.company_name || '', owner:c.owner_name || (Number(c.owner_id) === Number(currentUser?.id) ? currentUser.name : ''), status:statusFromApi[c.status] || 'Novo lead', initials:initials(c.name)};
  }
  function mapDeal(d) {
    return {...d, id:Number(d.id), contact_id:Number(d.contact_id), pipeline_id:Number(d.pipeline_id), stage_id:Number(d.stage_id), company:d.contact_company_name || '', contact:d.contact_name || '', contact_last_contact_at:d.contact_last_contact_at || d.contact?.last_contact_at || d.last_contact_at || null, stage:toStageUi(d.stage_name), value:Number(d.value)||0, owner:d.owner_name || (Number(d.owner_id) === Number(currentUser?.id) ? currentUser.name : ''), close:dateOnly(d.expected_close_date), lost_reason:d.lost_reason||'', stage_entered_at:d.stage_entered_at||null, stage_entered_at_estimated:Boolean(d.stage_entered_at_estimated)};
  }
  function mapTask(t) {
    return {...t, id:Number(t.id), raw_status:t.status, raw_type:t.type, status:taskStatusFromApi[t.status] || 'Pendente', type:taskTypeFromApi[t.type] || 'Tarefa', priority:priorityFromApi[t.priority] || 'Média', date:dateOnly(t.due_at), time:timeOnly(t.due_at), related:t.contact_name || t.deal_title || '', owner:t.assignee_name || (Number(t.assigned_to) === Number(currentUser?.id) ? currentUser.name : '')};
  }
  function mapActivity(a) {
    const iconMap = {note:'note',call:'phone',meeting:'calendar',email:'mail',stage_change:'target',status_change:'check',other:'note'};
    return {...a, id:Number(a.id), icon:iconMap[a.type] || 'note', title:a.title || 'Atividade', body:a.body || '', user_name:a.user_name || 'Usuário', contact_name:a.contact_name || '', deal_title:a.deal_title || '', time:formatDateTime(a.created_at)};
  }
  function formatDateTime(value) {
    if (!value) return '—';
    const s=String(value).replace(' ','T');
    const d=new Date(s);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).replace('.','');
  }

  const appearancePresets = [
    {name:'Azul profundo · padrão',hex:'#24466f'},
    {name:'Azul meia-noite',hex:'#142b49'},
    {name:'Azul petróleo',hex:'#1b5363'},
    {name:'Azul aço',hex:'#355d80'},
    {name:'Azul clássico',hex:'#315f98'},
    {name:'Azul vivo',hex:'#2774ba'},
    {name:'Azul céu',hex:'#489bd5'},
    {name:'Turquesa',hex:'#159e9a'},
    {name:'Verde petróleo',hex:'#286e61'},
    {name:'Verde esmeralda',hex:'#19865b'},
    {name:'Verde militar',hex:'#788d52'},
    {name:'Verde oliva',hex:'#647f41'},
    {name:'Sálvia',hex:'#8aa58a'},
    {name:'Menta',hex:'#67b89a'},
    {name:'Roxo profundo',hex:'#5a438b'},
    {name:'Violeta',hex:'#8062bd'},
    {name:'Lavanda',hex:'#a08bdf'},
    {name:'Vinho',hex:'#763d54'},
    {name:'Bordô',hex:'#9f4057'},
    {name:'Rosa',hex:'#c15c86'},
    {name:'Coral',hex:'#d66b62'},
    {name:'Terracota',hex:'#b96342'},
    {name:'Laranja',hex:'#d77b27'},
    {name:'Âmbar',hex:'#c5962c'},
    {name:'Areia',hex:'#b7a178'},
    {name:'Grafite',hex:'#515b66'},
    {name:'Chumbo',hex:'#343b45'},
    {name:'Prata',hex:'#8b969f'},
    {name:'Gelo',hex:'#b6c3cf'},
    {name:'Marrom',hex:'#70503e'},
    {name:'Cobre',hex:'#ad704d'},
    {name:'Preto',hex:'#22262c'}
  ];
  function cleanHex(value) { return /^#[0-9a-fA-F]{6}$/.test(String(value||'')) ? String(value) : '#24466f'; }
  function applyAppearance(theme, accent, remember=true) {
    const safeTheme = theme === 'light' ? 'light' : 'dark';
    const safeAccent = cleanHex(accent);
    document.body.dataset.theme = safeTheme;
    document.documentElement.style.setProperty('--accent', safeAccent);
    document.documentElement.style.setProperty('--accent-strong', `color-mix(in srgb, ${safeAccent} 76%, white)`);
    const hex=safeAccent.slice(1);
    const channels=[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4));
    const luminance=.2126*channels[0]+.7152*channels[1]+.0722*channels[2];
    document.documentElement.style.setProperty('--accent-contrast', luminance>0.43?'#1b2116':'#ffffff');
    document.documentElement.style.setProperty('--olive', safeAccent);
    document.documentElement.style.setProperty('--olive-light', safeAccent);
    document.documentElement.style.setProperty('--accent-soft', `${safeAccent}26`);
    const color = safeAccent.slice(1);
    const rgb = [0,2,4].map(i=>parseInt(color.slice(i,i+2),16)).join(',');
    document.documentElement.style.setProperty('--accent-rgb', rgb);
    if (remember) {
      try { localStorage.setItem('nexo-crm-theme',safeTheme); localStorage.setItem('nexo-crm-accent',safeAccent); } catch (_) {}
    }
  }
  function applySavedAppearance() {
    let localTheme='dark',localAccent='#24466f';
    try { localTheme=localStorage.getItem('nexo-crm-theme')||localTheme; const storedAccent=localStorage.getItem('nexo-crm-accent'); localAccent=(storedAccent && storedAccent.toLowerCase()!=='#788d52')?storedAccent:localAccent; } catch (_) {}
    applyAppearance(companySettings?.theme_mode||localTheme,companySettings?.accent_color||localAccent,false);
  }
  window.previewNexoAppearance = function() {
    const theme=document.getElementById('settingThemeMode')?.value || 'dark';
    const accent=cleanHex(document.getElementById('settingAccentColor')?.value || '#24466f');
    applyAppearance(theme,accent,true);
    const label=document.getElementById('accentHexValue'); if(label) label.textContent=accent.toUpperCase();
    document.querySelectorAll('.theme-swatch').forEach(button=>{
      const match=button.getAttribute('aria-label')?.match(/#[0-9a-fA-F]{6}$/);
      const selected=Boolean(match&&match[0].toLowerCase()===accent.toLowerCase());
      button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));
    });
  };
  window.chooseNexoAccent = function(color) {
    const input=document.getElementById('settingAccentColor');
    if(input) input.value=cleanHex(color);
    window.previewNexoAppearance();
  };
  window.saveNexoAppearance = async function() {
    const theme=document.getElementById('settingThemeMode')?.value || 'dark';
    const accent=cleanHex(document.getElementById('settingAccentColor')?.value || '#24466f');
    applyAppearance(theme,accent,true);
    if(currentUser?.role!=='admin') { showToast('A aparência foi aplicada neste navegador. Somente o administrador pode salvar para toda a empresa.'); return; }
    const prior=companySettings||{};
    try {
      await api('settings','POST',{name:prior.name||document.getElementById('workspaceName')?.textContent||'Minha empresa',email:prior.email||null,phone:prior.phone||null,timezone:prior.timezone||'America/Sao_Paulo',currency:prior.currency||'BRL',theme_mode:theme,accent_color:accent,logo_data:prior.logo_data||null});
      await loadRemoteState(); render(); showToast('Aparência salva para a instalação.');
    } catch(e) {
      // Keeps the preview usable if the SQL migration has not been applied yet.
      showToast('Aparência aplicada neste navegador, mas não foi salva no Supabase. Execute a migração de aparência no arquivo do projeto.');
      console.warn('NEXO appearance save:',e.message);
    }
  };

  async function loadRemoteState() {
    const [contacts, deals, tasks, activities, pipeline, settings] = await Promise.all([
      api('contacts'), api('deals'), api('tasks'), api('activities'), api('pipelines'), api('settings')
    ]);
    state.contacts = (contacts.data || []).map(mapContact);
    state.deals = (deals.data || []).map(mapDeal);
    state.tasks = (tasks.data || []).map(mapTask);
    state.activities = (activities.data || []).map(mapActivity);
    state.pipelines = pipeline.data || [];
    state.pipelineStages = (pipeline.stages || []).map(s=>({...s,id:Number(s.id),pipeline_id:Number(s.pipeline_id),name:String(s.name||''),position:Number(s.position),probability:Number(s.probability),is_won:Boolean(s.is_won),is_lost:Boolean(s.is_lost)}));
    companySettings = settings.data || null;
    applySavedAppearance();
    try {
      const users = await api('users');
      state.users = (users.data || []).map(u=>({...u,id:Number(u.id),is_active:Number(u.is_active)}));
    } catch (e) {
      state.users = currentUser ? [{...currentUser,id:Number(currentUser.id),is_active:1}] : [];
    }
    if (currentUser && !state.users.some(u=>Number(u.id)===Number(currentUser.id))) state.users.unshift({...currentUser,id:Number(currentUser.id),is_active:1});
    updateAccountChrome();
  }

  function ensureAuthMarkup() {
    const existingGate=document.getElementById('authGate');
    if (existingGate && document.getElementById('authContent')) return;
    if (existingGate) existingGate.remove();
    const style=document.createElement('style');
    style.textContent=`
      #authGate{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:22px;background:rgba(5,7,5,.91);backdrop-filter:blur(14px);color:#eef1e9}
      .auth-panel{width:min(100%,450px);background:#121510;border:1px solid #394130;border-radius:18px;padding:30px;box-shadow:0 28px 90px #0009}
      .auth-brand{display:flex;align-items:center;gap:12px;margin-bottom:27px}.auth-logo{height:46px;width:46px;border-radius:13px;display:grid;place-items:center;background:#303c24;border:1px solid #586744;color:#eaf0dd;font-weight:800;font-size:20px}
      .auth-logo svg{width:27px;height:27px;display:block}.auth-brand strong{display:block;font-size:19px;letter-spacing:.03em;font-family:'Space Grotesk',sans-serif}.auth-brand span{font-size:10px;letter-spacing:.15em;color:#a4af96}
      .auth-panel h1{font-size:24px;letter-spacing:-.04em;margin:0 0 8px}.auth-copy{color:#a5aba0;font-size:12px;line-height:1.6;margin:0 0 22px}
      .auth-field{margin:13px 0}.auth-field label{display:block;color:#b9c0b2;font-size:11px;margin-bottom:7px}.auth-field input{width:100%;min-height:43px;border:1px solid #353b31;border-radius:9px;background:#1a1e17;color:#f6f7f3;padding:10px 12px;outline:none}.auth-field input:focus{border-color:#788b5b;box-shadow:0 0 0 3px #788b5b22}
      .auth-submit{width:100%;min-height:44px;border:1px solid var(--accent);border-radius:9px;background:var(--accent);color:white;font-weight:750;margin-top:8px;cursor:pointer}.auth-submit:hover{filter:brightness(1.08)}.auth-error{font-size:12px;line-height:1.5;color:#f1c1b8;background:#4b2620;border:1px solid #75463e;padding:10px;border-radius:8px;margin:12px 0}.auth-foot{font-size:10px;color:#747d6b;line-height:1.6;margin-top:18px}
      .olive-action{background:#647a43!important;border-color:#647a43!important;color:#fff!important}.olive-line{border-color:#425035!important}.profile-info strong{max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .user-table{width:100%;border-collapse:collapse}.user-table td{border-bottom:1px solid var(--line);padding:13px 10px;font-size:12px}.user-table th{padding:10px;text-align:left;font-size:10px;color:var(--muted);text-transform:uppercase}.inline-action{padding:6px 9px;border:1px solid var(--line);border-radius:7px;background:#1d2218;color:#e7ecdf;cursor:pointer;font-size:10px}
      .form-grid .field-full{grid-column:1/-1}
      @media(max-width:520px){.auth-panel{padding:23px}.auth-panel h1{font-size:21px}}
    `;
    document.head.appendChild(style);
    const gate=document.createElement('div'); gate.id='authGate';
    gate.innerHTML='<section class="auth-panel" role="dialog" aria-modal="true"><div class="auth-brand"><div class="auth-logo"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M7 8h8.5L25 22V8h8v24h-8L15 18v14H7z" fill="currentColor"/><path d="M25 8h8v7.5L25 22z" fill="currentColor" opacity=".62"/></svg></div><div><strong>NEXO CRM</strong><span>GESTÃO COMERCIAL</span></div></div><div id="authContent"><p class="auth-copy">Conectando ao servidor...</p></div><div id="authError" class="auth-error" hidden></div></section>';
    document.body.appendChild(gate);
  }
  function showAuthGate(mode='login', message='') {
    ensureAuthMarkup(); authMode=mode; lastAuthMessage=message;
    const content=document.getElementById('authContent');
    if(mode==='setup') {
      content.innerHTML=`<h1>Configure sua empresa</h1><p class="auth-copy">Crie o primeiro administrador do NEXO CRM. Ainda não há usuários cadastrados neste banco.</p>
        <form onsubmit="window.nexoAuthSubmit(event)">
          <div class="auth-field"><label>Nome da empresa</label><input name="company" autocomplete="organization" required placeholder="Sua empresa"></div>
          <div class="auth-field"><label>Seu nome</label><input name="name" autocomplete="name" required placeholder="Nome do administrador"></div>
          <div class="auth-field"><label>E-mail de acesso</label><input name="email" type="email" autocomplete="username" required placeholder="voce@empresa.com.br"></div>
          <div class="auth-field"><label>Senha (mínimo de 12 caracteres)</label><input name="password" type="password" autocomplete="new-password" minlength="12" required placeholder="Crie uma senha forte"></div>
          <button class="auth-submit" type="submit">Criar administrador</button>
        </form><div class="auth-foot">Use esta configuração apenas no ambiente local, com o servidor não exposto à internet.</div>`;
    } else if(mode==='error') {
      content.innerHTML=`<h1>Não foi possível conectar</h1><p class="auth-copy">A interface carregou, mas não conseguiu acessar o Supabase. Confira a URL, a chave publishable e se o SQL de configuração foi executado.</p><button class="auth-submit" type="button" onclick="window.nexoInitialize()">Tentar novamente</button><div class="auth-foot">Não use a chave secret/service_role no navegador. As permissões devem ser protegidas pelas políticas RLS.</div>`;
    } else {
      content.innerHTML=`<h1>Entre no seu CRM</h1><p class="auth-copy">Acesse contatos, oportunidades e atividades armazenados no banco de dados Supabase da sua instalação.</p>
        <form onsubmit="window.nexoAuthSubmit(event)"><div class="auth-field"><label>E-mail</label><input name="email" type="email" autocomplete="username" required placeholder="voce@empresa.com.br"></div><div class="auth-field"><label>Senha</label><input name="password" type="password" autocomplete="current-password" required placeholder="Sua senha"></div><button class="auth-submit" type="submit">Entrar no NEXO CRM</button></form><div class="auth-foot">Os registros vêm do Supabase. As contas são criadas pelo administrador em Supabase → Authentication → Users.</div>`;
    }
    const err=document.getElementById('authError');
    err.textContent=message || ''; err.hidden=!message;
    document.getElementById('authGate').style.display='flex';
  }
  function hideAuthGate() { const el=document.getElementById('authGate'); if(el) el.style.display='none'; }

  async function initializeApp() {
    ensureAuthMarkup();
    showAuthGate('login','Verificando a conexão com o servidor...');
    try {
      const setup=await api('setup-status');
      if(setup.setup_required) { showAuthGate('setup'); return; }
      const session=await api('me');
      currentUser=session.user; csrfToken=session.csrf || '';
      await loadRemoteState();
      hideAuthGate(); render();
    } catch (e) {
      if (e.message && (e.message.includes('Faça login') || e.message.includes('Sessão inválida'))) {
        showAuthGate('login'); return;
      }
      // 401 no endpoint me indica que o banco existe, mas não há sessão iniciada.
      if (e.message && e.message.includes('Faça login')) showAuthGate('login');
      else showAuthGate('error', e.message || 'Falha ao iniciar o CRM.');
    }
  }

  window.nexoInitialize = initializeApp;
  window.nexoAuthSubmit = async function (event) {
    event.preventDefault(); if(isSubmitting) return; isSubmitting=true;
    const form=event.target; const data=Object.fromEntries(new FormData(form).entries());
    const button=form.querySelector('button[type="submit"]'); if(button){button.disabled=true;button.textContent='Aguarde...';}
    try {
      if(authMode==='setup') {
        await api('setup-admin','POST',{name:data.name,email:data.email,password:data.password});
        const logged=await api('login','POST',{email:data.email,password:data.password});
        currentUser=logged.user; csrfToken=logged.csrf || '';
        await api('settings','POST',{name:data.company,email:data.email,currency:'BRL',timezone:'America/Sao_Paulo'});
      } else {
        const logged=await api('login','POST',{email:data.email,password:data.password});
        currentUser=logged.user; csrfToken=logged.csrf || '';
      }
      await loadRemoteState(); hideAuthGate(); render(); showToast(`Bem-vindo, ${currentUser.name}.`);
    } catch(e) {
      let nextMode=authMode;
      if(authMode==='setup') { try { const s=await api('setup-status'); nextMode=s.setup_required?'setup':'login'; } catch(_) { nextMode='error'; } }
      showAuthGate(nextMode,e.message || 'Não foi possível entrar.');
    } finally { isSubmitting=false; }
  };

  async function logout() {
    try { await api('logout','POST',{}); } catch(e) { /* limpa a interface mesmo se a sessão já expirou */ }
    currentUser=null; csrfToken=''; state=emptyState(); showAuthGate('login','Você saiu da sua conta.');
  }
  window.nexoLogout=logout;

  function safeCompanyLogo(value) {
    if (typeof value !== 'string' || value.length > 350000) return null;
    return /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null;
  }
  function paintCompanyLogo(element, data, fallback, alt='Logo da empresa') {
    if (!element) return;
    element.replaceChildren();
    if (data) {
      const image=document.createElement('img');
      image.src=data; image.alt=alt; image.decoding='async';
      element.appendChild(image); element.classList.add('has-logo');
    } else {
      element.textContent=fallback || 'E'; element.classList.remove('has-logo');
    }
  }
  function companyLogoPreviewMarkup() {
    const settingsData=safeCompanyLogo(companySettings?.logo_data);
    const data=pendingCompanyLogo===undefined ? settingsData : safeCompanyLogo(pendingCompanyLogo);
    const name=String(document.getElementById('settingCompany')?.value || companySettings?.name || 'Sua empresa').trim();
    const first=name.slice(0,1).toLocaleUpperCase('pt-BR')||'E';
    return data ? `<img src="${data}" alt="Prévia da logo da empresa">` : esc(first);
  }
  window.previewCompanyLogo = function(input) {
    const file=input?.files?.[0]; if(!file) return;
    const allowed=['image/png','image/jpeg','image/webp'];
    if(!allowed.includes(file.type)){showToast('Escolha uma imagem PNG, JPG ou WebP.');input.value='';return;}
    if(file.size>5*1024*1024){showToast('A logo deve ter no máximo 5 MB.');input.value='';return;}
    const reader=new FileReader();
    reader.onerror=()=>showToast('Não foi possível ler a imagem escolhida.');
    reader.onload=()=>{
      const image=new Image();
      image.onerror=()=>showToast('A imagem não pôde ser aberta. Experimente salvar como PNG, JPG ou WebP.');
      image.onload=()=>{
        const max=256,scale=Math.min(1,max/Math.max(image.naturalWidth,image.naturalHeight));
        const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
        const ctx=canvas.getContext('2d'); if(!ctx){showToast('Seu navegador não conseguiu processar a imagem.');return;}
        ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
        let data=canvas.toDataURL('image/webp',.84);
        if(!data.startsWith('data:image/webp;'))data=canvas.toDataURL('image/png');
        if(data.length>350000){
          const small=document.createElement('canvas');small.width=Math.max(1,Math.round(canvas.width*.65));small.height=Math.max(1,Math.round(canvas.height*.65));
          small.getContext('2d')?.drawImage(canvas,0,0,small.width,small.height);data=small.toDataURL('image/webp',.72);
          if(!data.startsWith('data:image/webp;'))data=small.toDataURL('image/png');
        }
        if(data.length>350000){showToast('A imagem ainda ficou muito grande após a redução. Use uma logo mais simples.');return;}
        pendingCompanyLogo=data;
        const preview=document.getElementById('companyLogoPreview');if(preview)paintCompanyLogo(preview,data,initials(document.getElementById('settingCompany')?.value||'E').slice(0,1));
        const avatar=document.getElementById('companyLogoAvatar');if(avatar)paintCompanyLogo(avatar,data,(document.getElementById('settingCompany')?.value||companySettings?.name||'E').trim().slice(0,1).toUpperCase());
        const menuMark=document.getElementById('workspaceMenuMark');if(menuMark)paintCompanyLogo(menuMark,data,(document.getElementById('settingCompany')?.value||companySettings?.name||'E').trim().slice(0,1).toUpperCase());
        showToast('Logo carregada na prévia. Clique em Salvar alterações para gravar.');
      };
      image.src=String(reader.result||'');
    };
    reader.readAsDataURL(file);
  };
  window.updateCompanyInitialPreview = function(value) {
    if(pendingCompanyLogo!==undefined&&pendingCompanyLogo) return;
    const initial=String(value||'Sua empresa').trim().slice(0,1).toLocaleUpperCase('pt-BR')||'E';
    const preview=document.getElementById('companyLogoPreview');if(preview)paintCompanyLogo(preview,null,initial);
    const avatar=document.getElementById('companyLogoAvatar');if(avatar)paintCompanyLogo(avatar,safeCompanyLogo(companySettings?.logo_data),initial);
    const menuMark=document.getElementById('workspaceMenuMark');if(menuMark)paintCompanyLogo(menuMark,safeCompanyLogo(companySettings?.logo_data),initial);
  };
  window.removeCompanyLogo = function() {
    pendingCompanyLogo=null;
    const preview=document.getElementById('companyLogoPreview'); const name=document.getElementById('settingCompany')?.value||companySettings?.name||'Sua empresa';
    if(preview)paintCompanyLogo(preview,null,String(name).trim().slice(0,1).toUpperCase()||'E');
    if(document.getElementById('settingLogoFile'))document.getElementById('settingLogoFile').value='';
    showToast('Logo removida da prévia. Salve as alterações para confirmar.');
  };

  function updateAccountChrome() {
    if(currentUser) {
      const profileName=document.querySelector('.profile-info strong'); if(profileName) profileName.textContent=currentUser.name;
      const profileRole=document.querySelector('.profile-info span'); if(profileRole) profileRole.textContent=({admin:'Administrador',manager:'Gerente',sales:'Vendedor'})[currentUser.role] || currentUser.role;
      const profilePic=document.querySelector('.profile-pic'); if(profilePic) profilePic.textContent=initials(currentUser.name);
    }
    const companyName=String(companySettings?.name||'Sua empresa').trim()||'Sua empresa';
    const workspaceName=document.getElementById('workspaceName'); if(workspaceName) workspaceName.textContent=companyName;
    const menuName=document.getElementById('workspaceMenuName'); if(menuName) menuName.textContent=companyName;
    const companyInitial=companyName.slice(0,1).toLocaleUpperCase('pt-BR')||'E';
    const logoData=safeCompanyLogo(companySettings?.logo_data);
    paintCompanyLogo(document.getElementById('companyLogoAvatar'),logoData,companyInitial,'Logo da empresa');
    paintCompanyLogo(document.getElementById('workspaceMenuMark'),logoData,companyInitial,'Logo da empresa');
    let logoutButton=document.getElementById('nexoLogoutButton');
    if(!logoutButton) {
      const topbar=document.querySelector('.topbar');
      if(topbar) { logoutButton=document.createElement('button'); logoutButton.id='nexoLogoutButton'; logoutButton.className='btn ghost small'; logoutButton.type='button'; logoutButton.textContent='Sair'; logoutButton.onclick=logout; logoutButton.title='Encerrar sessão'; topbar.appendChild(logoutButton); }
    }
    const cc=document.getElementById('contactCount'); if(cc) cc.textContent=state.contacts?.length||0;
    const tc=document.getElementById('taskCount'); if(tc) tc.textContent=(state.tasks||[]).filter(t=>t.status!=='Concluída' && t.status!=='Cancelada').length;
  }

  function liveStat(label,value,icon,note='Calculado com os registros do banco') {
    return `<article class="card stat-card"><div class="stat-top"><span>${esc(label)}</span><span class="stat-icon">${ico(icon,17)}</span></div><div class="stat-value">${esc(value)}</div><div class="stat-bottom"><span class="stat-note">${esc(note)}</span></div></article>`;
  }
  window.statusClass = function(s) { return ['Ganho','Qualificado','Concluída','Cliente'].includes(s)?'light':s==='Inativo'||s==='Cancelada'?'muted':''; };
  window.contactRow = function(c) {
    return `<tr><td><div class="contact-cell"><div class="avatar">${esc(c.initials||initials(c.name))}</div><div><div class="contact-name">${esc(c.name)}</div><div class="contact-company">${esc(c.company||'—')}</div></div></div></td><td>${esc(c.email||'—')}</td><td>${esc(c.phone||'—')}</td><td><span class="status ${statusClass(c.status)}">${esc(c.status||'Novo lead')}</span></td><td>${esc(c.owner||'—')}</td><td><button class="icon-button" aria-label="Editar contato" onclick="openModal('contact',${c.id})">${ico('dots',17)}</button></td></tr>`;
  };
  window.activityItem = function(a) {
    const title=a.title || 'Atividade registrada';
    const related=[a.contact_name,a.deal_title].filter(Boolean).join(' · ');
    return `<div class="activity-item"><div class="activity-icon">${ico(a.icon||'note',15)}</div><div class="activity-body"><div class="activity-text"><b>${esc(a.user_name||currentUser?.name||'Usuário')}</b> — ${esc(title)}${a.body?`: ${esc(a.body)}`:''}${related?` <span style="color:#8e9880">· ${esc(related)}</span>`:''}</div><div class="activity-time">${esc(a.time||formatDateTime(a.created_at))}</div></div></div>`;
  };
  window.taskItem = function(t) {
    const late=t.date && t.date < new Date().toISOString().slice(0,10) && t.status!=='Concluída';
    return `<div class="task-item"><button class="check-task ${t.status==='Concluída'?'done':''}" aria-label="${t.status==='Concluída'?'Reabrir':'Concluir'} tarefa" onclick="toggleTask(${t.id})"></button><div class="activity-body"><div class="task-text" style="${t.status==='Concluída'?'text-decoration:line-through;color:#81898f':''}">${esc(t.title)}</div><div class="task-meta"><span>${esc(t.related||'Sem vínculo')}</span><span>·</span><span class="due ${late?'overdue':''}">${ico('clock',10)} ${datePt(t.date)} · ${esc(t.time||'')}</span></div></div><button class="icon-button" aria-label="Editar tarefa" onclick="openModal('task',${t.id})">${ico('dots',15)}</button></div>`;
  };
  window.taskPageRow = function(t) {
    return `<div class="task-row"><button class="check-task ${t.status==='Concluída'?'done':''}" onclick="toggleTask(${t.id})" aria-label="Alternar conclusão"></button><div><div class="task-title" style="${t.status==='Concluída'?'text-decoration:line-through;color:#777':''}">${esc(t.title)}</div><div class="task-sub">${esc(t.type)} · ${esc(t.related||'Sem vínculo')}</div></div><div class="task-owner"><span class="deal-owner"><span class="tiny-avatar">${initials(t.owner||'')}</span><span style="font-size:10px;color:#a9b0b5">${esc(t.owner||'—')}</span></span></div><div class="task-due">${datePt(t.date)} <span style="color:#737b82">${esc(t.time||'')}</span></div><div class="task-priority priority">${esc(t.priority)}</div><button class="icon-button task-actions" onclick="openModal('task',${t.id})" aria-label="Editar tarefa">${ico('dots',16)}</button></div>`;
  };

  window.dashboard = function () {
    const contacts=state.contacts||[], deals=state.deals||[], tasks=state.tasks||[], activities=state.activities||[];
    const getDealStage=d=>(state.pipelineStages||[]).find(st=>Number(st.id)===Number(d.stage_id));
    const isWonDeal=d=>Boolean(getDealStage(d)?.is_won ?? d.is_won);
    const isLostDeal=d=>Boolean(getDealStage(d)?.is_lost ?? d.is_lost);
    const opened=deals.filter(d=>!isWonDeal(d)&&!isLostDeal(d));
    const pending=tasks.filter(t=>!['Concluída','Cancelada'].includes(t.status));
    const openValue=opened.reduce((s,d)=>s+(Number(d.value)||0),0);
    const dateLabel=new Intl.DateTimeFormat('pt-BR',{weekday:'long',day:'2-digit',month:'short',year:'numeric'}).format(new Date()).replace('.','');
    const stages=(state.pipelineStages||[]).slice().sort((a,b)=>a.position-b.position);
    const activeStages=stages.filter(s=>!s.is_won&&!s.is_lost);
    const stageHtml=activeStages.map(s=>{const ds=deals.filter(d=>Number(d.stage_id)===Number(s.id));const pct=opened.length?Math.max(2,ds.length/opened.length*100):0;return `<div class="pipeline-row"><span class="pipeline-name">${esc(s.name)}</span><div class="pipeline-bar"><div class="pipeline-fill" style="width:${pct}%"></div></div><span class="pipeline-count">${ds.length}</span></div>`}).join('');
    const recent=contacts.slice(0,5);
    const chart=deals.length?`<div class="chart-legend"><span><i class="legend-dot"></i>Oportunidades</span><span><i class="legend-dot gray"></i>Valor registrado</span></div><div style="padding:25px 0;color:var(--muted);font-size:12px">${deals.length} oportunidade(s) cadastrada(s), totalizando <b style="color:var(--text)">${money(deals.reduce((s,d)=>s+d.value,0))}</b>. Os dados são carregados diretamente do Supabase.</div>`:`<div class="empty"><strong>Seu desempenho aparecerá aqui</strong>Cadastre oportunidades para gerar indicadores reais.</div>`;
    return `${pageHeader(dateLabel.toUpperCase(),'Visão geral',`Bem-vindo, ${esc(currentUser?.name||'usuário')}. Estes indicadores vêm dos registros do seu CRM.`,button('Novo contato',"openModal('contact')",true,'plus')+button('Nova oportunidade',"openModal('deal')",false,'target'))}
      <div class="stats">${liveStat('Contatos totais',contacts.length,'users','Registros ativos')}${liveStat('Oportunidades abertas',opened.length,'target','Ainda não encerradas')}${liveStat('Valor em aberto',money(openValue),'money','Soma das oportunidades abertas')}${liveStat('Tarefas pendentes',pending.length,'calendar','Aguardando conclusão')}</div>
      <div class="dashboard-grid"><section class="card"><div class="card-head"><div><div class="card-title">Visão comercial</div><div class="card-sub">Resumo baseado nos dados registrados</div></div></div><div class="chart-wrap">${chart}</div></section>
      <section class="card"><div class="card-head"><div><div class="card-title">Funil de vendas</div><div class="card-sub">Distribuição das oportunidades por etapa</div></div><button class="icon-button" aria-label="Abrir funil" onclick="navigate('pipeline')">${ico('arrow',16)}</button></div><div class="pipeline-summary">${stageHtml||'<div class="empty">Configure as etapas do funil para começar.</div>'}<div class="panel-divider" style="margin-top:19px;padding-top:16px;display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:10px;color:var(--muted);margin-bottom:5px">Valor em aberto</div><div style="font-size:21px;letter-spacing:-.04em;font-weight:750">${money(openValue)}</div></div>${button('Ver funil',"navigate('pipeline')",false,'arrow')}</div></div></section></div>
      <section class="card table-card"><div class="card-head"><div><div class="card-title">Contatos recentes</div><div class="card-sub">Últimos contatos adicionados ao banco</div></div>${button('Ver todos',"navigate('contacts')",false,'arrow')}</div><div class="table-scroll"><table><thead><tr><th>Contato</th><th>E-mail</th><th>Telefone</th><th>Status</th><th>Responsável</th><th></th></tr></thead><tbody>${recent.map(contactRow).join('')||'<tr><td colspan="6"><div class="empty"><strong>Sua base começa aqui</strong>Cadastre seu primeiro contato para acompanhar o relacionamento.</div></td></tr>'}</tbody></table></div><div class="table-foot"><span>Exibindo <b>${recent.length}</b> de <b>${contacts.length}</b> contatos</span></div></section>
      <div class="bottom-grid"><section class="card"><div class="card-head"><div><div class="card-title">Atividade recente</div><div class="card-sub">Interações registradas no sistema</div></div><button class="icon-button" aria-label="Ver atividades" onclick="navigate('activities')">${ico('arrow',16)}</button></div><div class="activity-list">${activities.slice(0,5).map(activityItem).join('')||'<div class="empty">Nenhuma atividade registrada.</div>'}</div></section><section class="card"><div class="card-head"><div><div class="card-title">Próximas tarefas</div><div class="card-sub">Acompanhamento de retornos</div></div><button class="icon-button" aria-label="Ver tarefas" onclick="navigate('tasks')">${ico('arrow',16)}</button></div><div class="tasks-list">${pending.slice(0,4).map(taskItem).join('')||'<div class="empty">Nenhuma tarefa pendente.</div>'}</div></section></div>`;
  };

  window.contactsPage = function () {
    const filtered=(state.contacts||[]).filter(c=>{const q=(searchQuery||'').toLowerCase();const matches=!q||[c.name,c.company,c.email,c.phone,c.owner].some(v=>(v||'').toLowerCase().includes(q));return matches&&(contactFilter==='Todos'||c.status===contactFilter)});
    const statuses=['Todos','Novo lead','Qualificado','Em negociação','Cliente','Inativo'];
    return `${pageHeader('RELACIONAMENTO','Contatos','Gerencie contatos salvos no banco de dados.',button('Importar CSV',"document.getElementById('csvFile').click()",false,'download')+button('Novo contato',"openModal('contact')",true,'plus'))}<input type="file" id="csvFile" class="hidden" accept=".csv,text/csv" onchange="importCSV(this)"><section class="card table-card"><div class="card-head"><div><div class="card-title">Base de contatos <span style="color:#858c92;font-weight:500">(${state.contacts.length})</span></div><div class="card-sub">Cadastros persistidos no Supabase.</div></div><button class="btn small ghost" onclick="exportCSV('contacts')">${ico('download',13)} Exportar CSV</button></div><div class="table-toolbar"><label class="search-box">${ico('search')}<input id="contactSearch" placeholder="Buscar nome, empresa ou e-mail..." value="${esc(searchQuery)}" oninput="searchContacts(this.value)"></label><select class="toolbar-select" onchange="setContactFilter(this.value)">${statuses.map(s=>`<option ${contactFilter===s?'selected':''}>${esc(s)}</option>`).join('')}</select><div class="toolbar-spacer"></div></div><div class="table-scroll"><table><thead><tr><th>Contato</th><th>E-mail</th><th>Telefone</th><th>Status</th><th>Responsável</th><th></th></tr></thead><tbody>${filtered.map(contactRow).join('')||'<tr><td colspan="6"><div class="empty"><strong>Nenhum contato encontrado</strong>Cadastre um contato ou ajuste os filtros.</div></td></tr>'}</tbody></table></div><div class="table-foot"><span>Exibindo <b>${filtered.length}</b> contato(s) do banco.</span></div></section>`;
  };
  const CONTACT_TOUCH_TYPES = new Set(['call','meeting','email']);
  const CONTACT_TASK_TYPES = new Set(['call','meeting','email','follow_up']);
  let contactTouchCache = null;
  function parseActivityTime(value) {
    if (!value) return null;
    const raw=String(value);
    const normalized=/^\d{4}-\d{2}-\d{2} \d{2}:/.test(raw)?raw.replace(' ','T'):raw;
    const d = new Date(normalized);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function buildContactTouchCache() {
    if(contactTouchCache && contactTouchCache.activities===state.activities && contactTouchCache.tasks===state.tasks && contactTouchCache.deals===state.deals) return contactTouchCache;
    const byContact=new Map(),byDeal=new Map();
    const dealContacts=new Map((state.deals||[]).map(d=>[Number(d.id),Number(d.contact_id)||null]));
    const put=(map,key,date,source)=>{
      if(!key||!date)return;
      const prior=map.get(Number(key));
      if(!prior||date>prior.date)map.set(Number(key),{date,source});
    };
    const linkTouch=(date,source,contactId,dealId)=>{
      put(byContact,contactId,date,source);
      put(byDeal,dealId,date,source);
      if(!contactId&&dealId)put(byContact,dealContacts.get(Number(dealId)),date,source);
    };
    for(const activity of (state.activities||[])){
      const type=String(activity.type||'').toLowerCase();
      if(!CONTACT_TOUCH_TYPES.has(type))continue;
      const date=parseActivityTime(activity.created_at);
      const dealId=Number(activity.deal_id)||null;
      const contactId=Number(activity.contact_id)||dealContacts.get(Number(dealId))||null;
      linkTouch(date,({call:'ligação',meeting:'reunião',email:'e-mail'})[type]||'interação',contactId,dealId);
    }
    for(const task of (state.tasks||[])){
      const type=String(task.raw_type||task.type||'').toLowerCase();
      const status=String(task.raw_status||task.status||'').toLowerCase();
      if(!CONTACT_TASK_TYPES.has(type)||!['completed','concluída','concluida'].includes(status))continue;
      const date=parseActivityTime(task.completed_at||task.updated_at||task.created_at);
      const dealId=Number(task.deal_id)||null;
      const contactId=Number(task.contact_id)||dealContacts.get(Number(dealId))||null;
      linkTouch(date,'tarefa de contato concluída',contactId,dealId);
    }
    contactTouchCache={activities:state.activities,tasks:state.tasks,deals:state.deals,byContact,byDeal};
    return contactTouchCache;
  }
  function belongsToDeal(item, deal) {
    return (item.deal_id && Number(item.deal_id) === Number(deal.id)) ||
      (deal.contact_id && item.contact_id && Number(item.contact_id) === Number(deal.contact_id));
  }
  function dealLastContactMeta(deal) {
    const cache=buildContactTouchCache();
    const canonical=parseActivityTime(deal.contact_last_contact_at||deal.last_contact_at);
    const direct=cache.byDeal.get(Number(deal.id));
    const byContact=cache.byContact.get(Number(deal.contact_id));
    let latest=canonical, latestSource=canonical?'última interação registrada':'';
    for(const candidate of [direct,byContact]){
      if(candidate&&(!latest||candidate.date>latest)){latest=candidate.date;latestSource=candidate.source;}
    }
    if(!latest)return {tone:'unknown',days:null,label:'Sem histórico de contato',title:deal.contact_id||deal.contact?'Há um contato associado, mas não encontramos uma ligação, reunião, e-mail ou tarefa de contato concluída registrada no NEXO. Apenas associar o contato ao card ou escrever uma nota genérica não atualiza a data.':'Não há contato associado nem uma interação de contato registrada. Registre uma ligação, reunião, e-mail ou tarefa de contato concluída para iniciar a contagem.'};
    const days=Math.max(0,Math.floor((Date.now()-latest.getTime())/86400000));
    if(days<=6)return {tone:'good',days,label:days===0?'Contato hoje':`Último contato há ${days} dia(s)`,title:`Última interação: ${latestSource}, há ${days} dia(s). Verde: 0–6 dias.`};
    if(days<=15)return {tone:'warning',days,label:`Último contato há ${days} dias`,title:`Última interação: ${latestSource}, há ${days} dias. Amarelo: 7–15 dias.`};
    return {tone:'critical',days,label:`Último contato há ${days} dias`,title:`Última interação: ${latestSource}, há ${days} dias. Vermelho: mais de 15 dias.`};
  }
  function dealStageAgeMeta(deal) {
    const entered=parseActivityTime(deal.stage_entered_at);
    if(!entered)return {days:null,stale:false,critical:false,estimated:true,label:'Tempo na etapa indisponível'};
    const days=Math.max(0,Math.floor((Date.now()-entered.getTime())/86400000));
    const stage=(state.pipelineStages||[]).find(s=>Number(s.id)===Number(deal.stage_id));
    const closed=Boolean(stage?.is_won||stage?.is_lost||deal.is_won||deal.is_lost);
    const estimated=Boolean(deal.stage_entered_at_estimated);
    return {days,stale:!closed&&days>=7,critical:!closed&&days>=15,estimated,label:`${estimated?'~':''}${days===0?'Nesta etapa hoje':`Etapa há ${days} dia(s)`}`};
  }
  function dealHasOverdueTask(deal) {
    const now=Date.now();
    return (state.tasks||[]).some(task=>{
      const status=String(task.raw_status||task.status||'').toLowerCase();
      const open=['pending','in_progress','pendente','em andamento'].includes(status);
      const due=parseActivityTime(task.due_at);
      return open && due && due.getTime()<now && belongsToDeal(task,deal);
    });
  }
  function dealHasNextStep(deal) {
    return (state.tasks||[]).some(task=>{
      const status=String(task.raw_status||task.status||'').toLowerCase();
      const open=['pending','in_progress','pendente','em andamento'].includes(status);
      if(!open||!belongsToDeal(task,deal))return false;
      const due=parseActivityTime(task.due_at);
      return Boolean(due&&due.getTime()>=Date.now());
    });
  }
  function dealIsOpen(deal) {
    const stage=(state.pipelineStages||[]).find(s=>Number(s.id)===Number(deal.stage_id));
    return !(stage?.is_won||stage?.is_lost||deal.is_won||deal.is_lost);
  }
  function dealRiskMeta(deal) {
    const recency=dealLastContactMeta(deal), age=dealStageAgeMeta(deal), overdue=dealHasOverdueTask(deal), nextStep=dealHasNextStep(deal);
    const flags=[]; let score=0;
    if(overdue){flags.push({label:'Retorno vencido',tone:'critical'});score+=100;}
    if(recency.tone==='critical'){flags.push({label:'Sem contato há '+recency.days+' dias',tone:'critical'});score+=75;}
    else if(recency.tone==='unknown'){flags.push({label:'Sem interação registrada',tone:'warning'});score+=45;}
    else if(recency.tone==='warning'){flags.push({label:'Contato precisa de atenção',tone:'warning'});score+=30;}
    if(age.critical){flags.push({label:`Etapa parada há ${age.days} dias`,tone:'critical'});score+=65;}
    else if(age.stale){flags.push({label:`Etapa há ${age.days} dias`,tone:'warning'});score+=35;}
    if(dealIsOpen(deal)&&!nextStep){flags.push({label:'Sem próximo retorno agendado',tone:'warning'});score+=25;}
    return {recency,age,overdue,nextStep,flags,score};
  }
  window.blankTestDealCard = function(testCard) {
    return `<article class="deal-card blank-test-deal-card" data-blank-test-id="${esc(testCard.id)}" data-stage-id="${Number(testCard.stage_id)}" draggable="true" ondragstart="handleBlankTestDragStart(event,'${esc(testCard.id)}')" ondragend="handleDealDragEnd(event)" aria-label="Card vazio temporário para testar movimentação"><span class="deal-recency-dot recency-unknown" title="Card de teste; não representa um lead real" aria-label="Card de teste"></span><div class="blank-test-card-top"><span class="blank-test-chip">CARD DE TESTE</span><span class="blank-test-temp">TEMPORÁRIO</span></div><div class="blank-test-skeleton" aria-hidden="true"><i></i><i></i><i></i></div><button class="blank-test-remove" type="button" onclick="removeBlankTestCard(event,'${esc(testCard.id)}')">Remover card de teste</button><div class="blank-test-note">Não salvo no banco · arraste para testar</div></article>`;
  };
  window.addBlankTestCard = function() {
    const pipelineId = Number(state.pipelines?.find(p=>Number(p.is_default)===1)?.id || state.pipelines?.[0]?.id || 0);
    const available = (state.pipelineStages||[]).filter(s=>Number(s.pipeline_id)===pipelineId).sort((a,b)=>a.position-b.position);
    const first = available.find(s=>!s.is_won&&!s.is_lost) || available[0];
    if (!first) { showToast('Crie uma coluna do funil antes de adicionar o card de teste.'); return; }
    const testCard = {id:`test-${++blankTestSequence}`,stage_id:Number(first.id)};
    blankTestCards.push(testCard);
    render();
    showToast('Card vazio adicionado. Ele é temporário e não altera seus dados reais.');
  };
  window.removeBlankTestCard = function(event,id) {
    event?.preventDefault(); event?.stopPropagation();
    blankTestCards = blankTestCards.filter(c=>c.id!==id);
    const card = document.querySelector(`[data-blank-test-id="${CSS.escape(id)}"]`);
    card?.remove();
    updateStageCountsInDom();
    showToast('Card de teste removido.');
  };
  window.handleBlankTestDragStart = function(event,id) {
    window.__nexoDragActive=true;
    window.__nexoSuppressClickUntil=Date.now()+650;
    event.dataTransfer.effectAllowed='move';
    event.dataTransfer.setData('text/plain',`nexo-test-card:${id}`);
    event.currentTarget.classList.add('dragging');
  };
  function moveBlankTestCard(id,targetStageId) {
    const item=blankTestCards.find(c=>c.id===id);
    const stage=(state.pipelineStages||[]).find(s=>Number(s.id)===Number(targetStageId));
    const card=document.querySelector(`[data-blank-test-id="${CSS.escape(id)}"]`);
    const zone=document.querySelector(`[data-stage-dropzone="${Number(targetStageId)}"]`);
    if(!item||!stage||!card||!zone)return;
    if(Number(item.stage_id)===Number(stage.id))return;
    const pipeline=(state.pipelineStages||[]).find(s=>Number(s.id)===Number(item.stage_id));
    if(pipeline && Number(pipeline.pipeline_id)!==Number(stage.pipeline_id)){showToast('O card de teste só pode ser movido dentro do mesmo funil.');return;}
    item.stage_id=Number(stage.id);
    card.dataset.stageId=String(stage.id);
    zone.appendChild(card);
    updateStageCountsInDom();
    showToast(`Card de teste movido para “${stage.name}”. Nenhum dado foi gravado.`);
  }

  window.dealCard = function(d) {
    const meta=dealRiskMeta(d);
    const toneLabel={good:'Verde · contato recente',warning:'Amarelo · acompanhar',critical:'Vermelho · contato atrasado',unknown:'Cinza · sem interação registrada'}[meta.recency.tone];
    const stageAge=meta.age;
    const showStageAge=dealIsOpen(d)&&stageAge.days!==null&&stageAge.days>=3;
    const firstRisk=meta.flags.find(f=>f.label==='Retorno vencido')||meta.flags.find(f=>f.tone==='critical')||meta.flags.find(f=>f.tone==='warning');
    return `<article class="deal-card ${meta.score>=75?'deal-card-risk':''}" data-deal-id="${d.id}" data-stage-id="${d.stage_id}" draggable="true" ondragstart="handleDealDragStart(event,${d.id})" ondragend="handleDealDragEnd(event)" onclick="if(Date.now()<(window.__nexoSuppressClickUntil||0)){event.preventDefault();return false;}openModal('deal',${d.id})"><span class="deal-recency-dot recency-${meta.recency.tone}" title="${esc(`${toneLabel}. ${meta.recency.title}`)}" aria-label="${esc(toneLabel)}"></span><strong>${esc(d.title)}</strong><div class="deal-company">${esc(d.company||d.contact||'Contato')}${d.contact?' · '+esc(d.contact):''}</div><div class="deal-contact-recency">${esc(meta.recency.label)}</div>${showStageAge?`<div class="deal-stage-age ${stageAge.critical?'critical':stageAge.stale?'warning':''}" title="${stageAge.estimated?'Tempo aproximado com base na última atualização anterior à instalação do contador.':'Tempo desde que o negócio entrou nesta etapa.'}">${esc(stageAge.label)}${stageAge.estimated?' · estimado':''}</div>`:''}${meta.overdue?'<div class="deal-followup-alert" title="Existe uma tarefa aberta vinculada a este lead com prazo vencido">⌛ Retorno vencido</div>':firstRisk&&firstRisk.label!=='Retorno vencido'&&meta.score>=25?`<div class="deal-risk-tag ${firstRisk.tone}">${esc(firstRisk.label)}</div>`:''}<div class="deal-price">${money(d.value)}</div><div class="deal-foot"><span class="deal-owner"><span class="tiny-avatar">${initials(d.owner||'')}</span>${esc(d.owner||'—')}</span><span>${datePt(d.close)}</span></div></article>`;
  };

  window.allowDealDrop = function(event) {
    event.preventDefault();
    if(event.dataTransfer) event.dataTransfer.dropEffect='move';
    event.currentTarget.closest('.stage-column')?.classList.add('drop-ready');
  };
  window.leaveDealDrop = function(event) {
    if(!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.closest('.stage-column')?.classList.remove('drop-ready');
  };
  window.handleDealDragStart = function(event,id) {
    window.__nexoDragActive=true; window.__nexoDraggingDealId=Number(id);
    window.__nexoSuppressClickUntil=Date.now()+650;
    event.dataTransfer.effectAllowed='move'; event.dataTransfer.setData('text/plain',String(id));
    event.currentTarget.classList.add('dragging');
  };
  window.handleDealDragEnd = function(event) {
    event.currentTarget?.classList.remove('dragging');
    document.querySelectorAll('.stage-column.drop-ready').forEach(el=>el.classList.remove('drop-ready'));
    window.__nexoDragActive=false; window.__nexoDraggingDealId=null;
    window.__nexoSuppressClickUntil=Date.now()+250;
  };
  function updateStageCountsInDom() {
    document.querySelectorAll('[data-stage-column]').forEach(column=>{
      const stageId=Number(column.dataset.stageColumn);
      const deals=(state.deals||[]).filter(d=>Number(d.stage_id)===stageId);
      const summary=column.querySelector('.stage-summary');
      if(summary) summary.textContent=`${deals.length} · ${money(deals.reduce((sum,d)=>sum+(Number(d.value)||0),0))}`;
    });
  }
  async function moveDealToStage(dealId,targetStageId) {
    const deal=(state.deals||[]).find(d=>Number(d.id)===Number(dealId));
    const stage=(state.pipelineStages||[]).find(s=>Number(s.id)===Number(targetStageId));
    const card=document.querySelector(`[data-deal-id="${Number(dealId)}"]`);
    const targetZone=document.querySelector(`[data-stage-dropzone="${Number(targetStageId)}"]`);
    if(!deal||!stage||!card||!targetZone)return;
    if(Number(deal.stage_id)===Number(stage.id))return;
    if(Number(deal.pipeline_id)!==Number(stage.pipeline_id)) { showToast('Esta coluna pertence a outro funil.'); return; }
    const oldStageId=Number(deal.stage_id), oldStage=deal.stage;
    const sourceZone=card.parentElement;
    const oldClosedAt=deal.closed_at||null; const oldStageEnteredAt=deal.stage_entered_at||null; const oldStageEstimated=Boolean(deal.stage_entered_at_estimated);
    deal.stage_id=Number(stage.id);deal.stage=stage.name;deal.is_won=Boolean(stage.is_won);deal.is_lost=Boolean(stage.is_lost);
    deal.stage_entered_at=new Date().toISOString();deal.stage_entered_at_estimated=false;
    deal.closed_at=(stage.is_won||stage.is_lost)?new Date().toISOString():null;
    card.dataset.stageId=String(stage.id);card.classList.add('saving-stage');
    targetZone.appendChild(card); updateStageCountsInDom();
    try {
      await api('deals','PATCH',{id:Number(deal.id),pipeline_id:Number(deal.pipeline_id),stage_id:Number(stage.id)});
      await api('activities','POST',{title:'Oportunidade movida',body:`${deal.title}: ${oldStage||'Etapa anterior'} → ${stage.name}`,type:'stage_change',contact_id:Number(deal.contact_id),deal_id:Number(deal.id)}).catch(e=>console.warn('Histórico não registrado:',e.message));
      const cardHost=document.createElement('div'); cardHost.innerHTML=window.dealCard(deal).trim(); const refreshedCard=cardHost.firstElementChild;
      if(refreshedCard)card.replaceWith(refreshedCard); else card.classList.remove('saving-stage');
      updateStageCountsInDom();
      showToast(`Oportunidade movida para “${stage.name}”.`);
    } catch(e) {
      deal.stage_id=oldStageId;deal.stage=oldStage;deal.is_won=Boolean((state.pipelineStages||[]).find(st=>Number(st.id)===oldStageId)?.is_won);deal.is_lost=Boolean((state.pipelineStages||[]).find(st=>Number(st.id)===oldStageId)?.is_lost);deal.closed_at=oldClosedAt;deal.stage_entered_at=oldStageEnteredAt;deal.stage_entered_at_estimated=oldStageEstimated;
      card.dataset.stageId=String(oldStageId);card.classList.remove('saving-stage');
      if(sourceZone)sourceZone.appendChild(card);
      updateStageCountsInDom();
      showToast(e.message||'Não foi possível mover a oportunidade. Confira a permissão de edição no Supabase.');
    }
  }
  window.dropDeal = async function(event,targetStageId) {
    event.preventDefault();
    const rawId=String(event.dataTransfer?.getData('text/plain')||window.__nexoDraggingDealId||'');
    event.currentTarget.closest('.stage-column')?.classList.remove('drop-ready');
    if(rawId.startsWith('nexo-test-card:')) { moveBlankTestCard(rawId.slice('nexo-test-card:'.length),Number(targetStageId)); return; }
    const id=Number(rawId);
    if(id) await moveDealToStage(id,Number(targetStageId));
  };
  window.toggleStageCreator = function() {
    let form=document.getElementById('stageCreateForm');
    if(!form && currentPage==='pipeline' && pipelineViewMode==='analysis') { pipelineViewMode='board'; render(); form=document.getElementById('stageCreateForm'); }
    if(!form)return;
    form.style.display=form.style.display==='block'?'none':'block';
    if(form.style.display==='block')document.getElementById('newStageName')?.focus();
  };
  window.createPipelineStageFromBoard = async function(event) {
    event.preventDefault();
    if(currentUser?.role!=='admin'){showToast('Somente o administrador pode criar colunas.');return;}
    const name=document.getElementById('newStageName')?.value?.trim();
    const stage_type=document.getElementById('newStageType')?.value||'open';
    const probability=stage_type==='won'?100:stage_type==='lost'?0:Number(document.getElementById('newStageProbability')?.value||0);
    const pipelineId=Number(state.pipelines?.find(p=>p.is_default)?.id||state.pipelines?.[0]?.id);
    if(!name){showToast('Informe o nome da nova coluna.');return;}
    if(!pipelineId){showToast('Não há um funil ativo configurado.');return;}
    try {
      await api('pipeline-stages','POST',{name,pipeline_id:pipelineId,probability,stage_type});
      await loadRemoteState(); render(); showToast(`Coluna “${name}” criada.`);
    } catch(e) { showToast(e.message||'Não foi possível criar a coluna. Se necessário, execute a migração SQL incluída no pacote.'); }
  };

  function normalizePipelineSearch(value) {
    return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9@.+\s-]/g,' ').replace(/\s+/g,' ').trim().slice(0,100);
  }
  function editDistanceLimitOne(a,b) {
    if(Math.abs(a.length-b.length)>1)return false;
    if(a===b)return true;
    let i=0,j=0,edits=0;
    while(i<a.length&&j<b.length){
      if(a[i]===b[j]){i++;j++;continue;}
      if(++edits>1)return false;
      if(a.length>b.length)i++;else if(b.length>a.length)j++;else{i++;j++;}
    }
    if(i<a.length||j<b.length)edits++;
    return edits<=1;
  }
  function pipelineDealMatchScore(deal, query) {
    const q=normalizePipelineSearch(query);
    if(!q)return 0;
    const fields=[
      {text:normalizePipelineSearch(deal.title),weight:1.5,label:'oportunidade'},
      {text:normalizePipelineSearch(deal.contact),weight:1.25,label:'contato'},
      {text:normalizePipelineSearch(deal.company),weight:1.1,label:'empresa'},
      {text:normalizePipelineSearch(deal.owner),weight:.75,label:'responsável'},
      {text:normalizePipelineSearch(deal.stage),weight:.6,label:'etapa'}
    ].filter(f=>f.text);
    let total=0,matched=0;
    for(const token of q.split(' ').filter(Boolean)){
      let best=0;
      for(const field of fields){
        let score=0;
        if(field.text===token)score=36;
        else if(field.text.startsWith(token))score=28;
        else if(field.text.includes(token))score=21;
        const words=field.text.split(/\s+/);
        for(const word of words){
          if(word===token)score=Math.max(score,30);
          else if(word.startsWith(token))score=Math.max(score,22);
          else if(word.includes(token))score=Math.max(score,14);
          else if(token.length>=4&&word.length>=4&&editDistanceLimitOne(word,token))score=Math.max(score,10);
        }
        best=Math.max(best,score*field.weight);
      }
      if(best>0){matched++;total+=best;}
    }
    if(!matched)return 0;
    return total * (matched/q.split(' ').filter(Boolean).length);
  }
  function getPipelineSearchMatches(query) {
    if(!String(query||'').trim())return [];
    return (state.deals||[]).map(deal=>({deal,score:pipelineDealMatchScore(deal,query)}))
      .filter(row=>row.score>0).sort((a,b)=>b.score-a.score || String(a.deal.title||'').localeCompare(String(b.deal.title||''),'pt-BR'))
      .slice(0,6).map(row=>row.deal);
  }
  function pipelineSearchMatchesMarkup(query) {
    if(!String(query||'').trim())return '';
    const matches=getPipelineSearchMatches(query);
    if(!matches.length)return `<section id="pipelineSearchPreview" class="pipeline-search-matches is-empty"><div class="pipeline-search-heading"><strong>Nenhuma correspondência próxima</strong><span>O funil completo continua visível abaixo.</span></div></section>`;
    return `<section id="pipelineSearchPreview" class="pipeline-search-matches"><div class="pipeline-search-heading"><strong>Resultados parecidos com “${esc(query)}”</strong><span>${matches.length} sugestão(ões) · os outros cards continuam visíveis</span></div><div class="pipeline-search-match-list">${matches.map(d=>`<button type="button" class="pipeline-search-match" onclick="openModal('deal',${Number(d.id)})"><span class="search-match-icon">${ico('target',14)}</span><span class="search-match-copy"><strong>${esc(d.title||'Oportunidade sem título')}</strong><small>${esc(d.contact||d.company||'Contato não informado')} · ${esc(d.stage||'Etapa não informada')}</small></span><span class="search-match-owner">${esc(d.owner||'Sem responsável')}</span><span class="search-match-value">${money(d.value)}</span></button>`).join('')}</div></section>`;
  }
  function stageAgeText(deal) {
    const age=dealStageAgeMeta(deal);
    if(age.days===null)return 'Tempo na etapa não registrado';
    return `${age.estimated?'Aproximadamente ':''}${age.days} dia(s) nesta etapa`;
  }
  function renderPipelineAnalysis(deals, stages) {
    const open=deals.filter(dealIsOpen);
    const staleStage=open.filter(d=>dealStageAgeMeta(d).stale);
    const criticalContact=open.filter(d=>dealLastContactMeta(d).tone==='critical');
    const unknownContact=open.filter(d=>dealLastContactMeta(d).tone==='unknown');
    const overdue=open.filter(dealHasOverdueTask);
    const noNext=open.filter(d=>!dealHasNextStep(d));
    const totalOpenValue=open.reduce((sum,d)=>sum+(Number(d.value)||0),0);
    const stageStats=stages.map(stage=>({stage,items:deals.filter(d=>Number(d.stage_id)===Number(stage.id)),value:deals.filter(d=>Number(d.stage_id)===Number(stage.id)).reduce((sum,d)=>sum+(Number(d.value)||0),0)}));
    const maxCount=Math.max(1,...stageStats.map(x=>x.items.length));
    const ranked=open.map(deal=>({deal,risk:dealRiskMeta(deal)})).sort((a,b)=>b.risk.score-a.risk.score || Number(b.deal.value||0)-Number(a.deal.value||0)).slice(0,8);
    return `<section class="pipeline-analysis">
      <div class="pipeline-analysis-summary"><div class="pipeline-metric"><span>Em andamento</span><strong>${open.length}</strong><small>${money(totalOpenValue)} em valor nominal</small></div><div class="pipeline-metric ${staleStage.length?'attention':''}"><span>Paradas na etapa · 7+ dias</span><strong>${staleStage.length}</strong><small>Oportunidades sem mudança de etapa</small></div><div class="pipeline-metric ${overdue.length?'critical':''}"><span>Retornos vencidos</span><strong>${overdue.length}</strong><small>Há tarefa aberta fora do prazo</small></div><div class="pipeline-metric ${criticalContact.length?'critical':''}"><span>Contato atrasado · 16+ dias</span><strong>${criticalContact.length}</strong><small>${unknownContact.length} sem histórico de interação registrado</small></div><div class="pipeline-metric ${noNext.length?'attention':''}"><span>Sem próxima ação</span><strong>${noNext.length}</strong><small>Negócios abertos sem retorno futuro agendado</small></div></div>
      <div class="pipeline-analysis-grid"><section class="card pipeline-analysis-panel"><div class="card-head"><div><div class="card-title">Distribuição por etapa</div><div class="card-sub">Volume e valor nominal de cada coluna</div></div></div><div class="pipeline-stage-analysis">${stageStats.map(x=>`<div class="pipeline-stage-row"><div class="pipeline-stage-label"><strong>${esc(x.stage.name)}</strong><span>${x.items.length} · ${money(x.value)}</span></div><div class="pipeline-analysis-track"><i style="width:${Math.round(x.items.length/maxCount*100)}%"></i></div></div>`).join('')||'<div class="empty">Nenhuma etapa configurada.</div>'}</div></section>
      <section class="card pipeline-analysis-panel"><div class="card-head"><div><div class="card-title">Ações recomendadas</div><div class="card-sub">Ordenadas por risco de estagnação e retorno atrasado</div></div></div><div class="pipeline-priority-list">${ranked.map(({deal,risk})=>`<button type="button" class="pipeline-priority-item" onclick="openModal('deal',${Number(deal.id)})"><span class="priority-mark ${risk.score>=75?'critical':risk.score>=30?'warning':'good'}"></span><span class="priority-copy"><strong>${esc(deal.title)}</strong><small>${esc(deal.contact||deal.company||'Sem contato associado')} · ${esc(deal.stage||'')}</small><span>${risk.flags.slice(0,2).map(f=>`<i class="priority-flag ${f.tone}">${esc(f.label)}</i>`).join('')||'<i class="priority-flag good">Acompanhamento em dia</i>'}</span></span><span class="priority-value">${money(deal.value)}</span></button>`).join('')||'<div class="empty">Nenhuma oportunidade aberta. Crie um negócio para ver as próximas ações.</div>'}</div></section></div>
      <p class="pipeline-analysis-note">Os alertas usam a data da última interação registrada, tarefas abertas e o tempo nesta etapa. Nas oportunidades antigas, o tempo na etapa pode aparecer como estimativa até o primeiro movimento registrado após a atualização.</p>
    </section>`;
  }
  window.setPipelineViewMode = function(mode) {
    pipelineViewMode=mode==='analysis'?'analysis':'board';
    render();
  };
  window.pipelinePage = function () {
    const allDeals=(state.deals||[]).slice();
    const pipelineId=Number(state.pipelines?.find(p=>p.is_default)?.id||state.pipelines?.[0]?.id||0);
    const stages=(state.pipelineStages||[]).filter(s=>!pipelineId||Number(s.pipeline_id)===pipelineId).slice().sort((a,b)=>a.position-b.position);
    const deals=allDeals.filter(d=>!pipelineId||Number(d.pipeline_id)===pipelineId);
    const canManage=currentUser?.role==='admin';
    const columns=stages.map(s=>{
      const ds=deals.filter(d=>Number(d.stage_id)===Number(s.id));
      const total=ds.reduce((a,d)=>a+(Number(d.value)||0),0);
      const testCards=blankTestCards.filter(c=>Number(c.stage_id)===Number(s.id)).map(c=>window.blankTestDealCard(c)).join('');
      return `<section class="stage-column" data-stage-column="${s.id}"><div class="stage-head"><strong title="${esc(s.name)}">${esc(s.name)}</strong><span class="stage-summary">${ds.length} · ${money(total)}</span></div><div class="stage-cards" data-stage-dropzone="${s.id}" ondragover="allowDealDrop(event)" ondragleave="leaveDealDrop(event)" ondrop="dropDeal(event,${s.id})">${ds.map(dealCard).join('')}${testCards}</div><button class="btn small ghost stage-add-deal" style="margin:0 8px 8px;width:calc(100% - 16px);justify-content:center" onclick="openModal('deal',null,${Number(s.id)})">${ico('plus',13)} Adicionar oportunidade</button></section>`;
    }).join('');
    const controls=`<div class="pipeline-toolbar"><label class="search-box pipeline-search-box">${ico('search')}<input id="pipelineSearchInput" placeholder="Buscar oportunidade, contato ou responsável…" value="${esc(pipelineSearchQuery)}" oninput="searchPipeline(this.value)" autocomplete="off"></label><div class="pipeline-view-toggle" role="group" aria-label="Visualização do funil"><button type="button" class="${pipelineViewMode==='board'?'active':''}" aria-pressed="${pipelineViewMode==='board'}" onclick="setPipelineViewMode('board')">${ico('git-branch',13)} Funil</button><button type="button" class="${pipelineViewMode==='analysis'?'active':''}" aria-pressed="${pipelineViewMode==='analysis'}" onclick="setPipelineViewMode('analysis')">${ico('chart',13)} Análise</button></div><span id="pipelineOpportunityCount" class="pipeline-opportunity-count">${deals.length} oportunidade(s)</span></div>${pipelineSearchMatchesMarkup(pipelineSearchQuery)}`;
    const stageCreator=`<form id="stageCreateForm" class="stage-create-form" onsubmit="createPipelineStageFromBoard(event)"><div style="font-weight:700;font-size:13px;margin-bottom:12px">Criar nova coluna</div><div class="stage-create-grid"><div class="stage-name-field"><label for="newStageName">Nome da coluna</label><input id="newStageName" maxlength="80" placeholder="Ex.: Aguardando retorno" required></div><div><label for="newStageProbability">Probabilidade (%)</label><input id="newStageProbability" type="number" min="0" max="100" value="20"></div><div><label for="newStageType">Tipo da etapa</label><select id="newStageType"><option value="open">Em andamento</option><option value="won">Negócio ganho</option><option value="lost">Negócio perdido</option></select></div><button class="btn primary" type="submit">${ico('plus',14)} Criar coluna</button></div><p class="form-help">A coluna será salva no Supabase e ficará disponível para toda a instalação.</p></form>`;
    const board=`<div class="pipeline-board">${columns||'<div class="empty"><strong>Nenhuma coluna configurada</strong>Crie uma coluna para começar.</div>'}</div><div class="deal-recency-legend pipeline-legend-below"><span><i class="legend-dot good"></i>0–6 dias</span><span><i class="legend-dot warning"></i>7–15 dias</span><span><i class="legend-dot critical"></i>Mais de 15 dias</span><span><i class="legend-dot unknown"></i>Sem interação registrada</span><span class="legend-overdue">⌛ Retorno vencido = tarefa aberta fora do prazo</span><span class="legend-stage-age">Etapa parada: 7+ dias</span></div><p class="stage-move-hint">O indicador usa contatos registrados no histórico (ligação, reunião, e-mail ou retorno concluído). Ter um contato associado ao card não basta. A idade das etapas antigas pode ser estimada; o card de teste não entra nos indicadores.</p><div class="card pipeline-open-total"><span class="stat-icon">${ico('target')}</span><div class="pipeline-open-total-copy"><div class="card-title">Valor em aberto</div><div class="card-sub">Soma nominal das oportunidades que não foram ganhas ou perdidas.</div></div><strong>${money(deals.filter(dealIsOpen).reduce((a,d)=>a+(Number(d.value)||0),0))}</strong></div>`;
    const actions=(pipelineViewMode==='board'?button('Card vazio (teste)','addBlankTestCard()',false,'plus'):'')+(canManage?button('Nova coluna','toggleStageCreator()',false,'plus'):'')+button('Nova oportunidade',"openModal('deal')",true,'target');
    return `${pageHeader('OPORTUNIDADES','Pipeline comercial','Acompanhe as oportunidades, identifique riscos e priorize o próximo contato.',actions)}${controls}${canManage&&pipelineViewMode==='board'?stageCreator:''}${pipelineViewMode==='analysis'?renderPipelineAnalysis(deals,stages):board}`;
  };
  window.tasksPage = function () {
    const tasks=(state.tasks||[]).filter(t=>taskFilter==='Todas'||(taskFilter==='Pendentes'?t.status!=='Concluída'&&t.status!=='Cancelada':taskFilter==='Concluídas'?t.status==='Concluída':t.date && t.date<new Date().toISOString().slice(0,10)&&t.status!=='Concluída'));
    return `${pageHeader('ROTINA COMERCIAL','Tarefas','Organize retornos, ligações e reuniões.',button('Nova tarefa',"openModal('task')",true,'plus'))}<section class="card"><div class="card-head"><div><div class="card-title">Lista de tarefas</div><div class="card-sub">As alterações são salvas no Supabase.</div></div><div style="text-align:right"><div style="font-size:20px;font-weight:750">${state.tasks.filter(t=>t.status!=='Concluída'&&t.status!=='Cancelada').length}</div><div style="font-size:10px;color:var(--muted)">pendentes</div></div></div><div style="padding:0 19px 14px"><div class="task-status-tabs">${['Todas','Pendentes','Concluídas','Atrasadas'].map(x=>`<button class="${taskFilter===x?'active':''}" onclick="setTaskFilter('${x}')">${x}</button>`).join('')}</div></div><div style="padding:0 19px 10px"><div class="task-row" style="border-top:1px solid #282c30;color:#747c82;font-size:10px;text-transform:uppercase;letter-spacing:.08em"><div></div><div>Tarefa / vínculo</div><div class="task-owner">Responsável</div><div>Prazo</div><div class="task-priority">Prioridade</div><div></div></div>${tasks.map(taskPageRow).join('')||'<div class="empty"><strong>Nenhuma tarefa por aqui</strong>Crie uma tarefa para organizar os próximos passos.</div>'}</div></section>`;
  };
  window.activitiesPage = function () {
    return `${pageHeader('HISTÓRICO','Atividades','Histórico registrado no servidor.',button('Registrar atividade',"openModal('activity')",true,'plus'))}<section class="card"><div class="card-head"><div><div class="card-title">Linha do tempo</div><div class="card-sub">Interações e notas comerciais</div></div></div><div class="activity-list">${state.activities.map(activityItem).join('')||'<div class="empty">Nenhuma atividade registrada.</div>'}</div></section>`;
  };
  window.reportsPage = function () {
    const deals=state.deals||[], contacts=state.contacts||[];
    const stageForDeal=d=>(state.pipelineStages||[]).find(st=>Number(st.id)===Number(d.stage_id));
    const won=deals.filter(d=>Boolean(stageForDeal(d)?.is_won ?? d.is_won));
    const lost=deals.filter(d=>Boolean(stageForDeal(d)?.is_lost ?? d.is_lost));
    const opened=deals.filter(d=>!Boolean(stageForDeal(d)?.is_won ?? d.is_won)&&!Boolean(stageForDeal(d)?.is_lost ?? d.is_lost));
    const wonTotal=won.reduce((s,d)=>s+d.value,0), openTotal=opened.reduce((s,d)=>s+d.value,0);
    const stages=(state.pipelineStages||[]).slice().sort((a,b)=>a.position-b.position);
    const sources={}; contacts.forEach(c=>{const k=c.source||'Não informado';sources[k]=(sources[k]||0)+1;});
    const sourceRows=Object.entries(sources).sort((a,b)=>b[1]-a[1]).map(([name,count])=>`<div class="source-row"><span>${esc(name)}</span><div class="source-track"><i style="width:${contacts.length?count/contacts.length*100:0}%"></i></div><b>${count}</b></div>`).join('')||'<div class="empty">Os canais aparecerão após cadastrar contatos.</div>';
    return `${pageHeader('INTELIGÊNCIA COMERCIAL','Relatórios','Indicadores calculados a partir dos seus registros.',button('Exportar oportunidades',"exportCSV('deals')",false,'download'))}<div class="stats">${liveStat('Negócios ganhos',won.length,'check','Etapa de ganho')}${liveStat('Valor ganho',money(wonTotal),'money','Valor dos negócios ganhos')}${liveStat('Valor em aberto',money(openTotal),'target','Oportunidades em andamento')}${liveStat('Negócios perdidos',lost.length,'note','Etapa de perda')}</div><div class="report-grid"><section class="card"><div class="card-head"><div><div class="card-title">Oportunidades por etapa</div><div class="card-sub">Quantidade em cada etapa do funil</div></div></div><div style="padding:4px 20px 18px">${stages.map(s=>{const n=deals.filter(d=>Number(d.stage_id)===Number(s.id)).length;const pct=deals.length?n/deals.length*100:0;return `<div class="pipeline-row" style="grid-template-columns:100px minmax(30px,1fr) 25px"><span class="pipeline-name">${esc(s.name)}</span><div class="pipeline-bar"><div class="pipeline-fill" style="width:${pct}%"></div></div><span class="pipeline-count">${n}</span></div>`}).join('')||'<div class="empty">Nenhuma etapa configurada.</div>'}</div></section><section class="card"><div class="card-head"><div><div class="card-title">Origem dos contatos</div><div class="card-sub">Distribuição por canal registrado</div></div></div><div style="padding:0 20px 20px">${sourceRows}</div></section><section class="card"><div class="card-head"><div><div class="card-title">Resumo</div><div class="card-sub">Valores do banco de dados</div></div></div><div style="padding:0 20px 20px"><div class="stat-note">Contatos ativos</div><div style="font-size:25px;font-weight:750;margin:6px 0 18px">${contacts.filter(c=>c.status!=='Inativo').length}</div><div class="panel-divider" style="padding-top:15px;display:flex;justify-content:space-between;font-size:11px;color:var(--muted)"><span>Oportunidades registradas</span><b style="color:white">${deals.length}</b></div><div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);padding-top:13px"><span>Taxa de ganho sobre encerradas</span><b style="color:white">${won.length+lost.length?Math.round(won.length/(won.length+lost.length)*100)+'%':'—'}</b></div></div></section></div>`;
  };

  function selectMarkup(name, options, selected='', placeholder='Selecione') {
    return `<select name="${esc(name)}"><option value="">${esc(placeholder)}</option>${options.map(o=>`<option value="${esc(o.value)}" ${String(o.value)===String(selected)?'selected':''}>${esc(o.label)}</option>`).join('')}</select>`;
  }
  function formField(label,name,control,full=false) { return `<div class="form-field ${full?'field-full':''}"><label>${esc(label)}</label>${control}</div>`; }
  function inputMarkup(name,value='',type='text',placeholder='') { return `<input name="${esc(name)}" type="${type}" value="${esc(value??'')}" placeholder="${esc(placeholder)}">`; }
  function textareaMarkup(name,value='',placeholder='') { return `<textarea name="${esc(name)}" placeholder="${esc(placeholder)}">${esc(value||'')}</textarea>`; }
  function ownerOptions() { return (state.users||[]).filter(u=>Number(u.is_active)!==0).map(u=>({value:u.id,label:u.name+(u.role==='admin'?' · Admin':u.role==='manager'?' · Gerente':'')})); }
  function contactsOptions() { return (state.contacts||[]).map(c=>({value:c.id,label:c.name+(c.company?' — '+c.company:'')})); }

  window.openModal = function(type,id=null,stage=null) {
    modalType=type; editingId=id;
    const arr={contact:state.contacts,deal:state.deals,task:state.tasks,activity:state.activities,user:state.users}[type]||[];
    const item=id?arr.find(x=>Number(x.id)===Number(id)):null;
    let title='',subtitle='',fields='';
    const ownerSelected=item?.owner_id || item?.assigned_to || currentUser?.id || '';
    const ownerControl=selectMarkup('owner_id',ownerOptions(),ownerSelected,'Selecione o responsável');
    const contactControl=selectMarkup('contact_id',contactsOptions(),item?.contact_id||'','Selecione um contato');
    if(type==='contact') {
      title=item?'Editar contato':'Novo contato'; subtitle='Os dados serão gravados no banco Supabase.';
      fields=`<div class="form-grid">${formField('Nome completo *','name',inputMarkup('name',item?.name||'','text','Nome do contato'))}${formField('Empresa','company',inputMarkup('company',item?.company||'','text','Empresa'))}${formField('E-mail','email',inputMarkup('email',item?.email||'','email','nome@empresa.com.br'))}${formField('Telefone','phone',inputMarkup('phone',item?.phone||'','tel','Telefone'))}${formField('Status','status',selectMarkup('status',['Novo lead','Qualificado','Em negociação','Cliente','Inativo'].map(x=>({value:x,label:x})),item?.status||'Novo lead'))}${formField('Responsável','owner_id',ownerControl)}${formField('Origem','source',selectMarkup('source',['Site','Indicação','LinkedIn','Evento','Importação','Outro'].map(x=>({value:x,label:x})),item?.source||'','Selecione a origem'))}${formField('Observações','notes',textareaMarkup('notes',item?.notes||'','Observações relevantes'),true)}</div>`;
    } else if(type==='deal') {
      title=item?'Editar oportunidade':'Nova oportunidade'; subtitle='Associe um contato e escolha o responsável. A etapa é definida pela coluna do funil.';
      const pipelineId=item?.pipeline_id || state.pipelines?.find(p=>Number(p.is_default)===1)?.id || state.pipelines?.[0]?.id || '';
      const stageOptions=(state.pipelineStages||[]).filter(s=>!pipelineId||Number(s.pipeline_id)===Number(pipelineId)).map(s=>({value:s.id,label:s.name}));
      // A etapa é selecionável no formulário de criação/edição; não há seletor duplicado dentro do card.
      const stageFromCaller=stageOptions.find(s=>String(s.value)===String(stage)) || stageOptions.find(s=>s.label===String(stage));
      const selectedStage=item?.stage_id || stageFromCaller?.value || stageOptions.find(s=>!((state.pipelineStages||[]).find(st=>Number(st.id)===Number(s.value))?.is_won || (state.pipelineStages||[]).find(st=>Number(st.id)===Number(s.value))?.is_lost))?.value || stageOptions[0]?.value || '';
      const retainedValue = item ? (item.value ?? 0) : 0;
      const retainedClose = item ? (item.close || item.expected_close_date || '') : '';
      fields=`<div class="form-grid">${formField('Nome da oportunidade *','title',inputMarkup('title',item?.title||'','text','Ex.: Projeto de expansão'))}${formField('Contato principal *','contact_id',contactControl,true)}${formField('Etapa do funil *','stage_id',selectMarkup('stage_id',stageOptions,selectedStage,'Selecione a etapa'))}${formField('Responsável','owner_id',ownerControl)}${formField('Descrição','description',textareaMarkup('description',item?.description||'','Detalhes da oportunidade'),true)}${formField('Motivo da perda','lost_reason',inputMarkup('lost_reason',item?.lost_reason||'','text','Preencha se perdido'),true)}<input type="hidden" name="value" value="${esc(retainedValue)}"><input type="hidden" name="expected_close_date" value="${esc(retainedClose)}"></div>${!state.contacts.length?'<p class="form-help">Cadastre um contato antes de criar uma oportunidade.</p>':''}<p class="form-help">O valor e a previsão de fechamento são preservados, mas não precisam ser preenchidos aqui. Você pode escolher a etapa no formulário ou arrastar o card no funil.</p>`;
    } else if(type==='task') {
      title=item?'Editar tarefa':'Nova tarefa'; subtitle='Defina o próximo passo e salve para a equipe.';
      const statusOpts=['Pendente','Em andamento','Concluída','Cancelada'].map(x=>({value:x,label:x}));
      const typeOpts=['Tarefa','Ligação','E-mail','Reunião','Retorno'].map(x=>({value:x,label:x}));
      const priorityOpts=['Baixa','Média','Alta'].map(x=>({value:x,label:x}));
      const today=new Date().toISOString().slice(0,10);
      fields=`<div class="form-grid">${formField('Título *','title',inputMarkup('title',item?.title||'','text','Ex.: Retornar contato'))}${formField('Tipo','type',selectMarkup('type',typeOpts,item?.type||'Tarefa'))}${formField('Contato relacionado','contact_id',selectMarkup('contact_id',[{value:'',label:'Sem contato'},...contactsOptions()],item?.contact_id||'','Sem contato'))}${formField('Responsável','assigned_to',selectMarkup('assigned_to',ownerOptions(),item?.assigned_to||currentUser?.id||'','Selecione responsável'))}${formField('Data','date',inputMarkup('date',item?.date||today,'date'))}${formField('Horário','time',inputMarkup('time',item?.time||'09:00','time'))}${formField('Prioridade','priority',selectMarkup('priority',priorityOpts,item?.priority||'Média'))}${formField('Status','status',selectMarkup('status',statusOpts,item?.status||'Pendente'))}${formField('Descrição','description',textareaMarkup('description',item?.description||'','Detalhes da tarefa'),true)}</div>`;
    } else if(type==='activity') {
      title='Registrar atividade'; subtitle='Registre uma interação ou observação no histórico.';
      fields=`<div class="form-grid">${formField('Título *','title',inputMarkup('title','','text','Ex.: Ligação de acompanhamento'))}${formField('Tipo','type',selectMarkup('type',['note','call','meeting','email','stage_change','status_change','other'].map(x=>({value:x,label:({note:'Nota',call:'Ligação',meeting:'Reunião',email:'E-mail',stage_change:'Mudança de etapa',status_change:'Mudança de status',other:'Outro'})[x]})),'note'))}${formField('Contato relacionado','contact_id',selectMarkup('contact_id',[{value:'',label:'Sem contato'},...contactsOptions()],'','Sem contato'))}${formField('Descrição','body',textareaMarkup('body','','O que aconteceu?'),true)}</div><p class="form-help">Para atualizar o indicador de contato do funil, registre uma Ligação, Reunião ou E-mail. Uma Nota genérica não conta como interação.</p>`;
    } else if(type==='user') {
      title='Novo usuário'; subtitle='Crie um acesso para alguém da equipe. Use uma senha forte.';
      fields=`<div class="form-grid">${formField('Nome *','name',inputMarkup('name','','text','Nome completo'))}${formField('E-mail *','email',inputMarkup('email','','email','usuario@empresa.com.br'))}${formField('Senha * (12 caracteres ou mais)','password',inputMarkup('password','','password','Senha inicial'))}${formField('Perfil','role',selectMarkup('role',[{value:'sales',label:'Vendedor'},{value:'manager',label:'Gerente'},{value:'admin',label:'Administrador'}],'sales'))}</div>`;
    }
    document.getElementById('modalTitle').textContent=title; document.getElementById('modalSubtitle').textContent=subtitle;
    document.getElementById('modalBody').innerHTML=fields; document.getElementById('modalSubmit').textContent=item?'Salvar alterações':'Salvar';
    const foot=document.querySelector('.modal-foot'); let del=document.getElementById('nexoDeleteRecord'); if(del)del.remove();
    if(item && ['contact','deal','task'].includes(type)) { del=document.createElement('button');del.id='nexoDeleteRecord';del.type='button';del.className='btn ghost';del.textContent='Arquivar';del.onclick=deleteCurrentRecord;foot.insertBefore(del,foot.firstChild); }
    document.getElementById('modalBackdrop').classList.add('open'); setTimeout(()=>document.querySelector('#modalBody input, #modalBody select, #modalBody textarea')?.focus(),80);
  };

  async function logActivity(title, body='', type='note', contactId=null, dealId=null) {
    try { await api('activities','POST',{title,body,type,contact_id:contactId,deal_id:dealId}); } catch(e) { console.warn('Não foi possível registrar o histórico:',e.message); }
  }
  window.submitModal = async function(e) {
    e.preventDefault(); if(isSubmitting)return; isSubmitting=true;
    const form=e.target, d=Object.fromEntries(new FormData(form).entries());
    const submit=document.getElementById('modalSubmit'); const prior=submit.textContent; submit.disabled=true; submit.textContent='Salvando...';
    try {
      if(modalType==='contact') {
        if(!d.name?.trim()) throw new Error('Informe o nome do contato.');
        const payload={name:d.name.trim(),company_name:d.company||null,email:d.email||null,phone:d.phone||null,status:statusToApi[d.status]||'lead',owner_id:Number(d.owner_id)||Number(currentUser.id),source:d.source||null,notes:d.notes||null};
        const result=editingId?await api('contacts','PUT',{...payload,id:editingId}):await api('contacts','POST',payload);
        const id=editingId||result.id; await logActivity(editingId?'Contato atualizado':'Novo contato cadastrado',d.name,'note',id,null);
        showToast(editingId?'Contato atualizado.':'Contato cadastrado.');
      } else if(modalType==='deal') {
        if(!d.title?.trim()||!d.contact_id) throw new Error('Informe o título da oportunidade e selecione um contato.');
        const pipelineId=Number(state.pipelines?.find(p=>Number(p.is_default)===1)?.id||state.pipelines?.[0]?.id);
        const selectedStage=(state.pipelineStages||[]).find(s=>Number(s.id)===Number(d.stage_id));
        if(!pipelineId||!selectedStage) throw new Error('O funil de vendas não está configurado. Confira as etapas do banco.');
        const previousDeal=editingId?(state.deals||[]).find(x=>Number(x.id)===Number(editingId)):null;
        const previousStageId=previousDeal?Number(previousDeal.stage_id):null;
        const payload={title:d.title.trim(),contact_id:Number(d.contact_id),pipeline_id:pipelineId,stage_id:Number(selectedStage.id),value:Number(d.value),description:d.description||null,owner_id:Number(d.owner_id)||Number(currentUser.id),expected_close_date:d.expected_close_date||null,lost_reason:d.lost_reason||null};
        const result=editingId?await api('deals','PUT',{...payload,id:editingId}):await api('deals','POST',payload);
        await logActivity(editingId?'Oportunidade atualizada':'Oportunidade criada',d.title,'note',Number(d.contact_id),editingId||result.id);
        if(previousDeal && previousStageId!==Number(selectedStage.id)) await logActivity('Oportunidade movida',`${d.title}: ${previousDeal.stage||'Etapa anterior'} → ${selectedStage.name}`,'stage_change',Number(d.contact_id),Number(editingId));
        showToast(editingId?'Oportunidade atualizada.':'Oportunidade criada.');
      } else if(modalType==='task') {
        if(!d.title?.trim()) throw new Error('Informe o título da tarefa.');
        const payload={title:d.title.trim(),description:d.description||null,type:taskTypeToApi[d.type]||'other',status:taskStatusToApi[d.status]||'pending',priority:priorityToApi[d.priority]||'medium',due_at:toDbDateTime(d.date,d.time),assigned_to:Number(d.assigned_to)||Number(currentUser.id),contact_id:d.contact_id?Number(d.contact_id):null};
        const result=editingId?await api('tasks','PATCH',{...payload,id:editingId}):await api('tasks','POST',payload);
        await logActivity(editingId?'Tarefa atualizada':'Tarefa criada',d.title,'note',d.contact_id?Number(d.contact_id):null,null);
        showToast(editingId?'Tarefa atualizada.':'Tarefa criada.');
      } else if(modalType==='activity') {
        if(!d.title?.trim()) throw new Error('Informe o título da atividade.');
        await api('activities','POST',{title:d.title.trim(),body:d.body||null,type:d.type||'note',contact_id:d.contact_id?Number(d.contact_id):null});
        showToast('Atividade registrada.');
      } else if(modalType==='user') {
        if(!d.name?.trim()||!d.email?.trim()||!d.password) throw new Error('Preencha nome, e-mail e senha.');
        if(d.password.length<12) throw new Error('A senha precisa ter pelo menos 12 caracteres.');
        await api('users','POST',{name:d.name.trim(),email:d.email.trim(),password:d.password,role:d.role||'sales'});
        showToast('Usuário criado.');
      }
      closeModal(); await loadRemoteState(); render();
    } catch(err) { showToast(err.message||'Não foi possível salvar o registro.'); }
    finally {isSubmitting=false;submit.disabled=false;submit.textContent=prior;}
  };

  window.deleteCurrentRecord = async function() {
    if(!editingId||!['contact','deal','task'].includes(modalType))return;
    if(!confirm('Arquivar este registro? Ele deixará de aparecer nas listas do CRM.'))return;
    const type=modalType, id=editingId;
    try { await api(type==='contact'?'contacts':type==='deal'?'deals':'tasks','DELETE',null,{id}); closeModal(); await loadRemoteState(); render(); showToast('Registro arquivado.'); }
    catch(e){showToast(e.message||'Não foi possível arquivar o registro.');}
  };
  window.toggleTask = async function(id) {
    const task=(state.tasks||[]).find(t=>Number(t.id)===Number(id)); if(!task)return;
    const next=task.status==='Concluída'?'pending':'completed';
    try { await api('tasks','PATCH',{id:Number(id),status:next}); const touchType=next==='completed'&&CONTACT_TASK_TYPES.has(String(task.raw_type||'').toLowerCase())?String(task.raw_type).toLowerCase():'note'; await logActivity(next==='completed'?'Tarefa concluída':'Tarefa reaberta',task.title,touchType,task.contact_id||null,task.deal_id||null); await loadRemoteState();render();showToast(next==='completed'?'Tarefa concluída.':'Tarefa reaberta.'); }
    catch(e){showToast(e.message||'Não foi possível atualizar a tarefa.');}
  };

  window.importCSV = async function(input) {
    const file=input.files?.[0]; if(!file)return;
    try {
      const text=await file.text();
      const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean);
      if(lines.length<2)throw new Error('O arquivo não possui linhas de dados.');
      const delimiter=lines[0].includes(';')?';':',';
      const parse=line=>{const out=[];let cur='',quoted=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'&&line[i+1]==='"'&&quoted){cur+='"';i++;}else if(ch==='"'){quoted=!quoted;}else if(ch===delimiter&&!quoted){out.push(cur.trim());cur='';}else cur+=ch;}out.push(cur.trim());return out;};
      const headers=parse(lines[0]).map(x=>x.toLowerCase());let imported=0,failed=0;
      for(const line of lines.slice(1)) { const row=parse(line);const get=(...keys)=>{const ix=headers.findIndex(h=>keys.includes(h));return ix>=0?(row[ix]||''):'';};const name=get('nome','name');if(!name)continue;
        try {await api('contacts','POST',{name,company_name:get('empresa','company')||null,email:get('e-mail','email')||null,phone:get('telefone','phone')||null,status:statusToApi[get('status')]||'lead',source:get('origem','source')||'Importação',owner_id:Number(currentUser.id),notes:null});imported++;}
        catch(e){failed++;}
      }
      await loadRemoteState();render();showToast(`${imported} contato(s) importado(s)${failed?`; ${failed} falha(s)`:''}.`);
    } catch(e){showToast(e.message||'Falha ao importar CSV.');}
    finally {input.value='';}
  };

  window.saveSettings = async function() {
    const name=document.getElementById('settingCompany')?.value?.trim();
    if(!name){showToast('Informe o nome da empresa.');return;}
    const email=document.getElementById('settingEmail')?.value||null;
    const phone=document.getElementById('settingPhone')?.value||null;
    const timezone=document.getElementById('settingTimezone')?.value||'America/Sao_Paulo';
    const currency=document.getElementById('settingCurrency')?.value||'BRL';
    let localTheme='dark',localAccent='#24466f';try{localTheme=localStorage.getItem('nexo-crm-theme')||localTheme;const storedAccent=localStorage.getItem('nexo-crm-accent');localAccent=(storedAccent&&storedAccent.toLowerCase()!=='#788d52')?storedAccent:localAccent;}catch(_){}
    try {const logo_data=pendingCompanyLogo===undefined?(companySettings?.logo_data||null):(pendingCompanyLogo||null);await api('settings','POST',{name,email,phone,timezone,currency,theme_mode:companySettings?.theme_mode||localTheme,accent_color:companySettings?.accent_color||localAccent,logo_data});pendingCompanyLogo=undefined;await loadRemoteState();render();showToast('Configurações salvas no Supabase.');}
    catch(e){showToast(e.message||'Não foi possível salvar as configurações.');}
  };
  window.setSettingsTab = function(t){activeSettings=t;render();};
  window.savePipelineStage = async function(id) {
    if(currentUser?.role!=='admin'){showToast('Somente o administrador pode editar colunas.');return;}
    const stage=(state.pipelineStages||[]).find(s=>Number(s.id)===Number(id));
    const name=document.getElementById(`stageName-${id}`)?.value?.trim();
    const stage_type=document.getElementById(`stageType-${id}`)?.value||'open';
    const probability=stage_type==='won'?100:stage_type==='lost'?0:Number(document.getElementById(`stageProbability-${id}`)?.value||0);
    if(!name){showToast('O nome da coluna não pode ficar vazio.');return;}
    try { await api('pipeline-stages','PATCH',{id:Number(id),name,probability,stage_type}); await loadRemoteState();render();showToast('Coluna atualizada.'); }
    catch(e){showToast(e.message||'Não foi possível atualizar a coluna. Confira a migração do Supabase.');}
  };
  window.deletePipelineStage = async function(id) {
    const stage=(state.pipelineStages||[]).find(s=>Number(s.id)===Number(id));
    if(!stage)return;
    if(currentUser?.role!=='admin'){showToast('Somente o administrador pode excluir colunas.');return;}
    if(!confirm(`Excluir a coluna “${stage.name}”? Ela precisa estar vazia.`))return;
    try { await api('pipeline-stages','DELETE',null,{id:Number(id)}); await loadRemoteState();render();showToast('Coluna excluída.'); }
    catch(e){showToast(e.message||'Não foi possível excluir a coluna.');}
  };
  window.settingsPage = function() {
    const name=companySettings?.name||'';const email=companySettings?.email||'';const phone=companySettings?.phone||'';const timezone=companySettings?.timezone||'America/Sao_Paulo';const currency=companySettings?.currency||'BRL';
    let localTheme='dark',localAccent='#24466f';try{localTheme=localStorage.getItem('nexo-crm-theme')||localTheme;const storedAccent=localStorage.getItem('nexo-crm-accent');localAccent=(storedAccent&&storedAccent.toLowerCase()!=='#788d52')?storedAccent:localAccent;}catch(_){}
    const theme=companySettings?.theme_mode||localTheme;const accent=cleanHex(companySettings?.accent_color||localAccent);
    const canManage=currentUser?.role==='admin';
    let contents='';
    if(activeSettings==='aparencia') {
      const swatches=appearancePresets.map(c=>`<button type="button" class="theme-swatch ${accent.toLowerCase()===c.hex?'selected':''}" style="--swatch:${c.hex};background:${c.hex}" title="${esc(c.name)} · ${c.hex}" aria-label="${esc(c.name)} ${c.hex}" aria-pressed="${accent.toLowerCase()===c.hex}" onclick="chooseNexoAccent('${c.hex}')"><span class="theme-swatch-check" aria-hidden="true">✓</span></button>`).join('');
      contents=`<h3 class="settings-section-title">Aparência do NEXO</h3><p class="settings-section-desc">Escolha a cor de destaque e alterne entre o modo escuro e o modo branco. A visualização muda imediatamente.</p><div class="form-field" style="max-width:360px"><label for="settingThemeMode">Tema</label><select id="settingThemeMode" onchange="previewNexoAppearance()"><option value="dark" ${theme==='dark'?'selected':''}>Modo escuro</option><option value="light" ${theme==='light'?'selected':''}>Modo branco (claro)</option></select></div><div class="theme-control"><div><label for="settingAccentColor" style="display:block;font-size:11px;color:var(--muted);margin-bottom:6px">Escolha qualquer cor</label><div class="theme-wheel-wrap"><input id="settingAccentColor" type="color" value="${accent}" oninput="previewNexoAppearance()" aria-label="Abrir seletor de cores"><span id="accentHexValue">${accent.toUpperCase()}</span></div><p class="form-help">Clique no círculo para abrir o seletor de cores completo.</p></div><div class="theme-palette-side"><div style="font-size:11px;font-weight:700">Paleta rápida · 32 cores</div><p class="form-help">Inclui azul-escuro padrão e verde militar.</p><div class="theme-swatches">${swatches}</div></div></div><div class="appearance-preview"><div class="appearance-preview-mark"><svg viewBox="0 0 40 40" width="26" height="26"><path d="M7 8h8.5L25 22V8h8v24h-8L15 18v14H7z" fill="currentColor"/></svg></div><div style="flex:1"><strong style="display:block">Prévia NEXO CRM</strong><span class="card-sub">Esta é a combinação de cores selecionada.</span></div><button class="btn primary small" type="button" onclick="previewNexoAppearance()">Aplicar prévia</button></div>${canManage?button('Salvar aparência para a empresa','saveNexoAppearance()',true,'check'):'<p class="form-help">Apenas um administrador pode salvar a aparência para toda a empresa. O tema da prévia ficará neste navegador.</p>'}<p class="form-help" style="margin-top:12px">A preferência é aplicada imediatamente neste navegador. Ao salvar, ela será compartilhada com os usuários desta instalação.</p>`;
    } else if(activeSettings==='empresa') {
      contents=`<h3 class="settings-section-title">Dados da empresa</h3><p class="settings-section-desc">Identidade visual e informações da empresa vinculada a esta instalação.</p><div class="company-logo-field"><div class="company-logo-preview" id="companyLogoPreview">${companyLogoPreviewMarkup()}</div><div class="company-logo-controls"><label for="settingLogoFile" style="font-size:11px;font-weight:750">Logo da empresa</label><input id="settingLogoFile" type="file" accept="image/png,image/jpeg,image/webp" onchange="previewCompanyLogo(this)"><span class="company-logo-preview-note">PNG, JPG ou WebP. Máximo de 5 MB. A imagem é reduzida no navegador antes de ser armazenada como configuração da empresa.</span><div><button class="btn ghost small" type="button" onclick="removeCompanyLogo()">Remover logo</button></div></div></div><div class="form-grid"><div class="form-field"><label>Nome da empresa</label><input id="settingCompany" value="${esc(name)}" placeholder="Sua empresa" oninput="updateCompanyInitialPreview(this.value)"></div><div class="form-field"><label>E-mail de contato</label><input id="settingEmail" type="email" value="${esc(email)}" placeholder="contato@empresa.com.br"></div><div class="form-field"><label>Telefone</label><input id="settingPhone" value="${esc(phone)}" placeholder="Telefone comercial"></div><div class="form-field"><label>Fuso horário</label><select id="settingTimezone"><option value="America/Sao_Paulo" ${timezone==='America/Sao_Paulo'?'selected':''}>America/Sao_Paulo</option><option value="UTC" ${timezone==='UTC'?'selected':''}>UTC</option></select></div><div class="form-field"><label>Moeda</label><select id="settingCurrency"><option value="BRL" ${currency==='BRL'?'selected':''}>Real brasileiro (BRL)</option><option value="USD" ${currency==='USD'?'selected':''}>Dólar americano (USD)</option><option value="EUR" ${currency==='EUR'?'selected':''}>Euro (EUR)</option></select></div></div><div style="margin-top:20px">${button('Salvar alterações','saveSettings()',true,'check')}</div>`;
    } else if(activeSettings==='usuarios') {
      contents=`<h3 class="settings-section-title">Usuários e acesso</h3><p class="settings-section-desc">Acesso à instalação e perfil de cada integrante.</p>${canManage?`<div style="margin-bottom:15px"><p class="form-help">Para adicionar pessoas: Supabase → Authentication → Users → Add user. O perfil será criado automaticamente pelo banco. Não habilite cadastro público nesta instalação.</p></div>`:''}<div class="table-scroll"><table class="user-table"><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Status</th>${canManage?'<th>Ação</th>':''}</tr></thead><tbody>${(state.users||[]).map(u=>`<tr><td>${esc(u.name)}</td><td>${esc(u.email||'')}</td><td>${esc(({admin:'Administrador',manager:'Gerente',sales:'Vendedor'})[u.role]||u.role)}</td><td>${Number(u.is_active)!==0?'Ativo':'Desativado'}</td>${canManage?`<td>${Number(u.id)!==Number(currentUser.id)?`<button class="inline-action" onclick="toggleUser(${u.id},${Number(u.is_active)!==0?0:1})">${Number(u.is_active)!==0?'Desativar':'Ativar'}</button>`:'Você'}</td>`:''}</tr>`).join('')||'<tr><td colspan="5">Nenhum usuário encontrado.</td></tr>'}</tbody></table></div><p class="form-help">As senhas são administradas pelo Supabase Auth e nunca aparecem nesta tela.</p>`;
    } else if(activeSettings==='funil') {
      const pipelineId=Number(state.pipelines?.find(p=>p.is_default)?.id||state.pipelines?.[0]?.id||0);
      const stages=(state.pipelineStages||[]).filter(s=>!pipelineId||Number(s.pipeline_id)===pipelineId).slice().sort((a,b)=>a.position-b.position);
      const rows=stages.map((stage,i)=>`<div class="stage-manage-row"><div class="stage-number">${i+1}</div><div><label class="form-help" for="stageName-${stage.id}">Nome da coluna</label><input id="stageName-${stage.id}" maxlength="80" value="${esc(stage.name)}" ${canManage?'':'disabled'}></div><div class="stage-probability-field"><label class="form-help" for="stageProbability-${stage.id}">Probabilidade (%)</label><input id="stageProbability-${stage.id}" type="number" min="0" max="100" value="${Number(stage.probability)||0}" ${canManage?'':'disabled'}></div><div class="stage-type-field"><label class="form-help" for="stageType-${stage.id}">Classificação</label><select id="stageType-${stage.id}" ${canManage?'':'disabled'}><option value="open" ${!stage.is_won&&!stage.is_lost?'selected':''}>Em andamento</option><option value="won" ${stage.is_won?'selected':''}>Ganho</option><option value="lost" ${stage.is_lost?'selected':''}>Perdido</option></select></div>${canManage?`<button class="btn small primary stage-save-button" onclick="savePipelineStage(${stage.id})">Salvar</button><button class="btn small ghost stage-delete-button" onclick="deletePipelineStage(${stage.id})" aria-label="Excluir coluna">Excluir</button>`:'<span></span><span></span>'}</div>`).join('');
      contents=`<h3 class="settings-section-title">Colunas do funil</h3><p class="settings-section-desc">Renomeie colunas, ajuste a probabilidade e defina quais representam negócios ganhos ou perdidos. Para criar novas colunas, use o botão “Nova coluna” no funil.</p>${canManage?`<div class="form-help">Só é possível excluir uma coluna vazia. O sistema impede apagar etapas que ainda contenham oportunidades.</div>`:'<p class="form-help">Somente o administrador pode alterar as colunas.</p>'}<div class="stage-management-list">${rows||'<div class="empty">Nenhuma coluna cadastrada.</div>'}</div>`;
    } else if(activeSettings==='dados') {
      contents=`<h3 class="settings-section-title">Dados e exportação</h3><p class="settings-section-desc">Exporte dados para cópia externa. Para backup completo, use os recursos de backup/exportação disponíveis no painel do Supabase.</p><div class="toggle-row"><div class="toggle-copy"><strong>Exportar contatos</strong><span>Baixe os contatos da base atual em CSV.</span></div>${button('Exportar CSV',"exportCSV('contacts')",false,'download')}</div><div class="toggle-row"><div class="toggle-copy"><strong>Exportar oportunidades</strong><span>Baixe os negócios do funil em CSV.</span></div>${button('Exportar CSV',"exportCSV('deals')",false,'download')}</div><div class="toggle-row"><div class="toggle-copy"><strong>Backup do Supabase</strong><span>Use Supabase Dashboard → Database → Backups/Export para proteger os dados do projeto.</span></div><span class="status">Manual</span></div>`;
    } else {
      contents=`<h3 class="settings-section-title">Licença e versão</h3><p class="settings-section-desc">Informações desta instalação do CRM.</p><div class="card" style="padding:18px;background:var(--panel2)"><div class="eyebrow">NEXO CRM</div><div style="font-size:20px;font-weight:750;margin:6px 0">Versão 0.5 · Logo da empresa e navegação responsiva</div><p class="card-sub" style="line-height:1.7">Interface conectada ao Supabase Auth e PostgreSQL. Antes de comercializar, finalize testes de segurança, auditoria, backups e permissões.</p></div>`;
    }
    return `${pageHeader('PREFERÊNCIAS','Configurações','Personalize a aparência e administre o CRM.')}<div class="settings-layout"><aside class="card settings-nav">${[['empresa','Dados da empresa'],['aparencia','Aparência e cores'],['usuarios','Usuários e acessos'],['funil','Colunas do funil'],['dados','Dados e backups'],['licenca','Licença e versão']].map(([k,v])=>`<button class="settings-tab ${activeSettings===k?'active':''}" onclick="setSettingsTab('${k}')">${v}</button>`).join('')}</aside><section class="card view-card">${contents}</section></div>`;
  };
  window.toggleUser = async function(id,active) {
    if(!confirm(active?'Ativar este usuário?':'Desativar este usuário?'))return;
    try{await api('users','PATCH',{id,is_active:!!active});await loadRemoteState();render();showToast(active?'Usuário ativado.':'Usuário desativado.');}catch(e){showToast(e.message||'Não foi possível alterar o usuário.');}
  };

  // WhatsApp: área preparatória. A conexão real exige Meta Cloud API + funções server-side/webhook.
  window.whatsappPage = function() {
    return `${pageHeader('CANAIS DE ATENDIMENTO','WhatsApp','Prepare a conexão do WhatsApp Business ao NEXO CRM, sem vincular uma conta agora.',button('Abrir documentação da Meta',"window.open('https://developers.facebook.com/docs/whatsapp/cloud-api/overview/','_blank','noopener,noreferrer')",false,'external-link'))}
      <div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin-bottom:18px">
        <article class="card stat-card"><div class="stat-top"><span>Status da conexão</span><span class="stat-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.7-1.2A9 9 0 1 0 12 3Z"/><path d="M8.5 8.5c.4-.5.8-.4 1 .1l.8 1.3c.2.3.1.5-.2.8l-.4.4c.5 1.1 1.4 2 2.5 2.5l.4-.5c.2-.2.5-.3.8-.1l1.3.7c.4.2.4.6.2 1-.4.6-1 .8-1.7.8-2.4-.2-5.4-3.2-5.6-5.6 0-.6.4-1.1.9-1.4Z"/></svg></span></div><div class="stat-value" style="font-size:22px;color:var(--muted)"><span class="status muted">Ainda não conectado</span></div><div class="stat-bottom"><span class="stat-note">Nenhuma conta da Meta foi vinculada.</span></div></article>
        <article class="card stat-card"><div class="stat-top"><span>Mensagens</span><span class="stat-icon">${ico('message-circle',17)}</span></div><div class="stat-value">—</div><div class="stat-bottom"><span class="stat-note">Disponível após ativar a integração.</span></div></article>
        <article class="card stat-card"><div class="stat-top"><span>Número comercial</span><span class="stat-icon">${ico('phone',17)}</span></div><div class="stat-value" style="font-size:16px">Não configurado</div><div class="stat-bottom"><span class="stat-note">O número será definido durante a conexão oficial.</span></div></article>
      </div>
      <section class="card" style="padding:clamp(18px,3vw,30px);margin-bottom:18px;overflow:hidden;position:relative">
        <div style="position:absolute;right:-35px;top:-55px;width:210px;height:210px;border-radius:50%;background:radial-gradient(circle,#248b4b2b 0%,#248b4b00 70%);pointer-events:none"></div>
        <div style="display:flex;align-items:flex-start;gap:16px;position:relative;z-index:1;flex-wrap:wrap">
          <div style="width:58px;height:58px;flex:none;border-radius:17px;display:grid;place-items:center;background:#183c29;border:1px solid #2f6745;color:#8ee0a7">
            <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="M20.2 11.7a8.2 8.2 0 0 1-12.1 7.2L3 20l1.2-4.8A8.2 8.2 0 1 1 20.2 11.7Z"/><path d="M8.3 8.1c.4-.6.8-.5 1.1-.1l.9 1.5c.2.3.1.6-.2.9l-.5.5c.6 1.3 1.6 2.3 2.9 2.9l.5-.6c.2-.3.6-.4.9-.2l1.5.8c.4.2.5.7.2 1.1-.5.7-1.2 1-2 1-2.7-.2-6.2-3.7-6.4-6.4 0-.6.4-1.1 1.1-1.4Z"/></svg>
          </div>
          <div style="flex:1;min-width:220px">
            <div class="eyebrow" style="color:#73c78c">WHATSAPP BUSINESS PLATFORM</div>
            <h2 style="font-family:'Space Grotesk',sans-serif;font-size:24px;line-height:1.2;margin:5px 0 9px">Seu WhatsApp, dentro do NEXO</h2>
            <p style="color:var(--muted);line-height:1.7;max-width:780px;margin:0">Esta área já está preparada visualmente para a futura integração. Você não precisa conectar uma conta da Meta agora. Quando decidir ativar, seguiremos o fluxo oficial para vincular o WhatsApp Business e configurar o recebimento e envio de mensagens com segurança.</p>
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:18px">
              <button class="btn primary" type="button" onclick="toggleWhatsAppSetup()"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg> Preparar conexão</button>
              <a class="btn" href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer">Ir para Meta for Developers <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg></a>
            </div>
          </div>
        </div>
      </section>
      <section class="card" id="whatsappSetupPanel" hidden style="padding:22px;margin-bottom:18px">
        <div class="card-head"><div><div class="card-title">Caminho de conexão</div><div class="card-sub">Você pode preparar estes itens agora e conectar a conta depois.</div></div><button class="icon-button" aria-label="Fechar instruções" onclick="toggleWhatsAppSetup(false)">${ico('x',17)}</button></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:15px">
          <div style="padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--panel2)"><div class="eyebrow">PASSO 01</div><strong style="display:block;margin:6px 0">Conta comercial Meta</strong><p class="card-sub" style="line-height:1.65">Tenha acesso ao portfólio empresarial da empresa que será conectada.</p><span class="status muted">Pode fazer depois</span></div>
          <div style="padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--panel2)"><div class="eyebrow">PASSO 02</div><strong style="display:block;margin:6px 0">WhatsApp Business</strong><p class="card-sub" style="line-height:1.65">Escolha a conta e o número comercial que serão usados pela empresa.</p><span class="status muted">Precisa da Meta</span></div>
          <div style="padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--panel2)"><div class="eyebrow">PASSO 03</div><strong style="display:block;margin:6px 0">Conexão segura do NEXO</strong><p class="card-sub" style="line-height:1.65">Configuraremos token e identificadores no servidor, nunca em arquivos públicos do GitHub.</p><span class="status muted">Desenvolvimento necessário</span></div>
          <div style="padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--panel2)"><div class="eyebrow">PASSO 04</div><strong style="display:block;margin:6px 0">Receber mensagens</strong><p class="card-sub" style="line-height:1.65">Um webhook HTTPS seguro avisará o CRM sobre mensagens novas e status de envio.</p><span class="status muted">Desenvolvimento necessário</span></div>
        </div>
        <div style="margin-top:16px;padding:13px 15px;border:1px solid var(--line);border-radius:10px;background:var(--panel2);color:var(--muted);font-size:12px;line-height:1.7"><strong style="color:var(--text)">Importante:</strong> este botão ainda não autoriza nem conecta sua conta. Ele mostra o caminho de preparação. Para ativar a conexão real, precisaremos construir e testar as funções seguras do servidor e o webhook.</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px"><a class="btn primary" target="_blank" rel="noopener noreferrer" href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started/">Abrir guia oficial de início <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg></a><button class="btn" type="button" onclick="toggleWhatsAppSetup(false)">Entendi</button></div>
      </section>
      <section class="card" style="padding:19px">
        <div class="card-head"><div><div class="card-title">O que ficará disponível depois da integração</div><div class="card-sub">Recursos planejados, ainda inativos nesta versão.</div></div></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-top:12px">
          <div style="display:flex;gap:10px;align-items:flex-start"><span class="stat-icon">${ico('messages-square',17)}</span><div><strong>Conversas no CRM</strong><div class="card-sub" style="margin-top:4px">Ler e responder sem sair da tela.</div></div></div>
          <div style="display:flex;gap:10px;align-items:flex-start"><span class="stat-icon">${ico('contact-round',17)}</span><div><strong>Histórico por lead</strong><div class="card-sub" style="margin-top:4px">Vincular mensagens ao contato certo.</div></div></div>
          <div style="display:flex;gap:10px;align-items:flex-start"><span class="stat-icon">${ico('bell-ring',17)}</span><div><strong>Alertas de retorno</strong><div class="card-sub" style="margin-top:4px">Sinalizar conversas sem resposta.</div></div></div>
        </div>
      </section>`;
  };

  window.toggleWhatsAppSetup = function(force) {
    const panel=document.getElementById('whatsappSetupPanel');
    if(!panel)return;
    const open=typeof force==='boolean'?force:panel.hidden;
    panel.hidden=!open;
    if(open) panel.scrollIntoView({behavior:'smooth',block:'nearest'});
  };

  // Renderização explícita: evita conflitos com os handlers antigos do protótipo inline.
  window.render = function() {
    const target = document.getElementById('mainContent');
    if (!target) return;
    const pages = {
      dashboard: window.dashboard,
      contacts: window.contactsPage,
      whatsapp: window.whatsappPage,
      pipeline: window.pipelinePage,
      tasks: window.tasksPage,
      activities: window.activitiesPage,
      reports: window.reportsPage,
      settings: window.settingsPage
    };
    const renderer = pages[currentPage] || window.dashboard;
    try {
      if (typeof renderer !== 'function') throw new Error('A tela solicitada não foi carregada corretamente.');
      target.innerHTML = renderer();
    } catch (error) {
      console.error('[NEXO CRM] Falha ao renderizar a tela:', currentPage, error);
      target.innerHTML = `<section class="card" style="padding:24px;margin:12px 0"><div class="card-title" style="font-size:15px;margin-bottom:7px">Não foi possível abrir esta área</div><p class="card-sub" style="line-height:1.7">A tela ${String(currentPage).replace(/[<>]/g,'')} encontrou um erro. Seus dados não foram apagados. Abra o console do navegador ou envie esta mensagem de erro para corrigirmos.</p><button type="button" class="btn" onclick="window.navigate('dashboard')">Voltar ao início</button></section>`;
      if (typeof window.showToast === 'function') window.showToast('A tela não abriu. Seus dados foram preservados.');
    }
    const cc = document.getElementById('contactCount');
    if (cc) cc.textContent = (state.contacts || []).length;
    const tc = document.getElementById('taskCount');
    if (tc) tc.textContent = (state.tasks || []).filter(t => t.status !== 'Concluída' && t.status !== 'Cancelada').length;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === currentPage));
    const breadcrumb = document.getElementById('breadcrumb');
    if (breadcrumb && typeof window.navLabel === 'function') {
      const label = window.navLabel(currentPage);
      breadcrumb.innerHTML = `Workspace <span style="color:#5f666c;margin:0 7px">/</span> <b>${label}</b>`;
    }
  };

  // A navegação usada pelos botões é registrada aqui, depois das telas reais do Supabase.
  // Isso impede que a função antiga da prévia HTML sobrescreva o fluxo de navegação.
  window.navigate = function(page) {
    const allowed = ['dashboard','contacts','whatsapp','pipeline','tasks','activities','reports','settings'];
    if (!allowed.includes(page)) {
      console.warn('[NEXO CRM] Rota desconhecida:', page);
      return;
    }
    currentPage = page;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    const breadcrumb = document.getElementById('breadcrumb');
    if (breadcrumb) {
      const labels = {dashboard:'Visão geral',contacts:'Contatos',whatsapp:'WhatsApp',pipeline:'Funil de vendas',tasks:'Tarefas',activities:'Atividades',reports:'Relatórios',settings:'Configurações'};
      breadcrumb.innerHTML = `Workspace <span style="color:#5f666c;margin:0 7px">/</span> <b>${labels[page]}</b>`;
    }
    const sidebar = document.getElementById('sidebar');
    if (sidebar && window.matchMedia('(min-width: 761px)').matches) sidebar.classList.add('sidebar-suppress-hover');
    if (typeof window.toggleSidebar === 'function') window.toggleSidebar(false);
    window.render();
  };

  // Captura cliques na navegação antes dos onclicks legados do HTML.
  // Links de navegação em botões gerados dinamicamente continuam usando window.navigate.
  document.addEventListener('click', function(event) {
    const navButton = event.target && event.target.closest ? event.target.closest('.nav-item[data-page]') : null;
    if (!navButton) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.navigate(navButton.dataset.page);
  }, true);

  // Substitui ações locais pelos endpoints da API.
  window.resetDemo = function(){showToast('Os registros reais não são apagados pela interface. Para remover dados, arquive cada registro ou use uma ferramenta administrativa autorizada.');};
  window.searchContacts = function(q) { searchQuery=q;const pos=document.getElementById('contactSearch')?.selectionStart;render();const el=document.getElementById('contactSearch');if(el){el.focus();if(pos!==undefined)el.setSelectionRange(pos,pos);} };
  window.setContactFilter = function(v){contactFilter=v;render();};
  window.setTaskFilter = function(v){taskFilter=v;render();};
  window.searchPipeline = function(q){pipelineSearchQuery=String(q||'').slice(0,100);const panel=document.getElementById('pipelineSearchPreview');const markup=pipelineSearchMatchesMarkup(pipelineSearchQuery);if(panel){if(markup){const temp=document.createElement('div');temp.innerHTML=markup;panel.replaceWith(temp.firstElementChild);}else panel.remove();}else if(markup){const toolbar=document.querySelector('.pipeline-toolbar');if(toolbar){const temp=document.createElement('div');temp.innerHTML=markup;toolbar.insertAdjacentElement('afterend',temp.firstElementChild);}}const matches=new Set(getPipelineSearchMatches(pipelineSearchQuery).map(d=>Number(d.id)));document.querySelectorAll('.deal-card[data-deal-id]').forEach(card=>card.classList.toggle('search-hit',matches.has(Number(card.dataset.dealId))));};
  window.globalSearch = function(q){searchQuery=q;if(!q.trim()) {render();return;} if(currentPage!=='contacts'&&currentPage!=='pipeline')navigate('contacts');else render();};

  // Reinitialize only after the authentication overlay has been attached.
  state=emptyState();
  applyAppearance((()=>{try{return localStorage.getItem('nexo-crm-theme')||'dark';}catch(_){return 'dark';}})(),(()=>{try{const c=localStorage.getItem('nexo-crm-accent');return c&&c.toLowerCase()!=='#788d52'?c:'#24466f';}catch(_){return '#24466f';}})(),false);
  ensureAuthMarkup();
  initializeApp();
})();
