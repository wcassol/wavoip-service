# wavoip-service

Serviço de telefonia via WhatsApp para o ZapConnecta, usando o Wavoip SaaS.

## Stack

- Node.js 20 + TypeScript
- Express (REST API + serve do widget)
- Socket.IO (relay de eventos em tempo real)
- @wavoip/wavoip-api (SDK oficial do Wavoip)

## Pré-requisitos

1. Conta ativa em https://app.wavoip.com
2. Pelo menos um Dispositivo criado e com número de WhatsApp vinculado
3. Token do dispositivo copiado do painel do Wavoip

## Deploy no Easypanel

### 1. Criar o app

- Easypanel > New Service > App
- Source: GitHub (aponte para este repositório)
- Build: Dockerfile
- Port: 3100

### 2. Variáveis de ambiente

```
WAVOIP_DEVICE_TOKENS=<token-do-dispositivo>
N8N_WEBHOOK_URL=https://webhook.zapconnecta.com/webhook/wavoip-call
API_SECRET=<chave-secreta-aleatoria>
PORT=3100
```

### 3. Domínio

Configure o domínio `voip.zapconnecta.com` apontando para este app.
HTTPS é obrigatório (o Easypanel provisiona automaticamente via Let's Encrypt).

## Endpoints da API

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | /api/call | Inicia chamada de saída |
| GET | /api/devices | Lista dispositivos e status |
| GET | /api/calls | Lista chamadas ativas |

Todos os endpoints precisam do header: `x-api-key: <API_SECRET>`

### Exemplo: iniciar chamada pelo n8n ou ZapConnecta

```bash
curl -X POST https://voip.zapconnecta.com/api/call \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_CHAVE" \
  -d '{"phone": "5584999999999"}'
```

## Widget (iframe)

O widget fica disponível em: `https://voip.zapconnecta.com`

### Embed no ZapConnecta

```html
<iframe
  src="https://voip.zapconnecta.com"
  style="width:100%;height:420px;border:none;border-radius:12px;"
  allow="microphone"
></iframe>
```

### Enviar número para o widget via postMessage

```javascript
// No ZapConnecta, ao abrir o contato:
const iframe = document.querySelector('iframe[src*="voip.zapconnecta.com"]')
iframe.contentWindow.postMessage({
  type: 'call',
  phone: '5584999999999'
}, '*')

// Apenas preencher o campo sem ligar:
iframe.contentWindow.postMessage({
  type: 'set-contact',
  phone: '5584999999999',
  name: 'João da Silva'
}, '*')
```

### Receber eventos do widget

```javascript
window.addEventListener('message', (event) => {
  if (event.data?.source !== 'wavoip-widget') return
  const { type, callId, phone, duration } = event.data

  switch (type) {
    case 'incoming-call':
      // Mostrar notificação no CRM
      break
    case 'call-active':
      // Registrar início da chamada no histórico
      break
    case 'call-ended':
      // Registrar fim + duração em segundos
      console.log(`Chamada encerrada: ${duration}s`)
      break
  }
})
```

## Webhook Wavoip (pós-chamada)

Configure em: app.wavoip.com > Dispositivo > Integrações > Webhook

URL: `https://webhook.zapconnecta.com/webhook/wavoip-call`

Eventos recomendados: CALL, RECORD

O n8n recebe os eventos e pode:
- Registrar a chamada no histórico do contato
- Baixar e transcrever o áudio (Whisper)
- Enviar resumo via WhatsApp para o atendente

## Desenvolvimento local

```bash
cp .env.example .env
# edite o .env com seus tokens
npm install
npm run dev
```

O serviço sobe em http://localhost:3100
