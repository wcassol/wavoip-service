import express from 'express'
import { createServer } from 'http'
import { Server as SocketIO } from 'socket.io'
import cors from 'cors'
import path from 'path'
import { Wavoip } from '@wavoip/wavoip-api'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? 3100)
const WAVOIP_TOKENS = (process.env.WAVOIP_DEVICE_TOKENS ?? '').split(',').filter(Boolean)
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL ?? ''
const API_SECRET = process.env.API_SECRET ?? 'troque-esta-chave'

if (!WAVOIP_TOKENS.length) {
  console.error('[wavoip-service] WAVOIP_DEVICE_TOKENS nao configurado. Encerrando.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// HTTP + Socket.IO
// ---------------------------------------------------------------------------
const app = express()
const httpServer = createServer(app)

const io = new SocketIO(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
})

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ---------------------------------------------------------------------------
// Wavoip SDK
// ---------------------------------------------------------------------------
const wavoip = new Wavoip({ tokens: WAVOIP_TOKENS })

// Mapa callId -> objeto de chamada ativa (para poder encerrar/mutar via REST)
const activeCalls = new Map<string, any>()

// ---------------------------------------------------------------------------
// Eventos Wavoip -> Socket.IO (broadcast para todos os atendentes conectados)
// ---------------------------------------------------------------------------
wavoip.onOffer((offer) => {
  console.log(`[wavoip] Ligacao recebida de ${offer.peer.phone}`)

  io.emit('incoming-call', {
    callId: offer.id,
    deviceToken: offer.device_token,
    phone: offer.peer.phone,
    name: offer.peer.displayName ?? offer.peer.phone,
    photo: offer.peer.profilePicture ?? null
  })

  // Atendente tem 30s para responder antes de recusar automaticamente
  const timeout = setTimeout(async () => {
    if (!activeCalls.has(offer.id)) {
      await offer.reject()
      io.emit('call-missed', { callId: offer.id, phone: offer.peer.phone })
      notifyN8n('missed', { callId: offer.id, phone: offer.peer.phone })
    }
  }, 30_000)

  offer.onEnd(() => clearTimeout(timeout))

  // Guarda a oferta para poder aceitar/rejeitar via REST
  activeCalls.set(offer.id, { type: 'offer', offer, timeout })
})

// ---------------------------------------------------------------------------
// Socket.IO: eventos dos atendentes (widget) -> Wavoip
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log(`[socket.io] Atendente conectado: ${socket.id}`)

  // Atendente aceita chamada recebida
  socket.on('accept-call', async ({ callId }: { callId: string }) => {
    const entry = activeCalls.get(callId)
    if (!entry || entry.type !== 'offer') return

    clearTimeout(entry.timeout)
    const { call, err } = await entry.offer.accept()
    if (err) {
      socket.emit('call-error', { callId, message: err })
      return
    }

    activeCalls.set(callId, { type: 'active', call })
    io.emit('call-active', { callId, phone: entry.offer.peer.phone })
    attachActiveCallEvents(callId, call)
  })

  // Atendente rejeita chamada recebida
  socket.on('reject-call', async ({ callId }: { callId: string }) => {
    const entry = activeCalls.get(callId)
    if (!entry || entry.type !== 'offer') return
    clearTimeout(entry.timeout)
    await entry.offer.reject()
    activeCalls.delete(callId)
  })

  // Atendente encerra chamada ativa
  socket.on('end-call', async ({ callId }: { callId: string }) => {
    const entry = activeCalls.get(callId)
    if (!entry) return
    if (entry.type === 'active') await entry.call.end()
    else if (entry.type === 'outgoing') await entry.call.end()
    activeCalls.delete(callId)
  })

  // Mute / unmute
  socket.on('mute', async ({ callId }: { callId: string }) => {
    const entry = activeCalls.get(callId)
    if (entry?.type === 'active') await entry.call.mute()
  })

  socket.on('unmute', async ({ callId }: { callId: string }) => {
    const entry = activeCalls.get(callId)
    if (entry?.type === 'active') await entry.call.unmute()
  })

  socket.on('disconnect', () => {
    console.log(`[socket.io] Atendente desconectado: ${socket.id}`)
  })
})

// ---------------------------------------------------------------------------
// Helpers: eventos de uma chamada ativa
// ---------------------------------------------------------------------------
function attachActiveCallEvents(callId: string, call: any) {
  call.onEnd(() => {
    io.emit('call-ended', { callId })
    activeCalls.delete(callId)
    notifyN8n('ended', { callId })
  })

  call.onError((err: string) => {
    io.emit('call-error', { callId, message: err })
  })

  call.onPeerMute(() => io.emit('peer-muted', { callId }))
  call.onPeerUnmute(() => io.emit('peer-unmuted', { callId }))

  call.onStats((stats: any) => {
    io.emit('call-stats', { callId, stats })
  })
}

// ---------------------------------------------------------------------------
// REST API (chamada de dentro do ZapConnecta ou do n8n)
// ---------------------------------------------------------------------------

// Middleware de autenticacao simples por header
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = req.headers['x-api-key']
  if (key !== API_SECRET) {
    res.status(401).json({ error: 'Nao autorizado' })
    return
  }
  next()
}

// POST /api/call  { phone: "5584999999999" }
// Inicia uma ligacao de saida para o numero informado
app.post('/api/call', requireAuth, async (req, res) => {
  const { phone, deviceToken } = req.body as { phone: string; deviceToken?: string }

  if (!phone) {
    res.status(400).json({ error: 'Campo phone obrigatorio' })
    return
  }

  const { call, err } = await wavoip.startCall({
    to: phone,
    fromTokens: deviceToken ? [deviceToken] : undefined
  })

  if (err) {
    console.error('[wavoip] Erro ao iniciar chamada:', err)
    res.status(500).json({ error: err })
    return
  }

  activeCalls.set(call.id, { type: 'outgoing', call })

  io.emit('outgoing-call', {
    callId: call.id,
    phone,
    deviceToken: call.device_token
  })

  call.onPeerAccept((activeCall: any) => {
    activeCalls.set(call.id, { type: 'active', call: activeCall })
    io.emit('call-active', { callId: call.id, phone })
    attachActiveCallEvents(call.id, activeCall)
  })

  call.onPeerReject(() => {
    io.emit('call-rejected', { callId: call.id, phone })
    activeCalls.delete(call.id)
  })

  call.onUnanswered(() => {
    io.emit('call-unanswered', { callId: call.id, phone })
    activeCalls.delete(call.id)
    notifyN8n('unanswered', { callId: call.id, phone })
  })

  res.json({ callId: call.id, status: 'ringing' })
})

// GET /api/devices   Retorna status dos dispositivos configurados
app.get('/api/devices', requireAuth, (_req, res) => {
  const devices = wavoip.devices.map((d: any) => ({
    token: d.token,
    status: d.status,
    phone: d.contact?.phone ?? null
  }))
  res.json({ devices })
})

// GET /api/calls   Lista chamadas ativas no momento
app.get('/api/calls', requireAuth, (_req, res) => {
  const calls = Array.from(activeCalls.entries()).map(([id, entry]) => ({
    callId: id,
    type: entry.type
  }))
  res.json({ calls })
})

// ---------------------------------------------------------------------------
// Notificacao para o n8n
// ---------------------------------------------------------------------------
async function notifyN8n(event: string, data: Record<string, unknown>) {
  if (!N8N_WEBHOOK_URL) return
  try {
    await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, ...data, timestamp: new Date().toISOString() })
    })
  } catch (e) {
    console.error('[wavoip-service] Falha ao notificar n8n:', e)
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
httpServer.listen(PORT, () => {
  console.log(`[wavoip-service] Rodando na porta ${PORT}`)
  console.log(`[wavoip-service] Dispositivos: ${WAVOIP_TOKENS.length}`)
})
