import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

type File = { fid: string; parent: string; name: string; directory: boolean; body: string; account: string }
type Upload = { fid: string; parent: string; name: string; account: string; body?: string; committed?: boolean; md5?: string; sha1?: string }
export class QuarkFixture {
  files = new Map<string, File>()
  uploads = new Map<string, Upload>()
  tokens = new Map<string, string>()
  sessions = new Map<string, string>()
  nextAccount = 'rain'
  unavailable = false
  failUpload = false
  expired = false
  qrExpired = false
  qrPending = false
  loginRedirect = false
  downloadsCorrupt = false
  requests = 0
  deleted = 0
  hiddenVersions = new Set<string>()
  parallelUploads = 0
  waitingUploads: (() => void)[] = []
  reset() {
    this.files.clear(); this.uploads.clear(); this.tokens.clear(); this.sessions.clear()
    this.hiddenVersions.clear()
    for (const release of this.waitingUploads) release()
    this.parallelUploads = 0; this.waitingUploads = []
    this.nextAccount = 'rain'; this.unavailable = false; this.failUpload = false; this.expired = false; this.qrExpired = false; this.qrPending = false; this.loginRedirect = false; this.downloadsCorrupt = false; this.requests = 0; this.deleted = 0
  }
  snapshots(account = 'rain') { return [...this.files.values()].filter(file => file.account === account && !file.directory) }
  async handle(req: IncomingMessage, res: ServerResponse, origin: string) {
    const url = new URL(`https://${req.headers.host}${req.url}`)
    const path = url.pathname
    if (!path.startsWith('/cas/') && !path.startsWith('/account/') && !path.startsWith('/1/clouddrive/') && !path.startsWith('/quark-content/') && !path.startsWith('//objects/')) return false
    this.requests++
    const send = (data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data)); return true }
    const ok = (data: unknown = {}) => send({ status: 200, code: 0, data })
    if (this.unavailable) return send({ message: 'fixture offline' }, 503)
    const cookie = req.headers.cookie ?? ''
    if (path.endsWith('/getTokenForQrcodeLogin')) {
      const token = randomUUID()
      this.tokens.set(token, this.nextAccount)
      res.setHeader('Set-Cookie', `qr_seed=${token}; Secure; HttpOnly; Path=/; SameSite=None`)
      return send({ status: 2000000, message: 'ok', data: { members: { token } } })
    }
    if (path.endsWith('/getServiceTicketByQrcodeToken')) {
      const token = url.searchParams.get('token') ?? ''
      if (!cookie.includes(`qr_seed=${token}`)) return send({ message: 'QR session cookie missing' }, 401)
      return send({ status: this.qrExpired ? 50004002 : this.qrPending ? 50004001 : 2000000, message: 'ok', data: { members: { service_ticket: token } } })
    }
    if (path === '/account/info' && url.searchParams.has('st')) {
      const account = this.tokens.get(url.searchParams.get('st')!)
      if (!account) return send({ message: 'invalid ticket' }, 401)
      if (this.loginRedirect) {
        res.writeHead(302, { Location: `/account/complete?ticket=${url.searchParams.get('st')}`, 'Set-Cookie': 'login_step=confirmed; Secure; HttpOnly; Path=/; SameSite=None' }).end()
        return true
      }
      const session = randomUUID()
      this.sessions.set(session, account)
      res.setHeader('Set-Cookie', `__puus=${session}; Secure; HttpOnly; Path=/; SameSite=None`)
      return ok({ nickname: account })
    }
    if (path === '/account/complete') {
      const account = this.tokens.get(url.searchParams.get('ticket')!)
      if (!account || !cookie.includes('login_step=confirmed')) return send({ message: 'Redirect cookie missing' }, 401)
      const session = randomUUID()
      this.sessions.set(session, account)
      res.setHeader('Set-Cookie', `__puus=${session}; Secure; HttpOnly; Path=/; SameSite=None`)
      return ok({ nickname: account })
    }
    if (path.startsWith('//objects/')) {
      const task = url.searchParams.get('uploadId')!
      const upload = this.uploads.get(task)
      if (!upload || req.headers.authorization !== 'fixture-oss' || !req.headers['x-oss-date'] || cookie.includes('__puus=')) return send({ message: 'Invalid signed upload headers' }, 403)
      if (this.failUpload) return send({ message: 'fixture upload failed' }, 503)
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      if (req.method === 'PUT') {
        if (createHash('md5').update(body).digest('hex') !== upload.md5 || createHash('sha1').update(body).digest('hex') !== upload.sha1) return send({ message: 'Upload content hash mismatch' }, 400)
        upload.body = body.toString('utf8')
        res.setHeader('ETag', '"fixture-part"')
        res.writeHead(200).end(); return true
      }
      if (req.headers['content-md5'] !== createHash('md5').update(body).digest('base64')) return send({ message: 'Multipart MD5 mismatch' }, 400)
      upload.committed = true
      res.writeHead(200).end(); return true
    }
    const session = /(?:^|;\s*)__puus=([^;]+)/.exec(cookie)?.[1]
    const account = session && this.sessions.get(session)
    if (!account || this.expired) return send({ message: 'fixture session expired' }, 401)
    if (path === '/account/info') {
      // Exercise Cookie rotation rather than a constant synthetic credential.
      this.sessions.delete(session)
      const rotated = randomUUID()
      this.sessions.set(rotated, account)
      res.setHeader('Set-Cookie', `__puus=${rotated}; Secure; HttpOnly; Path=/; SameSite=None`)
      return ok({ nickname: account })
    }
    if (path.startsWith('/quark-content/')) {
      const file = this.files.get(path.slice('/quark-content/'.length))
      if (!file || file.account !== account) return send({}, 404)
      res.writeHead(200, { 'content-type': 'application/json' }).end(this.downloadsCorrupt ? '{broken' : file.body)
      return true
    }
    let body: Record<string, any> = {}
    if (req.method === 'POST') { let text = ''; for await (const chunk of req) text += chunk; body = text ? JSON.parse(text) : {} }
    if (path.endsWith('/file/sort')) {
      const list = [...this.files.values()].filter(file => file.account === account && file.parent === url.searchParams.get('pdir_fid') && !this.hiddenVersions.has(file.fid)).map(file => ({ fid: file.fid, file_name: file.name, pdir_fid: file.parent, dir: file.directory, size: Buffer.byteLength(file.body) }))
      const page = Number(url.searchParams.get('_page') ?? 1), size = Number(url.searchParams.get('_size') ?? 200)
      return ok({ list: list.slice((page - 1) * size, page * size) })
    }
    if (path === '/1/clouddrive/file') {
      const fid = `folder-${account}`
      this.files.set(fid, { fid, name: body.file_name, parent: body.pdir_fid, directory: true, body: '', account })
      return ok({ fid, finish: true })
    }
    if (path.endsWith('/upload/pre')) {
      if (this.parallelUploads) await new Promise<void>(done => {
        this.waitingUploads.push(done)
        if (this.waitingUploads.length >= this.parallelUploads) {
          this.parallelUploads = 0
          for (const release of this.waitingUploads.splice(0)) release()
        }
      })
      const task = randomUUID(), fid = randomUUID()
      this.uploads.set(task, { fid, name: body.file_name, parent: body.pdir_fid, account })
      return send({ status: 200, data: { task_id: task, fid, bucket: 'fixture', auth_info: 'fixture-auth', upload_url: `localhost:${new URL(origin).port}`, upload_id: task, obj_key: `objects/${task}` }, metadata: { part_size: 10_000_000 } })
    }
    if (path.endsWith('/update/hash')) {
      const upload = this.uploads.get(body.task_id)!
      upload.md5 = body.md5; upload.sha1 = body.sha1
      return ok({ finish: false })
    }
    if (path.endsWith('/upload/auth')) return ok({ auth_key: 'fixture-oss' })
    if (path.endsWith('/upload/finish')) {
      const upload = this.uploads.get(body.task_id)!
      if (!upload.committed || !upload.body) return send({ message: 'Upload not committed' }, 400)
      this.files.set(upload.fid, { fid: upload.fid, parent: upload.parent, name: upload.name, directory: false, body: upload.body, account })
      return ok()
    }
    if (path.endsWith('/file/download')) {
      const fid = body.fids?.[0]
      return ok([{ download_url: `${origin}/quark-content/${fid}` }])
    }
    if (path.endsWith('/file/delete')) { this.deleted++; return send({ message: 'Snapshot deletion must not be used' }, 405) }
    return send({ message: `Unexpected fixture route: ${path}` }, 400)
  }
}
