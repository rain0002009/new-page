import { generate } from 'selfsigned'

let cached: { cert: string; private: string } | null = null

export async function getTestCertificate(): Promise<{ cert: string; private: string }> {
  if (!cached) {
    cached = await generate([{ name: 'commonName', value: 'localhost' }], {
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }],
    })
  }
  return cached
}
