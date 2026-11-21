// Caça-vagas — servidor que junta vagas de várias fontes e serve a página.
// Requer Node.js 18+ (usa fetch nativo). Sem dependências externas.
//
// Variáveis de ambiente (todas opcionais):
//   PORT=8085
//   ADZUNA_APP_ID=...  ADZUNA_APP_KEY=...   -> https://developer.adzuna.com (grátis)
//   JOOBLE_KEY=...                         -> https://br.jooble.org/api/about (grátis)
//   JOOBLE_HOST=br.jooble.org
//   SERPER_KEY=...                         -> https://serper.dev (sites de empresas e "trabalhe conosco")
//   SERPAPI_KEY=...                        -> https://serpapi.com (Google Vagas)
//   CACHE_MIN=20                           -> minutos que uma busca fica em cache

const http = require('http');
const fs = require('fs');
const path = require('path');

loadEnv(path.join(__dirname, '.env'));

const PORT = +process.env.PORT || 8085;
const CACHE_MS = (+process.env.CACHE_MIN || 20) * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; CacaVagas/1.0)';
const INDEX = path.join(__dirname, 'index.html');

// ---------- utilidades ----------
function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* sem .env, tudo bem */ }
}
const strip = s => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const norm = s => strip(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const toISO = d => { const t = Date.parse(d); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const DAYS = { d: 1, w: 7, m: 30 };

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------- fontes ----------
const providers = {
  // API pública do portal da Gupy (sem chave)
  async gupy({ q, cidade, remoto }) {
    const base = 'https://portal.api.gupy.io/api/v1/jobs';
    const page = off => {
      const p = new URLSearchParams({ jobName: q, limit: '10', offset: String(off) });
      if (remoto) p.set('workplaceType', 'remote');
      if (cidade && !remoto) p.set('city', cidade);
      return getJSON(`${base}?${p}`);
    };
    const pages = await Promise.allSettled([0, 10, 20, 30, 40, 50].map(page));
    const ok = pages.filter(p => p.status === 'fulfilled');
    if (!ok.length) throw pages[0].reason;
    return ok.flatMap(p => p.value?.data || []).map(j => ({
      titulo: strip(j.name),
      empresa: strip(j.careerPageName || j.companyName || ''),
      logo: j.careerPageLogo || null,
      cidade: strip(j.city || ''),
      estado: strip(j.state || ''),
      remoto: j.isRemoteWork === true || j.workplaceType === 'remote',
      modelo: { remote: 'Remoto', hybrid: 'Híbrido', 'on-site': 'Presencial' }[j.workplaceType] || '',
      publicada: toISO(j.publishedDate),
      prazo: toISO(j.applicationDeadline),
      resumo: cut(strip(j.description || ''), 260),
      _t: strip(j.description || ''),
      url: j.jobUrl,
      fonte: 'Gupy',
    }));
  },

  // API oficial da Adzuna (agrega vários portais)
  async adzuna({ q, cidade, remoto, periodo }) {
    const id = process.env.ADZUNA_APP_ID, key = process.env.ADZUNA_APP_KEY;
    if (!id || !key) return null; // fonte desligada
    const p = new URLSearchParams({ app_id: id, app_key: key, results_per_page: '50', what: q + (remoto ? ' remoto' : ''), 'content-type': 'application/json', sort_by: 'date' });
    if (cidade && !remoto) p.set('where', cidade);
    if (DAYS[periodo]) p.set('max_days_old', String(DAYS[periodo]));
    const data = await getJSON(`https://api.adzuna.com/v1/api/jobs/br/search/1?${p}`);
    return (data.results || []).map(j => {
      const area = j.location?.area || [];
      return {
        titulo: strip(j.title),
        empresa: strip(j.company?.display_name || ''),
        logo: null,
        cidade: strip(area[area.length - 1] || j.location?.display_name || ''),
        estado: strip(area[1] || ''),
        remoto: /remot|home office/i.test(j.title + ' ' + j.description),
        modelo: '',
        publicada: toISO(j.created),
        prazo: null,
        resumo: cut(strip(j.description), 260),
        _t: strip(j.description),
        salario: j.salary_min ? `R$ ${Math.round(j.salary_min).toLocaleString('pt-BR')}${j.salary_max && j.salary_max !== j.salary_min ? ' a ' + Math.round(j.salary_max).toLocaleString('pt-BR') : ''}` : '',
        url: j.redirect_url,
        fonte: 'Adzuna',
      };
    });
  },

  // API oficial da Jooble (agrega vários portais)
  async jooble({ q, cidade, remoto, periodo }) {
    const key = process.env.JOOBLE_KEY;
    if (!key) return null;
    const host = process.env.JOOBLE_HOST || 'br.jooble.org';
    const body = { keywords: q + (remoto ? ' remoto' : ''), location: remoto ? '' : (cidade || ''), page: '1' };
    if (DAYS[periodo]) body.datecreatedfrom = new Date(Date.now() - DAYS[periodo] * 864e5).toISOString().slice(0, 10);
    const data = await getJSON(`https://${host}/api/${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return (data.jobs || []).map(j => ({
      titulo: strip(j.title),
      empresa: strip(j.company || ''),
      logo: null,
      cidade: strip(j.location || ''),
      estado: '',
      remoto: /remot|home office/i.test(j.title + ' ' + j.snippet + ' ' + j.location),
      modelo: '',
      publicada: toISO(j.updated),
      prazo: null,
      resumo: cut(strip(j.snippet), 260),
      _t: strip(j.snippet),
      salario: strip(j.salary || ''),
      url: j.link,
      fonte: 'Jooble' + (j.source ? ` · ${strip(j.source)}` : ''),
    }));
  },
};

// ---------- sites de empresas e sistemas de recrutamento (via Google) ----------
const ATS_NOMES = {
  'vagas.solides.com.br': 'Sólides', 'solides.jobs': 'Sólides', 'inhire.app': 'InHire', 'jobs.kenoby.com': 'Kenoby',
  'pandape.infojobs.com.br': 'Pandapé', 'jobs.quickin.io': 'Quickin', 'recrutei.com.br': 'Recrutei', 'jobs.lever.co': 'Lever',
  'boards.greenhouse.io': 'Greenhouse', 'job-boards.greenhouse.io': 'Greenhouse', 'apply.workable.com': 'Workable',
  'breezy.hr': 'Breezy', 'teamtailor.com': 'Teamtailor', 'abler.com.br': 'Abler', 'factorialhr.com': 'Factorial',
};
// portais que já entram por outras fontes ou só trazem listas
const IGNORAR = /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com(\.br)?|catho\.com\.br|infojobs\.com\.br|vagas\.com\.br|gupy\.io|bne\.com\.br|trabalhabrasil\.com\.br|jooble\.org|adzuna\.com\.br|facebook\.com|instagram\.com|youtube\.com|x\.com|twitter\.com|tiktok\.com|empregos\.com\.br|vagas\.net)$/i;

function quando(txt) {
  if (!txt) return null;
  const iso = toISO(txt);
  if (iso && /\d{4}/.test(txt)) return iso;
  const m = String(txt).toLowerCase().match(/(\d+)\s*(min|hora|hour|h\b|dia|day|d\b|semana|week|m[eê]s|month)/);
  if (!m) return /hoje|today|agora|just/.test(String(txt).toLowerCase()) ? new Date().toISOString() : null;
  const n = +m[1], u = m[2];
  const ms = /min/.test(u) ? 6e4 : /hora|hour|^h/.test(u) ? 36e5 : /dia|day|^d/.test(u) ? 864e5 : /semana|week/.test(u) ? 6048e5 : 2592e6;
  return new Date(Date.now() - n * ms).toISOString();
}
function origem(link) {
  let h;
  try { h = new URL(link).hostname.replace(/^www\./, ''); } catch { return null; }
  if (IGNORAR.test(h)) return null;
  for (const [dom, nome] of Object.entries(ATS_NOMES)) {
    if (h === dom || h.endsWith('.' + dom)) {
      const sub = h.slice(0, -(dom.length + 1));
      let emp = sub && !/^(www|jobs|vagas|apply|boards|job-boards)$/.test(sub) ? sub : '';
      if (!emp) { const seg = new URL(link).pathname.split('/').filter(Boolean).filter(s => !/^(vagas|vaga|jobs|job|o|j|careers)$/i.test(s)); emp = seg[0] && !/^\d+$/.test(seg[0]) ? seg[0] : ''; }
      return { fonte: nome, empresa: emp ? cap(decodeURIComponent(emp).replace(/[-_]/g, ' ')) : '' };
    }
  }
  const base = h.replace(/\.(com|org|net|ind|gov|edu)?\.?br$|\.(com|io|co|net|org)$/, '').split('.').pop();
  return { fonte: 'Site da empresa · ' + h, empresa: cap((base || h).replace(/[-_]/g, ' ')) };
}
const limpaTitulo = t => strip(t).split(/\s[|–—]\s|\s-\s(?=[^-]*$)/)[0].replace(/^(vaga(s)?( de)?:?\s*)/i, '').trim();

providers.web = async function ({ q, cidade, remoto, periodo }) {
  const key = process.env.SERPER_KEY;
  if (!key) return null;
  const loc = cidade && !remoto ? ` ${cidade}` : '';
  const rem = remoto ? ' (remoto OR "home office")' : '';
  const ats = Object.keys(ATS_NOMES).map(d => 'site:' + d).join(' OR ');
  const consultas = [
    `("trabalhe conosco" OR "faça parte do nosso time" OR "venha fazer parte" OR "estamos contratando" OR "vagas abertas") vaga ${q}${loc}${rem}`,
    `(${ats}) ${q}${loc}${rem}`,
  ];
  const tbs = { d: 'qdr:d', w: 'qdr:w', m: 'qdr:m' }[periodo];
  const res = await Promise.all(consultas.map(c => getJSON('https://google.serper.dev/search', {
    method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: c, gl: 'br', hl: 'pt-br', num: 10, ...(tbs ? { tbs } : {}) }),
  }).catch(() => ({ organic: [] }))));
  const out = [];
  for (const r of res) for (const o of r.organic || []) {
    const og = origem(o.link);
    if (!og) continue;
    const titulo = limpaTitulo(o.title);
    if (!titulo) continue;
    out.push({
      titulo, empresa: og.empresa, logo: null,
      cidade: '', estado: '',
      remoto: /remot|home office/i.test(o.title + ' ' + o.snippet),
      modelo: '', publicada: quando(o.date), prazo: null,
      resumo: cut(strip(o.snippet), 260), _t: strip(o.snippet),
      url: o.link, fonte: og.fonte,
    });
  }
  return out;
};

// ---------- Google Vagas (via SerpApi) ----------
providers.gjobs = async function ({ q, cidade, remoto }) {
  const key = process.env.SERPAPI_KEY;
  if (!key) return null;
  const p = new URLSearchParams({ engine: 'google_jobs', q: `${q}${cidade && !remoto ? ' ' + cidade : ''}${remoto ? ' remoto' : ''}`, gl: 'br', hl: 'pt', api_key: key });
  const d = await getJSON('https://serpapi.com/search.json?' + p);
  return (d.jobs_results || []).map(j => {
    const ext = j.detected_extensions || {};
    const link = (j.apply_options || [])[0]?.link || j.share_link;
    const [c, uf] = String(j.location || '').split(/\s*[-,]\s*/);
    return {
      titulo: strip(j.title), empresa: strip(j.company_name || ''), logo: j.thumbnail || null,
      cidade: strip(c || ''), estado: strip(uf || ''),
      remoto: !!ext.work_from_home || /remot/i.test(j.location || ''), modelo: ext.work_from_home ? 'Remoto' : '',
      publicada: quando(ext.posted_at), prazo: null,
      resumo: cut(strip(j.description), 260), _t: strip(j.description),
      salario: strip(ext.salary || ''),
      url: link, fonte: 'Google Vagas' + (j.via ? ' · ' + strip(j.via).replace(/^(via|por)\s+/i, '') : ''),
    };
  });
};

// ---------- busca agregada com cache ----------
const cache = new Map();

async function buscar(params) {
  const k = JSON.stringify(params);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;

  const names = Object.keys(providers);
  const results = await Promise.allSettled(names.map(n => providers[n](params)));
  const fontes = {};
  let vagas = [];
  results.forEach((r, i) => {
    const n = names[i];
    if (r.status === 'rejected') fontes[n] = { ok: false, erro: String(r.reason?.message || r.reason) };
    else if (r.value === null) fontes[n] = { ok: false, desligada: true };
    else { fontes[n] = { ok: true, total: r.value.length }; vagas.push(...r.value); }
  });

  // limpa, filtra período e remove duplicadas
  const lim = DAYS[params.periodo] ? Date.now() - DAYS[params.periodo] * 864e5 : 0;
  const seen = new Set();
  vagas = vagas.filter(v => {
    if (!v.titulo || !/^https?:\/\//.test(v.url || '')) return false;
    if (lim && v.publicada && Date.parse(v.publicada) < lim) return false;
    if (params.remoto && !v.remoto) return false;
    const key = norm(v.titulo) + '|' + norm(v.empresa) + '|' + norm(v.cidade);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (Date.parse(b.publicada) || 0) - (Date.parse(a.publicada) || 0));

  const v = { total: vagas.length, fontes, vagas, geradoEm: new Date().toISOString() };
  if (Object.values(fontes).some(f => f.ok)) cache.set(k, { t: Date.now(), v }); // não guarda falhas
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return v;
}

// ---------- currículo: extração do perfil ----------
const pub = d => JSON.stringify(d, (k, v) => (k.startsWith('_') ? undefined : v));
const STOP = new Set('de da do das dos e em para com a o as os no na nos nas por ou um uma ao aos'.split(' '));
const UFS = 'AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO';
const HEADS = ['auxiliar', 'assistente', 'analista', 'tecnico', 'tecnica', 'coordenador', 'coordenadora', 'gerente', 'supervisor', 'supervisora', 'encarregado', 'lider', 'desenvolvedor', 'desenvolvedora', 'programador', 'engenheiro', 'engenheira', 'operador', 'operadora', 'vendedor', 'vendedora', 'atendente', 'recepcionista', 'motorista', 'estagiario', 'estagiaria', 'consultor', 'consultora', 'especialista', 'designer', 'professor', 'professora', 'enfermeiro', 'enfermeira', 'contador', 'contadora', 'comprador', 'compradora', 'almoxarife', 'eletricista', 'mecanico', 'montador', 'soldador', 'cozinheiro', 'cozinheira', 'garcom', 'garconete', 'repositor', 'estoquista', 'secretaria', 'administrador', 'advogado', 'advogada', 'farmaceutico', 'farmaceutica', 'fisioterapeuta', 'psicologo', 'psicologa', 'nutricionista', 'arquiteto', 'arquiteta', 'jornalista', 'redator', 'redatora', 'gestor', 'gestora', 'diretor', 'diretora', 'representante comercial', 'executivo de vendas', 'conferente', 'ajudante', 'porteiro', 'vigilante', 'zelador', 'camareira', 'pedreiro', 'pintor', 'marceneiro', 'torneiro', 'ferramenteiro', 'cientista de dados', 'social media', 'operador de caixa', 'jovem aprendiz', 'trainee', 'inspetor', 'planejador', 'instrutor', 'instrutora', 'cuidador', 'cuidadora', 'bombeiro civil', 'caixa'];
const SKILLS = ['Excel', 'Excel avançado', 'Word', 'PowerPoint', 'Pacote Office', 'Google Planilhas', 'Power BI', 'Tableau', 'SAP', 'TOTVS', 'Protheus', 'ERP', 'CRM', 'Salesforce', 'SQL', 'SQL Server', 'MySQL', 'PostgreSQL', 'Oracle', 'Python', 'Java', 'JavaScript', 'TypeScript', 'C#', '.NET', 'PHP', 'Node.js', 'React', 'Angular', 'Vue', 'HTML', 'CSS', 'Git', 'Docker', 'AWS', 'Azure', 'Linux', 'API', 'Scrum', 'Kanban', 'Figma', 'Photoshop', 'Illustrator', 'Canva', 'AutoCAD', 'SolidWorks', 'Revit', 'CLP', 'Elétrica', 'Mecânica', 'Hidráulica', 'Pneumática', 'Manutenção', 'Manutenção preventiva', 'Solda', 'Torno', 'Empilhadeira', 'NR-10', 'NR-35', 'NR-12', 'NR-11', 'CNH A', 'CNH B', 'CNH C', 'CNH D', 'CNH E', 'Inglês', 'Espanhol', 'Atendimento ao cliente', 'Atendimento', 'Telemarketing', 'Vendas', 'Negociação', 'Prospecção', 'Pós-venda', 'Marketing digital', 'Redes sociais', 'SEO', 'Tráfego pago', 'Google Ads', 'Copywriting', 'Contas a pagar', 'Contas a receber', 'Faturamento', 'Fluxo de caixa', 'Conciliação bancária', 'Notas fiscais', 'Departamento pessoal', 'Folha de pagamento', 'Recrutamento e seleção', 'Rotinas administrativas', 'Arquivo', 'Agenda', 'Logística', 'Estoque', 'Inventário', 'Expedição', 'Recebimento', 'Compras', 'Licitação', 'Contabilidade', 'Fiscal', 'Auditoria', 'Controladoria', 'Orçamento', 'Qualidade', 'ISO 9001', 'Lean', '5S', 'Six Sigma', 'Segurança do trabalho', 'Primeiros socorros', 'Enfermagem', 'Cozinha', 'Limpeza', 'Caixa', 'Gestão de equipes', 'Liderança', 'Gestão de projetos', 'Análise de dados', 'Indicadores', 'Planejamento', 'PCP', 'Produção', 'Operação de máquinas', 'Montagem', 'Usinagem', 'Agronegócio', 'Armazenagem de grãos', 'Secagem de grãos'];

// normaliza mantendo o mapa de posições para recortar o texto original
function normMap(txt) {
  let n = '', map = [];
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    for (const ch of c) { n += ch; map.push(i); }
  }
  return { n, map };
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function perfilPorRegras(texto) {
  const txt = texto.slice(0, 40000);
  const { n, map } = normMap(txt);
  const headRe = HEADS.map(h => h.replace(/ /g, '\\s+')).sort((a, b) => b.length - a.length).join('|');
  const re = new RegExp(`\\b(?:${headRe})\\b(?:[ \\t]+(?:de|do|da|dos|das|em|e)?[ \\t]*[a-z][a-z\\-]{2,}){0,3}`, 'g');
  const conta = new Map();
  const obj = n.search(/objetivo|cargo pretendido|area de interesse/);
  let m;
  while ((m = re.exec(n))) {
    let ini = map[m.index], fim = map[m.index + m[0].length - 1] + 1;
    let orig = txt.slice(ini, fim).replace(/\s+/g, ' ').trim();
    orig = orig.replace(/\s+(de|do|da|dos|das|em|e|na|no|com|para)$/i, '');
    const words = orig.split(' ');
    while (words.length > 1 && /^(em|na|no|com|para|e|desde|ate|até|ltda|s\.?a\.?)$/i.test(words[words.length - 1])) words.pop();
    orig = words.join(' ');
    const k = norm(orig);
    if (k.length < 4) continue;
    const peso = obj >= 0 && m.index > obj && m.index - obj < 160 ? 5 : 1;
    const cur = conta.get(k) || { nome: cap(orig.toLowerCase()), n: 0 };
    cur.n += peso; conta.set(k, cur);
  }
  // remove cargos que são só a "cabeça" quando existe versão mais específica
  let cargos = [...conta.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => ({ k, ...v }));
  cargos = cargos.filter(c => !(c.k.split(' ').length === 1 && cargos.some(o => o !== c && o.k.startsWith(c.k + ' '))));
  const habilidades = SKILLS.filter(s => {
    const k = norm(s);
    return new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}([^a-z0-9]|$)`).test(n);
  });
  const hab = habilidades;
  const cm = txt.match(new RegExp(`\\b([A-ZÀ-Ý][a-zà-ÿ]+(?:[ \\t](?:(?:de|do|da|dos|das)[ \\t])?[A-ZÀ-Ý][a-zà-ÿ]+){0,2})\\s*[-–/,]\\s*(${UFS})\\b`));
  const nivel = /estagi/.test(n) && !/(analista|coordenador|gerente)/.test(n) ? 'Estágio' : /\bsenior\b/.test(n) ? 'Sênior' : /\bpleno\b/.test(n) ? 'Pleno' : /\bjunior\b/.test(n) ? 'Júnior' : '';
  return { cargos: cargos.slice(0, 5).map(c => c.nome), habilidades: hab.slice(0, 15), cidade: cm ? cm[1].split(/(?<=[a-zà-ÿ])(?=[A-ZÀ-Ý])/).pop() : '', nivel, via: 'regras' };
}

async function perfilPorIA(texto) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const prompt = `Analise o currículo abaixo de um candidato no Brasil e responda SOMENTE com JSON válido, sem texto antes ou depois, no formato:
{"cargos":["..."],"habilidades":["..."],"cidade":"","nivel":""}
- cargos: de 3 a 5 títulos de vaga em português, como aparecem em anúncios brasileiros, para os quais esta pessoa deveria se candidatar agora (o cargo atual ou pretendido primeiro; inclua sinônimos e cargos vizinhos).
- habilidades: até 15 habilidades, ferramentas, certificações e idiomas citados, em termos curtos que aparecem em anúncios.
- cidade: cidade onde mora, só o nome, ou "" se não houver.
- nivel: "Estágio", "Júnior", "Pleno", "Sênior" ou "".
Ignore dados pessoais como documentos, telefone e endereço completo.

CURRÍCULO:
${texto.slice(0, 15000)}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`IA HTTP ${r.status}`);
  const d = await r.json();
  const out = (d.content || []).map(c => c.text || '').join('');
  const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  const arr = a => (Array.isArray(a) ? a.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, 60)) : []);
  return { cargos: arr(j.cargos).slice(0, 5), habilidades: arr(j.habilidades).slice(0, 15), cidade: String(j.cidade || '').slice(0, 60), nivel: String(j.nivel || '').slice(0, 20), via: 'ia' };
}

async function extrairPerfil(texto) {
  try { const p = await perfilPorIA(texto); if (p && p.cargos.length) return p; } catch (e) { console.error('IA falhou, usando regras:', e.message); }
  return perfilPorRegras(texto);
}

// ---------- compatibilidade ----------
function pontuar(v, cargos, habs) {
  const t = ' ' + norm(v.titulo) + ' ';
  const corpo = ' ' + norm(v.titulo + ' ' + (v._t || v.resumo || '')) + ' ';
  let ts = 0;
  for (const c of cargos) {
    const toks = norm(c).split(' ').filter(w => w.length > 2 && !STOP.has(w));
    if (!toks.length) continue;
    const raiz = w => w.slice(0, Math.max(4, w.length - 2)); // tolera gênero/plural (analista/analistas, tecnico/tecnica)
    const hit = toks.filter(w => t.includes(' ' + raiz(w))).length / toks.length;
    ts = Math.max(ts, hit);
  }
  const bate = habs.filter(h => corpo.includes(' ' + norm(h) + ' '));
  const hs = habs.length ? Math.min(1, bate.length / Math.min(4, habs.length)) : 0;
  const score = Math.round(100 * (habs.length ? 0.7 * ts + 0.3 * hs : ts));
  return { score, bate: bate.slice(0, 6) };
}

async function compativeis({ cargos, habilidades, cidade, remoto, periodo }) {
  const lista = cargos.slice(0, 4);
  const res = await Promise.all(lista.map(q => buscar({ q, cidade, remoto, periodo })));
  const fontes = {};
  for (const r of res) for (const [k, f] of Object.entries(r.fontes)) {
    const cur = fontes[k] || { ok: false };
    if (f.ok) fontes[k] = { ok: true, total: (cur.total || 0) + f.total };
    else if (!cur.ok) fontes[k] = f;
  }
  const seen = new Set();
  const vagas = [];
  for (const r of res) for (const v of r.vagas) {
    const key = norm(v.titulo) + '|' + norm(v.empresa) + '|' + norm(v.cidade);
    if (seen.has(key)) continue;
    seen.add(key);
    const p = pontuar(v, cargos, habilidades);
    if (p.score >= 30) vagas.push({ ...v, score: p.score, bate: p.bate });
  }
  vagas.sort((a, b) => b.score - a.score || (Date.parse(b.publicada) || 0) - (Date.parse(a.publicada) || 0));
  return { total: vagas.length, fontes, vagas, buscou: lista, geradoEm: new Date().toISOString() };
}

function lerCorpo(req, max = 120000) {
  return new Promise((ok, fail) => {
    let size = 0, chunks = [];
    req.on('data', c => { size += c.length; if (size > max) { fail(Object.assign(new Error('Texto grande demais.'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { fail(Object.assign(new Error('JSON inválido.'), { code: 400 })); } });
    req.on('error', fail);
  });
}

// ---------- limite simples por IP ----------
const hits = new Map();
function limitado(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 30;
}

// ---------- servidor HTTP ----------
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra });
  res.end(body);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/vagas') {
      const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
      if (limitado(ip)) return send(res, 429, JSON.stringify({ erro: 'Muitas buscas seguidas. Espere um minuto.' }));
      const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
      if (q.length < 2) return send(res, 400, JSON.stringify({ erro: 'Informe a área ou o cargo.' }));
      const params = {
        q,
        cidade: (url.searchParams.get('cidade') || '').trim().slice(0, 60),
        remoto: url.searchParams.get('remoto') === '1',
        periodo: ['d', 'w', 'm'].includes(url.searchParams.get('periodo')) ? url.searchParams.get('periodo') : '',
      };
      const data = await buscar(params);
      return send(res, 200, pub(data), undefined, { 'Cache-Control': 'public, max-age=300' });
    }
    if ((url.pathname === '/api/perfil' || url.pathname === '/api/compativeis') && req.method === 'POST') {
      const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
      if (limitado(ip)) return send(res, 429, JSON.stringify({ erro: 'Muitas buscas seguidas. Espere um minuto.' }));
      let body;
      try { body = await lerCorpo(req); } catch (e) { return send(res, e.code || 400, JSON.stringify({ erro: e.message })); }
      if (url.pathname === '/api/perfil') {
        const texto = String(body.texto || '').trim();
        if (texto.length < 80) return send(res, 400, JSON.stringify({ erro: 'Não consegui ler texto suficiente do currículo.' }));
        return send(res, 200, JSON.stringify(await extrairPerfil(texto))); // o texto não é guardado
      }
      const arr = (a, n) => (Array.isArray(a) ? a.filter(x => typeof x === 'string').map(x => x.trim().slice(0, 60)).filter(Boolean).slice(0, n) : []);
      const cargos = arr(body.cargos, 4), habilidades = arr(body.habilidades, 20);
      if (!cargos.length) return send(res, 400, JSON.stringify({ erro: 'Informe ao menos um cargo.' }));
      const data = await compativeis({
        cargos, habilidades,
        cidade: String(body.cidade || '').trim().slice(0, 60),
        remoto: !!body.remoto,
        periodo: ['d', 'w', 'm'].includes(body.periodo) ? body.periodo : '',
      });
      return send(res, 200, pub(data));
    }
    if (url.pathname === '/api/status') {
      return send(res, 200, JSON.stringify({ ok: true, fontes: { gupy: true, adzuna: !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY), jooble: !!process.env.JOOBLE_KEY, web: !!process.env.SERPER_KEY, gjobs: !!process.env.SERPAPI_KEY } }));
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, fs.readFileSync(INDEX), 'text/html; charset=utf-8', { 'Cache-Control': 'no-cache' });
    }
    send(res, 404, 'Não encontrado', 'text/plain; charset=utf-8');
  } catch (e) {
    console.error(e);
    send(res, 500, JSON.stringify({ erro: 'Erro interno ao buscar vagas.' }));
  }
}).listen(PORT, () => {
  console.log(`Caça-vagas rodando em http://localhost:${PORT}`);
  const ok = v => (v ? '✔' : '✘ (sem chave)');
  console.log(`Fontes: Gupy ✔  Sites de empresas ${ok(process.env.SERPER_KEY)}  Google Vagas ${ok(process.env.SERPAPI_KEY)}  Adzuna ${ok(process.env.ADZUNA_APP_ID)}  Jooble ${ok(process.env.JOOBLE_KEY)}`);
});
