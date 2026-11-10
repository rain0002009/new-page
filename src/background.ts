import { handle, resume } from './core/workspace'
import type { Request } from './core/protocol'

void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
void chrome.alarms.create('new-page-sync', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'new-page-sync') void resume() })
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || message?.type === 'changed') return false
  void handle(message as Request).then(respond, error => respond({ ok: false, error: error instanceof Error ? error.message : '操作失败，请重试' }))
  return true
})
void resume()
