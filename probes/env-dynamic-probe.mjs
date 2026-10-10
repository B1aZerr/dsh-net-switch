// Does Node's built-in fetch honour NODE_USE_ENV_PROXY / HTTPS_PROXY set *after* startup?
const PROXY = 'http://127.0.0.1:7897'

async function probe(label) {
  try {
    const r = await fetch('https://www.google.com/generate_204', { signal: AbortSignal.timeout(8000) })
    console.log(`${label}: OK ${r.status}`)
  } catch (e) {
    console.log(`${label}: ERR ${e.message}`)
  }
}

// A) env set before the first fetch
process.env.NODE_USE_ENV_PROXY = '1'
process.env.HTTPS_PROXY = PROXY
process.env.HTTP_PROXY = PROXY
await probe('A set-before-first-fetch')

// B) clear, force a direct attempt, then set env again and retry
delete process.env.NODE_USE_ENV_PROXY
delete process.env.HTTPS_PROXY
delete process.env.HTTP_PROXY
await probe('B cleared (expect failure)')

process.env.NODE_USE_ENV_PROXY = '1'
process.env.HTTPS_PROXY = PROXY
process.env.HTTP_PROXY = PROXY
await probe('C set-after-a-fetch (dynamic?)')
