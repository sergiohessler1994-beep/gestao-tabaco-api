const express = require('express');
const cors = require('cors');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-5.6-luna').trim();

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

const nfLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Limite temporário de análises atingido. Tente novamente mais tarde.',
  },
});

const notaFiscalSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tipo_documento: { type: 'string' },
    fornecedor: { type: 'string' },
    cnpj_fornecedor: { type: 'string' },
    numero_nf: { type: 'string' },
    serie: { type: 'string' },
    data_emissao: { type: 'string' },
    total_nota: { type: 'string' },
    itens: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          produto: { type: 'string' },
          quantidade: { type: 'string' },
          unidade: { type: 'string' },
          preco_unitario: { type: 'string' },
          valor_total: { type: 'string' },
          ncm: { type: 'string' },
          cfop: { type: 'string' },
        },
        required: [
          'produto',
          'quantidade',
          'unidade',
          'preco_unitario',
          'valor_total',
          'ncm',
          'cfop',
        ],
      },
    },
    observacoes: { type: 'string' },
  },
  required: [
    'tipo_documento',
    'fornecedor',
    'cnpj_fornecedor',
    'numero_nf',
    'serie',
    'data_emissao',
    'total_nota',
    'itens',
    'observacoes',
  ],
};

const instrucaoNotaFiscal = `
Você é o módulo de leitura documental do aplicativo Gestão Tabaco.
Sua tarefa é ler uma NF-e/DANFE e transformar o conteúdo em dados estruturados.

REGRAS OBRIGATÓRIAS:
1. Leia o documento visualmente e também considere o texto extraído do PDF.
2. Extraia TODOS os produtos/serviços da tabela de itens, não apenas o primeiro.
3. Em DANFEs, a descrição do produto pode estar em uma ou mais linhas e a linha fiscal seguinte pode conter NCM, CST, CFOP, unidade, quantidade, valor unitário e valor total. Relacione corretamente essas linhas.
4. NÃO invente dados. Se um campo não puder ser lido com segurança, deixe a string vazia.
5. Preserve os valores numéricos encontrados no documento. Para números decimais, use ponto como separador decimal no JSON, por exemplo 88.5828.
6. Para a data, use DD/MM/AAAA quando essa forma estiver visível no documento.
7. A unidade deve ser exatamente a unidade de comercialização quando possível, por exemplo kg, g, L, mL, LT1, GL5, KG, UN, saco ou outra unidade visível.
8. Não confunda NCM, CFOP ou CST com quantidade ou preço.
9. Se houver várias páginas, considere todas elas.
10. Confira se a quantidade x preço unitário é compatível com o valor total. Não altere o valor do documento para fazer a conta fechar; se houver diferença, mantenha os valores lidos e informe em observacoes.
11. A resposta deve conter somente o JSON exigido pelo esquema.
`;

function mimeFromName(filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  switch (ext) {
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'heic': return 'image/heic';
    case 'heif': return 'image/heif';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'pdf': return 'application/pdf';
    default: return '';
  }
}

function extractResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text;
  }

  const parts = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        parts.push(part.text);
      }
    }
  }
  return parts.join('\n');
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'gestao-tabaco-api',
    model: OPENAI_MODEL,
  });
});

app.post('/api/ler-nota-fiscal', nfLimiter, upload.single('file'), async (req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        error: 'OPENAI_API_KEY não configurada no servidor.',
      });
    }

    if (!req.file || !req.file.buffer?.length) {
      return res.status(400).json({
        error: 'Nenhum arquivo foi enviado.',
      });
    }

    const mime = mimeFromName(req.file.originalname);
    if (!['application/pdf', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/jpeg'].includes(mime)) {
      return res.status(400).json({
        error: 'Formato não suportado. Envie PDF, JPG, JPEG, PNG, WEBP, HEIC ou HEIF.',
      });
    }

    const base64 = req.file.buffer.toString('base64');

    const content = [
      {
        type: 'input_text',
        text: `${instrucaoNotaFiscal}\n\nO arquivo recebido é do tipo ${mime === 'application/pdf' ? 'pdf' : 'imagem'}.\nAnalise o documento inteiro e retorne os dados da nota fiscal.`,
      },
    ];

    if (mime === 'application/pdf') {
      content.push({
        type: 'input_file',
        filename: req.file.originalname || 'nota_fiscal.pdf',
        file_data: `data:application/pdf;base64,${base64}`,
      });
    } else {
      content.push({
        type: 'input_image',
        image_url: `data:${mime};base64,${base64}`,
        detail: 'high',
      });
    }

    const body = {
      model: OPENAI_MODEL,
      input: [
        {
          role: 'user',
          content,
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'nota_fiscal_extraction',
          strict: true,
          schema: notaFiscalSchema,
        },
      },
      max_output_tokens: 12000,
    };

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const raw = await response.text();

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const errorBody = JSON.parse(raw);
        if (errorBody?.error?.message) message = errorBody.error.message;
      } catch (_) {}
      return res.status(502).json({
        error: `A OpenAI recusou a solicitação: ${message}`,
      });
    }

    let decoded;
    try {
      decoded = JSON.parse(raw);
    } catch (_) {
      return res.status(502).json({
        error: 'A resposta da OpenAI não veio em JSON válido.',
      });
    }

    const text = extractResponseText(decoded);
    if (!text.trim()) {
      return res.status(502).json({
        error: 'A OpenAI não retornou dados estruturados para a nota fiscal.',
      });
    }

    let result;
    try {
      result = JSON.parse(text);
    } catch (_) {
      return res.status(502).json({
        error: 'A OpenAI retornou um formato inesperado ao ler a nota fiscal.',
      });
    }

    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return res.status(502).json({
        error: 'A OpenAI não retornou um objeto de dados para a nota fiscal.',
      });
    }

    return res.json(result);
  } catch (error) {
    console.error('Erro em /api/ler-nota-fiscal:', error);
    return res.status(500).json({
      error: 'Erro interno ao processar a nota fiscal.',
    });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'Arquivo muito grande. O limite é de 15 MB.',
    });
  }

  console.error('Erro não tratado:', error);
  return res.status(500).json({
    error: 'Erro interno do servidor.',
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Gestão Tabaco API rodando na porta ${PORT}`);
});
