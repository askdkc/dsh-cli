/** Local wire fixture for the installed profile's PTY acceptance test. */
import { appendFileSync } from 'node:fs'
const record = event => appendFileSync(process.env.DSH_AUTH_PROFILE_EVENTS, JSON.stringify(event) + '\n')
const encoder = new TextEncoder()
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  if (url === 'https://opencode.ai/zen/v1/models' || url === 'https://opencode.ai/go/v1/models') return Response.json({ data: [{
    id: 'fixture-profile', name: 'Profile fixture', type: 'chat',
    api: { 'chat-completions': { sdk: { aisdk: '@ai-sdk/openai-compatible' } } },
    limit: { context: 100000, output: 1000 }, modalities: { input: ['text'], output: ['text'] },
    capabilities: { tools: { supported: true }, reasoning: { supported: false } },
  }] })
  if (!url.startsWith('https://opencode.ai/zen/v1/chat/completions')) throw new Error('Unexpected fixture request')
  const body = JSON.parse(init.body)
  const user = JSON.stringify(body.messages.findLast(message => message.role === 'user')?.content)
  // The host also asks this provider to name the session. Keep that auxiliary
  // request visible, but separate it from retries of the user's generation.
  const phase = user.includes('Generate the session title from this JSON array of human messages:') ? 'title' : user.includes('profile-cancel') ? 'cancel' : user.includes('profile-next') ? 'next' : 'first'
  record({ type: 'request', phase })
  const text = phase === 'title' ? 'Fixture session' : phase === 'cancel' ? 'PROFILE_WAITING' : phase === 'next' ? 'PROFILE_NEXT_OK' : 'PROFILE_FIRST_OK'
  const event = (content, finish_reason) => encoder.encode('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content }, finish_reason }] }) + '\n\n')
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(event(text, phase === 'cancel' ? null : 'stop'))
      if (phase !== 'cancel') { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); return }
      init.signal.addEventListener('abort', () => { record({ type: 'abort', phase }); try { controller.close() } catch {} }, { once: true })
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}
