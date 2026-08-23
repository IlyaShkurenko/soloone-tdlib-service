import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionEventBus } from '../src/eventBus.js'
import { MockTelegramAdapter } from '../src/mockAdapter.js'

// Contract: TG-PROFILE-AVATAR-1.1, TG-PROFILE-AVATAR-1.4
test('Given a ready mock session, when a JPEG is supplied, then its profile photo is replaced', async () => {
  const adapter = new MockTelegramAdapter(new SessionEventBus())
  await adapter.createSession('session-1')
  await adapter.submitCode('session-1', '12345')

  await adapter.setProfilePhoto('session-1', Buffer.from('jpeg-bytes'))

  assert.equal(adapter.hasProfilePhoto('session-1'), true)
})

// Contract: TG-PROFILE-AVATAR-1.3, TG-PROFILE-AVATAR-1.4
test('Given a profile photo, when it is removed twice, then removal is idempotent', async () => {
  const adapter = new MockTelegramAdapter(new SessionEventBus())
  await adapter.createSession('session-1')
  await adapter.submitCode('session-1', '12345')
  await adapter.setProfilePhoto('session-1', Buffer.from('jpeg-bytes'))

  await adapter.deleteProfilePhoto('session-1')
  await adapter.deleteProfilePhoto('session-1')

  assert.equal(adapter.hasProfilePhoto('session-1'), false)
})
