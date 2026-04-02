import express from 'express'
import { createServer } from 'http'
import { Server as SocketIO } from 'socket.io'
import cors from 'cors'
import path from 'path'

const PORT = Number(process.env.PORT ?? 3100)
const API_SECRET = process.env.API_SECRET ?? 'troque-esta-chave'

const app = express()
const httpServer = createServer(app)

const io = new SocketIO(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
})

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = req.headers['x-api-key']
  if (key !== API_SECRET) {
    res.status(401).json({ error: 'Nao autorizado' })
    return
  }
  next()
}

// REST: ZapConnecta envia numero -> relay para o widget iniciar chamada
app.post('/api/call', requireAuth, (req, res) => {
  const { phone } = req.body as { phone: string }
  if (!phone) {
    res.status(400).json({ error: 'Campo phone obrigatorio' })
    return
  }
  io.emit('request-call', { phone })
  res.json({ status: 'dispatched', phone })
})

// Socket.IO: relay de eventos do widget para sistemas externos
io.on('connection', (socket) => {
  console.log(`[socket.io] conectado: ${socket.id}`)

  socket.on('incoming-call', (data) => socket.broadcast.emit('incoming-call', data))
  socket.on('call-active',   (data) => socket.broadcast.emit('call-active', data))
  socket.on('call-ended',    (data) => { socket.broadcast.emit('call-ended', data); notifyN8n('ended', data) })
  socket.on('call-missed',   (data) => { socket.broadcast.emit('call-missed', data); notifyN8n('missed', data) })

  socket.on('disconnect', () => console.log(`[socket.io] desconectado: ${socket.id}`))
})

async function notifyN8n(event: string, data: Record<string, unknown>) {
  const url = process.env.N8N_WEBHOOK_URL
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, ...data, timestamp: new Date().toISOString() })
    })
  } catch (e) {
    console.error('[wavoip-service] Falha ao notificar n8n:', e)
  }
}

httpServer.listen(PORT, () => {
  console.log(`[wavoip-service] Porta ${PORT}`)
})
