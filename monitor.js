const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;

const API_BASE = 'https://sgpl.consulta.al.ms.gov.br/sgpl/sgpl-api/public';
const URL_PROPOSICAO = 'https://sgpl.consulta.al.ms.gov.br/sgpl-publico/#/linha-tempo?idProposicao=';

// Tipos que merecem destaque de número de projeto no email
const SIGLAS_PROJETO = ['PL', 'PLC'];

function carregarEstado() {
  if (fs.existsSync('estado.json'))
    return JSON.parse(fs.readFileSync('estado.json', 'utf8'));
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync('estado.json', JSON.stringify(estado, null, 2));
}

function normalizarProposicao(p) {
  const sigla = (p.tipoProposicao && p.tipoProposicao.sigla) || p.tipo || '?';
  const descricao = (p.tipoProposicao && p.tipoProposicao.descricao) || sigla;

  const protocolo = p.protocolo || '-';
  const ano = protocolo.split('/')[1] || '-';
  const numProtocolo = parseInt(protocolo.split('/')[0]) || 0;

  // Número do projeto (campo "projeto" só vem preenchido para PL, PLC, PEC etc.)
  const numProjeto = p.projeto ? String(p.projeto) : null;
  const ehProjeto = SIGLAS_PROJETO.includes(sigla);

  // Rótulo principal: "PL 43/2026" para projetos, protocolo para o resto
  const rotulo = (ehProjeto && numProjeto)
    ? `${sigla} ${numProjeto}/${ano}`
    : protocolo;

  let data = '-';
  if (p.dataLeitura) {
    try { data = new Date(p.dataLeitura).toLocaleDateString('pt-BR'); } catch (_) {}
  }

  return {
    id: p.id,
    sigla,
    descricao,
    ehProjeto,
    rotulo,
    protocolo,
    numero: numProtocolo,
    autores: p.autores || '-',
    data,
    ementa: (p.resumo || p.resumoPesquisaFulltext || '-').substring(0, 300),
    link: `${URL_PROPOSICAO}${p.id}`,
    visivel: p.visivel,
  };
}

async function enviarEmail(novas) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  // Agrupa por descrição legível do tipo
  const porTipo = {};
  novas.forEach(p => {
    const chave = p.descricao || 'Outros';
    if (!porTipo[chave]) porTipo[chave] = [];
    porTipo[chave].push(p);
  });

  // PLC e PL aparecem primeiro, resto em ordem alfabética
  const prioridade = ['Projeto de Lei Complementar', 'Projeto de Lei'];
  const ordenarTipos = (a, b) => {
    const ia = prioridade.indexOf(a);
    const ib = prioridade.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b, 'pt-BR');
  };

  const linhas = Object.keys(porTipo).sort(ordenarTipos).map(tipo => {
    const itens = porTipo[tipo];
    itens.sort((a, b) => b.numero - a.numero);

    const header = `<tr><td colspan="4" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#003366;font-size:13px;border-top:2px solid #003366">${tipo} — ${itens.length} proposição(ões)</td></tr>`;

    const rows = itens.map(p => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap;vertical-align:top">
          <a href="${p.link}" style="color:#003366;font-weight:bold;text-decoration:none">${p.rotulo}</a>
          ${p.ehProjeto && p.numProjeto ? `<br><span style="font-size:11px;color:#888">Proto: ${p.protocolo}</span>` : ''}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;vertical-align:top">${p.autores}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap;vertical-align:top">${p.data}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;vertical-align:top">${p.ementa}</td>
      </tr>`).join('');

    return header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:960px;margin:0 auto">
      <h2 style="color:#003366;border-bottom:2px solid #003366;padding-bottom:8px">
        🏛️ ALEMS — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666;margin-top:0">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#003366;color:white">
            <th style="padding:10px;text-align:left;min-width:120px">Nº / Protocolo</th>
            <th style="padding:10px;text-align:left">Autor(es)</th>
            <th style="padding:10px;text-align:left">Data Leitura</th>
            <th style="padding:10px;text-align:left">Ementa</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:16px;font-size:12px;color:#999">
        <a href="https://sgpl.consulta.al.ms.gov.br/sgpl-publico/#/busca-proposicoes" style="color:#003366">Abrir portal ALEMS</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor ALEMS" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ ALEMS: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} proposições novas.`);
}

async function buscarPagina(page) {
  const params = new URLSearchParams({
    direction: 'desc',
    page: String(page),
    size: '100',
    sort: 'dataLeitura',
  });
  const url = `${API_BASE}/proposicao?${params}`;
  console.log(`🔍 Buscando página ${page}: ${url}`);

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });

  if (!response.ok) {
    const texto = await response.text();
    console.error(`❌ Erro ${response.status}: ${texto.substring(0, 300)}`);
    return null;
  }
  return await response.json();
}

async function buscarTodasProposicoes() {
  const primeira = await buscarPagina(1);
  if (!primeira) return [];

  let lista = [];
  let totalPaginas = 1;

  if (Array.isArray(primeira)) {
    lista = primeira;
    console.log(`📦 Array direto: ${lista.length} itens`);
  } else if (primeira.content) {
    lista = primeira.content;
    totalPaginas = primeira.totalPages || 1;
    console.log(`📦 Spring Page: ${lista.length} itens, ${totalPaginas} páginas`);
  } else if (primeira._embedded) {
    const chave = Object.keys(primeira._embedded)[0];
    lista = primeira._embedded[chave] || [];
    totalPaginas = (primeira.page && primeira.page.totalPages) || 1;
    console.log(`📦 HAL _embedded: ${lista.length} itens, ${totalPaginas} páginas`);
  } else if (primeira.lista) {
    lista = primeira.lista;
    console.log(`📦 Campo lista: ${lista.length} itens`);
  } else {
    console.log('📦 Estrutura desconhecida:', JSON.stringify(primeira).substring(0, 200));
  }

  const maxPaginas = Math.min(totalPaginas, 5);
  for (let page = 2; page <= maxPaginas; page++) {
    const dados = await buscarPagina(page);
    if (!dados) break;
    const mais = Array.isArray(dados) ? dados
      : dados.content || dados.lista
      || (dados._embedded ? dados._embedded[Object.keys(dados._embedded)[0]] : [])
      || [];
    if (mais.length === 0) break;
    lista = lista.concat(mais);
  }

  return lista;
}

(async () => {
  console.log('🚀 Iniciando monitor ALEMS (MS)...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas.map(String));

  const raw = await buscarTodasProposicoes();
  if (raw.length === 0) {
    console.log('⚠️ Nenhuma proposição encontrada.');
    process.exit(0);
  }

  console.log(`📊 Total bruto: ${raw.length}`);

  const proposicoes = raw
    .filter(p => p.visivel !== 'N')
    .map(normalizarProposicao)
    .filter(p => p.id);

  console.log(`📊 Total normalizado: ${proposicoes.length}`);

  const novas = proposicoes.filter(p => !idsVistos.has(String(p.id)));
  console.log(`🆕 Proposições novas: ${novas.length}`);

  if (novas.length > 0) {
    await enviarEmail(novas);
    novas.forEach(p => idsVistos.add(String(p.id)));
    estado.proposicoes_vistas = Array.from(idsVistos);
  } else {
    console.log('✅ Sem novidades. Nada a enviar.');
  }

  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
})();
