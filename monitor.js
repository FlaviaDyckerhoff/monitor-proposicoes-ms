const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';

// API do SGPL da ALEMS — endpoint descoberto via DevTools (GET com query params)
const API_BASE = 'https://sgpl.consulta.al.ms.gov.br/sgpl/sgpl-api/public';

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

async function enviarEmail(novas) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  // Agrupa por tipo
  const porTipo = {};
  novas.forEach(p => {
    const tipo = p.tipo || 'OUTROS';
    if (!porTipo[tipo]) porTipo[tipo] = [];
    porTipo[tipo].push(p);
  });

  const linhas = Object.keys(porTipo).sort().map(tipo => {
    const header = `<tr><td colspan="4" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#003366;font-size:13px;border-top:2px solid #003366">${tipo} — ${porTipo[tipo].length} proposição(ões)</td></tr>`;
    const rows = porTipo[tipo].map(p =>
      `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee"><strong>${p.protocolo || '-'}</strong></td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.autores || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${p.data || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.ementa || '-'}</td>
      </tr>`
    ).join('');
    return header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto">
      <h2 style="color:#003366;border-bottom:2px solid #003366;padding-bottom:8px">
        🏛️ ALEMS — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#003366;color:white">
            <th style="padding:10px;text-align:left">Protocolo</th>
            <th style="padding:10px;text-align:left">Autor(es)</th>
            <th style="padding:10px;text-align:left">Data Leitura</th>
            <th style="padding:10px;text-align:left">Ementa</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Acesse: <a href="https://sgpl.consulta.al.ms.gov.br/sgpl-publico/#/busca-proposicoes">sgpl.consulta.al.ms.gov.br</a>
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
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
  });

  if (!response.ok) {
    const texto = await response.text();
    console.error(`❌ Erro na API (página ${page}): ${response.status} ${response.statusText}`);
    console.error('Resposta:', texto.substring(0, 300));
    return null;
  }

  return await response.json();
}

function normalizarProposicao(p) {
  // Extrai número e ano do protocolo (ex: "00782/2026")
  const protocolo = p.protocolo || '';
  const [num, ano] = protocolo.split('/');

  // Formata data de leitura
  let data = '-';
  if (p.dataLeitura) {
    try {
      data = new Date(p.dataLeitura).toLocaleDateString('pt-BR');
    } catch (_) {}
  }

  return {
    id: p.id,
    tipo: p.tipo || 'OUTROS',
    protocolo: protocolo || '-',
    numero: parseInt(num) || 0,
    ano: ano || '-',
    autores: p.autores || '-',
    data,
    ementa: (p.resumo || p.resumoPesquisaFulltext || '-').substring(0, 250),
    visivel: p.visivel,
  };
}

async function buscarTodasProposicoes() {
  // Busca primeira página para saber total de páginas
  const primeira = await buscarPagina(1);
  if (!primeira) return [];

  // O SGPL com HAL geralmente retorna a lista diretamente ou em _embedded
  // Tentamos os formatos mais comuns
  let lista = [];
  let totalPaginas = 1;

  if (Array.isArray(primeira)) {
    // Resposta direta como array
    lista = primeira;
    console.log(`📦 Resposta em array direto: ${lista.length} itens`);
  } else if (primeira.content && Array.isArray(primeira.content)) {
    // Spring Page format
    lista = primeira.content;
    totalPaginas = primeira.totalPages || 1;
    console.log(`📦 Spring Page format: ${lista.length} itens, ${totalPaginas} páginas`);
  } else if (primeira._embedded) {
    // HAL _embedded format
    const chaves = Object.keys(primeira._embedded);
    lista = primeira._embedded[chaves[0]] || [];
    totalPaginas = (primeira.page && primeira.page.totalPages) || 1;
    console.log(`📦 HAL _embedded format: ${lista.length} itens, ${totalPaginas} páginas`);
  } else if (primeira.lista) {
    lista = primeira.lista;
    console.log(`📦 Campo 'lista': ${lista.length} itens`);
  } else {
    console.log('📦 Estrutura desconhecida:', JSON.stringify(primeira).substring(0, 200));
  }

  // Busca páginas adicionais (limita a 5 páginas = 500 proposições)
  const maxPaginas = Math.min(totalPaginas, 5);
  for (let page = 2; page <= maxPaginas; page++) {
    const dados = await buscarPagina(page);
    if (!dados) break;

    let mais = [];
    if (Array.isArray(dados)) mais = dados;
    else if (dados.content) mais = dados.content;
    else if (dados._embedded) {
      const chaves = Object.keys(dados._embedded);
      mais = dados._embedded[chaves[0]] || [];
    } else if (dados.lista) mais = dados.lista;

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
    console.log('⚠️ Nenhuma proposição encontrada. Verifique a API.');
    // Log da estrutura para debug
    process.exit(0);
  }

  console.log(`📊 Total bruto: ${raw.length}`);

  // Filtra apenas proposições visíveis (visivel === 'S')
  const proposicoes = raw
    .filter(p => p.visivel !== 'N')
    .map(normalizarProposicao)
    .filter(p => p.id);

  console.log(`📊 Total normalizado (visíveis): ${proposicoes.length}`);

  const novas = proposicoes.filter(p => !idsVistos.has(String(p.id)));
  console.log(`🆕 Proposições novas: ${novas.length}`);

  if (novas.length > 0) {
    // Ordena por tipo alfabético, depois por número decrescente dentro do tipo
    novas.sort((a, b) => {
      if (a.tipo < b.tipo) return -1;
      if (a.tipo > b.tipo) return 1;
      return b.numero - a.numero;
    });

    await enviarEmail(novas);

    novas.forEach(p => idsVistos.add(String(p.id)));
    estado.proposicoes_vistas = Array.from(idsVistos);
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  } else {
    console.log('✅ Sem novidades. Nada a enviar.');
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  }
})();
