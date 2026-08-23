import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionEventBus } from '../src/eventBus.js'
import { MockTelegramAdapter } from '../src/mockAdapter.js'
import type { TdlibEvent } from '../src/types.js'

test('TG-CHAT-DEL-1.3 removes a mock chat, its history, and publishes the new list', async () => {
  const bus = new SessionEventBus()
  const adapter = new MockTelegramAdapter(bus)
  const events: TdlibEvent[] = []

  await adapter.createSession('session-1')
  const unsubscribe = adapter.subscribe('session-1', event => events.push(event))

  assert.deepEqual((await adapter.listChats('session-1')).map(chat => chat.id), [1])

  await adapter.deleteChat('session-1', 1)

  assert.deepEqual(await adapter.listChats('session-1'), [])
  await assert.rejects(adapter.getChatHistory('session-1', 1, 20), /Unknown chat/)
  assert.deepEqual(
    events.filter(event => event.type === 'chats_updated').at(-1)?.payload,
    { chats: [] }
  )

  unsubscribe()
})
