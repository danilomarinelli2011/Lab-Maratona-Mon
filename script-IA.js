try {
    var params = JSON.parse(value);

    // ---- Validação dos parâmetros obrigatórios para a triagem com IA ----
    var obrigatorios = ['provider', 'api_key', 'event_name', 'host_name'];
    for (var i = 0; i < obrigatorios.length; i++) {
        if (typeof params[obrigatorios[i]] === 'undefined' || params[obrigatorios[i]] === '') {
            throw 'Parametro obrigatorio ausente ou vazio: "' + obrigatorios[i] + '"';
        }
    }

    var provider = params.provider.toLowerCase();
    var modelUsado = (params.model && params.model !== '')
        ? params.model
        : (provider === 'openai' ? 'gpt-5.6-terra' : 'gemini-2.5-flash');

    var prompt = montaPrompt(params);

    Zabbix.log(4, '[IA Triage] Provider=' + provider + ' Host=' + params.host_name + ' Evento=' + params.event_name);

    var respostaIA;
    if (provider === 'openai') {
        respostaIA = chamarOpenAI(params, prompt, modelUsado);
    } else if (provider === 'gemini') {
        respostaIA = chamarGemini(params, prompt, modelUsado);
    } else {
        throw 'Provider desconhecido: "' + params.provider + '". Use "openai" ou "gemini".';
    }

    // ---- Grava a resposta da IA como comentário do evento no Zabbix ----
    // Isso NAO aborta a execucao em caso de falha: o usuario ainda recebe a
    // resposta no pop-up, mas um aviso e anexado se o comentario nao pode
    // ser gravado (ex.: parametros da API do Zabbix ausentes ou incorretos).
    var avisoComentario = '';
    try {
        gravarComentarioNoEvento(params, formatarComentario(respostaIA, provider, modelUsado));
    } catch (errComentario) {
        Zabbix.log(3, '[IA Triage] Falha ao gravar comentario no evento: ' + errComentario);
        avisoComentario = '\n\n---\n[Aviso: esta resposta NAO foi gravada como comentario do evento. ' +
            'Verifique os parametros event_id / zabbix_api_url / zabbix_api_token do script. Detalhe: ' + errComentario + ']';
    }

    return respostaIA + avisoComentario;

} catch (error) {
    Zabbix.log(3, '[IA Triage] Falha na execucao: ' + error);
    // O throw faz o Zabbix exibir a mensagem de erro no pop-up de resultado do script
    throw 'Erro na triagem com IA: ' + error;
}

// -----------------------------------------------------------------------------
// Monta o prompt (mensagem "user") enviado ao modelo, com os dados do alarme
// ja resolvidos pelo Zabbix (parametros do script, nao macros cruas no texto)
// -----------------------------------------------------------------------------
function montaPrompt(p) {
    var partes = [];
    partes.push('Por favor, analise o seguinte incidente reportado pelo Zabbix e gere o plano de acao N0/N1 no formato definido nas instrucoes de sistema.');
    partes.push('Nao invente informacoes que nao foram fornecidas abaixo.');
    partes.push('');
    partes.push('=== DADOS DO INCIDENTE ===');
    partes.push('Trigger Name: ' + (p.event_name || 'N/D'));
    partes.push('Severity: ' + (p.event_severity || 'N/D'));
    if (p.trigger_status) partes.push('Status: ' + p.trigger_status);
    if (p.item_name || p.item_lastvalue) {
        partes.push('Item: ' + (p.item_name || 'N/D') + (p.item_key ? ' [' + p.item_key + ']' : ''));
    }
    if (p.item_lastvalue) partes.push('Item Last Value: ' + p.item_lastvalue);
    if (p.trigger_expression) partes.push('Trigger Expression: ' + p.trigger_expression);
    if (p.trigger_desc) partes.push('Trigger Description: ' + p.trigger_desc);
    partes.push('');
    partes.push('=== DADOS DO HOST ===');
    partes.push('Hostname: ' + (p.host_name || 'N/D'));
    if (p.host_ip) partes.push('IP Address: ' + p.host_ip);
    if (p.host_groups) partes.push('Host Group(s): ' + p.host_groups);
    if (p.host_desc) partes.push('Descricao do host: ' + p.host_desc);
    if (p.event_tags) partes.push('Tags do evento: ' + p.event_tags);
    partes.push('');
    partes.push('=== DADOS ADICIONAIS ===');
    partes.push('Event Time: ' + (p.event_time || 'N/D'));
    if (p.event_id) partes.push('Event ID: ' + p.event_id);
    partes.push('');
    partes.push('Responda em portugues, seguindo exatamente a estrutura de topicos definida nas instrucoes de sistema.');
    return partes.join('\n');
}

// -----------------------------------------------------------------------------
// Persona / instrucoes de sistema (papel "system") usadas tanto na OpenAI
// quanto no Gemini. Montada via array.join para evitar template literals.
// -----------------------------------------------------------------------------
function montaSystemPrompt() {
    var linhas = [];
    linhas.push('Voce e um Especialista de NOC Senior e Engenheiro de Confiabilidade (SRE), especialista em infraestrutura, redes, banco de dados e monitoramento com Zabbix.');
    linhas.push('Sua funcao e receber dados de uma "Trigger do Zabbix" que foi disparada e gerar um plano de acao rapido, seguro e estruturado para as equipes de suporte N0 (Triagem/Automacao) e N1 (Operacao Basica).');
    linhas.push('');
    linhas.push('DIRETRIZES DE COMPORTAMENTO:');
    linhas.push('1. Seja tecnico, direto e evite jargoes desnecessarios. Va direto a causa provavel.');
    linhas.push('2. Considere boas praticas de infraestrutura (Linux, Windows, Containers, Bancos de Dados e Cloud).');
    linhas.push('3. Nunca sugira comandos destrutivos (como rm -rf, drop table, reboot sem validacao previa) no nivel N0/N1.');
    linhas.push('4. Foque em restabelecer o servico ou coletar logs vitais antes que o cenario piore.');
    linhas.push('5. PROIBIDO ser generico. Toda recomendacao de investigacao ou correcao deve vir acompanhada do comando REAL, pronto para copiar e colar - nunca descreva a acao apenas em palavras.');
    linhas.push('   Exemplo do que NAO fazer: "verifique os processos que mais consomem memoria".');
    linhas.push('   Exemplo do que fazer: "ps aux --sort=-%mem | head -15 (lista os 15 processos que mais consomem RAM, ordenados do maior para o menor)".');
    linhas.push('6. Use as tags/categorias do evento (ex: CATEGORY:LINUX, CATEGORY:MEMORY, CATEGORY:DATABASE, APP:<nome>) para escolher os comandos certos para o sistema operacional/tecnologia/aplicacao envolvida. Se nao houver informacao suficiente para saber o SO, assuma Linux e deixe essa suposicao explicita em uma linha.');
    linhas.push('7. Ordene os comandos do mais rapido/menos invasivo para o mais aprofundado.');
    linhas.push('');
    linhas.push('REFERENCIA RAPIDA DE COMANDOS POR TIPO DE ALARME (adapte ao caso, nao copie cegamente todos):');
    linhas.push('- Memoria (Linux): free -h ; ps aux --sort=-%mem | head -15 ; ps -eo user,pid,%mem,rss,cmd --sort=-%mem | head -15 (consumo por usuario/processo) ; dmesg -T | grep -i -E "oom|killed process" ; journalctl -k --since "-30min" | grep -i oom ; swapon --show ; cat /proc/meminfo.');
    linhas.push('- CPU (Linux): uptime (load average) ; top -b -n1 -o %CPU | head -20 ; mpstat 1 5 ; pidstat 1 5 ; ps aux --sort=-%cpu | head -15.');
    linhas.push('- Disco (Linux): df -hT ; du -sh /var/log/* 2>/dev/null | sort -rh | head -10 ; lsof +L1 (arquivos deletados que ainda ocupam espaco) ; iostat -x 1 5.');
    linhas.push('- Rede: ss -tunap | head -30 ; netstat -s | grep -i retrans ; ethtool -S <interface> | grep -i err ; testar rota/latencia com ping e traceroute.');
    linhas.push('- Banco de dados (generico): conexoes ativas e queries lentas/travadas (ex: SHOW FULL PROCESSLIST no MySQL, SELECT * FROM pg_stat_activity no PostgreSQL), locks, uso de espaco em tablespaces/datafiles.');
    linhas.push('- Servico/HTTP fora do ar: systemctl status <servico> ; journalctl -u <servico> -n 100 --no-pager ; curl -I <endpoint> ; verificar a porta com ss -tlnp | grep <porta>.');
    linhas.push('- Windows (quando indicado nas tags): Get-Process | Sort-Object WS -Descending | Select -First 15 ; Get-Counter "\\Memory\\Available MBytes" ; Get-EventLog -LogName System -Newest 50.');
    linhas.push('');
    linhas.push('FORMATO DE SAIDA OBRIGATORIO:');
    linhas.push('Estruture sua resposta sempre com os seguintes topicos:');
    linhas.push('');
    linhas.push('## Diagnostico Preliminar');
    linhas.push('- O que essa trigger significa tecnicamente? (Explique o problema em 1 ou 2 frases).');
    linhas.push('- Qual e o provavel impacto no ambiente ou na aplicacao?');
    linhas.push('');
    linhas.push('## Analise N0 (Triagem e Validacao Rapida)');
    linhas.push('- Liste de 3 a 5 comandos REAIS (nao genericos) para validar se e falso positivo e coletar evidencias. Para cada comando, explique em 1 linha o que se espera ver no resultado e o que indicaria problema real.');
    linhas.push('');
    linhas.push('## Execucao de Suporte N1 (Acao Corretiva)');
    linhas.push('- Passo a passo claro para o analista N1 tentar resolver o incidente, com comandos exatos ou caminhos de paineis/logs que devem ser acessados.');
    linhas.push('- Qual o criterio de sucesso? (Como o N1 sabe que resolveu o problema?).');
    linhas.push('');
    linhas.push('## Criterio de Escalonamento (N2/N3)');
    linhas.push('- O que deve acontecer para que o N1 pare a tratativa e escale o chamado imediatamente para as equipes especialistas?');
    return linhas.join('\n');
}

// -----------------------------------------------------------------------------
// Formata a resposta da IA com um cabecalho antes de gravar como comentario
// -----------------------------------------------------------------------------
function formatarComentario(resposta, provider, model) {
    var cabecalho = '[Triagem automatica via IA - provider: ' + provider + ' / modelo: ' + model + ']';
    return cabecalho + '\n\n' + resposta;
}

// -----------------------------------------------------------------------------
// Chamada a API da OpenAI (Chat Completions)
// -----------------------------------------------------------------------------
function chamarOpenAI(p, prompt, model) {
    var url = (p.api_url && p.api_url !== '') ? p.api_url : 'https://api.openai.com/v1/chat/completions';

    var payload = {
        model: model,
        messages: [
            { role: 'system', content: montaSystemPrompt() },
            { role: 'user', content: prompt }
        ],
        temperature: 2.0,
        max_tokens: 3000
    };

    var req = new HttpRequest();
    if (p.HTTPProxy) {
        req.setProxy(p.HTTPProxy);
    }
    req.addHeader('Content-Type: application/json');
    req.addHeader('Authorization: Bearer ' + p.api_key);

    var resp = req.post(url, JSON.stringify(payload));

    if (req.getStatus() < 200 || req.getStatus() >= 300) {
        throw 'OpenAI respondeu HTTP ' + req.getStatus() + ': ' + resp;
    }

    var data = JSON.parse(resp);
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw 'Resposta inesperada da OpenAI: ' + resp;
    }

    return data.choices[0].message.content.trim();
}

// -----------------------------------------------------------------------------
// Chamada a API do Gemini (generateContent)
// -----------------------------------------------------------------------------
function chamarGemini(p, prompt, model) {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';

    var payload = {
        systemInstruction: {
            parts: [ { text: montaSystemPrompt() } ]
        },
        contents: [
            { parts: [ { text: prompt } ] }
        ],
        generationConfig: {
            temperature: 2.0,
            maxOutputTokens: 3000
        }
    };

    var req = new HttpRequest();
    if (p.HTTPProxy) {
        req.setProxy(p.HTTPProxy);
    }
    req.addHeader('Content-Type: application/json');
    req.addHeader('x-goog-api-key: ' + p.api_key);

    var resp = req.post(url, JSON.stringify(payload));

    if (req.getStatus() < 200 || req.getStatus() >= 300) {
        throw 'Gemini respondeu HTTP ' + req.getStatus() + ': ' + resp;
    }

    var data = JSON.parse(resp);
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
        throw 'Resposta inesperada do Gemini: ' + resp;
    }

    return data.candidates[0].content.parts[0].text.trim();
}

// -----------------------------------------------------------------------------
// Grava a resposta da IA como comentario do evento, via API do Zabbix
// (event.acknowledge com action=4 -> "Add message" / adicionar comentario)
// Requer os parametros: event_id, zabbix_api_url, zabbix_api_token
// -----------------------------------------------------------------------------
function gravarComentarioNoEvento(p, mensagem) {
    if (!p.event_id || !p.zabbix_api_url || !p.zabbix_api_token) {
        throw 'parametros ausentes (event_id / zabbix_api_url / zabbix_api_token) - comentario nao gravado';
    }

    // Bitmask de acoes do event.acknowledge:
    // 1=fechar problema, 2=reconhecer, 4=adicionar mensagem, 8=mudar severidade,
    // 16=desreconhecer, 32=suprimir, 64=desuprimir, 128=marcar como causa, 256=marcar como sintoma.
    // Default aqui: 4 (somente adicionar o comentario, sem reconhecer o evento).
    var action = (p.zabbix_ack_action && !isNaN(parseInt(p.zabbix_ack_action, 10)))
        ? parseInt(p.zabbix_ack_action, 10)
        : 4;

    var payload = {
        jsonrpc: '2.0',
        method: 'event.acknowledge',
        params: {
            eventids: [ p.event_id ],
            action: action,
            message: mensagem
        },
        id: 1
    };

    var req = new HttpRequest();
    if (p.HTTPProxy) {
        req.setProxy(p.HTTPProxy);
    }
    req.addHeader('Content-Type: application/json-rpc');
    req.addHeader('Authorization: Bearer ' + p.zabbix_api_token);

    var resp = req.post(p.zabbix_api_url, JSON.stringify(payload));

    if (req.getStatus() < 200 || req.getStatus() >= 300) {
        throw 'API do Zabbix respondeu HTTP ' + req.getStatus() + ': ' + resp;
    }

    var data = JSON.parse(resp);
    if (data.error) {
        throw 'API do Zabbix retornou erro: ' + JSON.stringify(data.error);
    }

    Zabbix.log(4, '[IA Triage] Comentario gravado com sucesso no evento ' + p.event_id + ' (action=' + action + ')');
}
