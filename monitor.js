const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;

const API_BASE = 'https://sgpl.consulta.al.ms.gov.br/sgpl/sgpl-api/public';
const URL_PROPOSICAO = 'https://sgpl.consulta.al.ms.gov.br/sgpl-publico/#/linha-tempo?idProposicao=';
const MAX_PAGINAS_COLETA = 50;
const MAX_NOVAS_SEM_TRAVA = 200;
const DIAS_RETROATIVOS_SEGUROS = 30;

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
  let dataLeituraISO = null;
  if (p.dataLeitura) {
    try {
      const parsed = new Date(p.dataLeitura);
      data = parsed.toLocaleDateString('pt-BR');
      dataLeituraISO = parsed.toISOString();
    } catch (_) {}
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
    dataLeituraISO,
    ementa: (p.resumo || p.resumoPesquisaFulltext || '-'),
    link: `${URL_PROPOSICAO}${p.id}`,
    visivel: p.visivel,
  };
}

function dataLeituraMs(p) {
  if (!p.dataLeituraISO) return null;
  const ms = Date.parse(p.dataLeituraISO);
  return Number.isFinite(ms) ? ms : null;
}

function loteRetroativoSuspeito(novas) {
  if (novas.length <= MAX_NOVAS_SEM_TRAVA) return null;

  const cutoff = Date.now() - (DIAS_RETROATIVOS_SEGUROS * 24 * 60 * 60 * 1000);
  const antigas = novas.filter(p => {
    const ms = dataLeituraMs(p);
    return ms !== null && ms < cutoff;
  });

  if (antigas.length / novas.length < 0.5) return null;

  return {
    total: novas.length,
    antigas: antigas.length,
    cutoff: new Date(cutoff).toISOString(),
  };
}


const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario', 'Boticário', 'Abrasel', 'ANBRASEL',
  'Energisa', 'EnergisaLuz', 'SABESP', 'COMGAS', 'COMGÁS', 'Eletromidia', 'Eletromídia',
  'BRT', 'Regenera', 'Nova Infra', 'Seta', 'SETA', 'AkzoNobel', 'Expedia', 'RTSC',
  'Huawei', 'Carrefour', 'JBS', 'Ajinomoto', 'Vibra', 'Mindlab', 'ABVTEX', 'Neoenergia', 'ENEL'
];

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return achados;
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    p.clientesCitados = clientes;
    if (clientes.length && p.ementa && !String(p.ementa).includes('Cliente citado:')) {
      p.ementa = String(p.ementa).trim() + ' | Cliente citado: ' + clientes.join(', ');
    }
  }
}

function mlEscapeHtmlClienteDestaque(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mlEscapeRegExpClienteDestaque(valor) {
  return String(valor).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function mlDestacarTermosClienteEmail(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return mlEscapeHtmlClienteDestaque(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(mlEscapeRegExpClienteDestaque).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return mlEscapeHtmlClienteDestaque(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#dbeafe;color:#1e3a8a;font-weight:700;border-radius:3px;padding:1px 3px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | Cliente citado: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#eef6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700">' +
    'Cliente citado: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}

async function enviarEmail(novas) {
  anotarClientesCitados(novas);
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
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;vertical-align:top">${renderizarEmentaCliente(p)}</td>
      </tr>`).join('');

    return header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:960px;margin:0 auto">
      <h2 style="color:#003366;border-bottom:2px solid #003366;padding-bottom:8px">
        🏛️ Assembleia Legislativa de Mato Grosso do Sul — ${novas.length} nova(s) proposição(ões)
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
        <a href="https://sgpl.consulta.al.ms.gov.br/sgpl-publico/#/busca-proposicoes" style="color:#003366">Abrir portal da Assembleia Legislativa de Mato Grosso do Sul</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor Mato Grosso do Sul" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ Mato Grosso do Sul: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} proposições novas.`);
}

async function enviarAlertaLoteSuspeito(novas, diagnostico) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  const exemplos = novas.slice(0, 15).map(p =>
    `<li><a href="${p.link}" style="color:#003366">${p.rotulo}</a> — ${p.data} — ${p.autores}</li>`
  ).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:760px;margin:0 auto">
      <h2 style="color:#8a4b00;border-bottom:2px solid #8a4b00;padding-bottom:8px">
        ⚠️ Monitor MS: lote retroativo bloqueado
      </h2>
      <p>O monitor encontrou <strong>${diagnostico.total}</strong> proposições ainda não vistas, mas <strong>${diagnostico.antigas}</strong> têm Data Leitura anterior aos últimos ${DIAS_RETROATIVOS_SEGUROS} dias.</p>
      <p>Para evitar repetir o erro de enviar acervo antigo como “novidade”, o lote foi usado apenas para atualizar o estado interno.</p>
      <p style="margin-bottom:4px"><strong>Primeiros exemplos do lote bloqueado:</strong></p>
      <ul>${exemplos}</ul>
      <p style="margin-top:16px;font-size:12px;color:#999">
        <a href="https://sgpl.consulta.al.ms.gov.br/sgpl-publico/#/busca-proposicoes" style="color:#003366">Abrir portal da Assembleia Legislativa de Mato Grosso do Sul</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor Mato Grosso do Sul" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `⚠️ Mato Grosso do Sul: lote retroativo bloqueado — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`⚠️ Alerta operacional enviado: lote retroativo bloqueado com ${diagnostico.total} itens.`);
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
    throw new Error(`Erro na API: ${response.status} ${response.statusText} — ${texto.substring(0, 300)}`);
  }
  return await response.json();
}

async function buscarTodasProposicoes() {
  const primeira = await buscarPagina(1);

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

  const maxPaginas = Math.min(totalPaginas, MAX_PAGINAS_COLETA);
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
    const diagnosticoLoteSuspeito = loteRetroativoSuspeito(novas);
    if (diagnosticoLoteSuspeito) {
      console.log(`⚠️ Lote retroativo suspeito: ${diagnosticoLoteSuspeito.total} novas, ${diagnosticoLoteSuspeito.antigas} antigas. Bloqueando email detalhado.`);
      await enviarAlertaLoteSuspeito(novas, diagnosticoLoteSuspeito);
    } else {
      await enviarEmail(novas);
    }
    novas.forEach(p => idsVistos.add(String(p.id)));
    estado.proposicoes_vistas = Array.from(idsVistos);
  } else {
    console.log('✅ Sem novidades. Nada a enviar.');
  }

  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
})();
